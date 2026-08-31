#!/usr/bin/env python3
"""
SwimTracker — results fetcher
=============================

Collects a swimmer's official results from the Swimming Australia results
portal and writes them to a CSV that you then import into the dashboard.

WHY THIS IS A COMMAND-LINE TOOL AND NOT A SERVER
------------------------------------------------
The previous version ran a Flask server with a streaming progress endpoint,
and the dashboard talked to it over HTTP. That meant every coach who wanted
to *look* at results had to install Python, Flask and Playwright and keep a
terminal open — for a task that is pure reading.

Scraping and reading are now separate jobs:

  * Reading results is the common case, done by many people, often on a
    laptop with no dev tools. That is the dashboard: a static page, no
    server, no install.
  * Fetching results is the rare case, done once in a while by one person.
    That is this script. It writes a CSV. You import that CSV.

Splitting them removed the server, the installer, and a whole category of
bugs (a hung stream when a scrape failed, a progress bar that stalled
forever on an error, and duplicated rows every time you re-ran a swimmer).

USAGE
-----
    pip install playwright beautifulsoup4 lxml
    python -m playwright install chromium

    # one swimmer
    python scraper/fetch_results.py "Joanne Lou" --gender F

    # a whole squad from a text file (one "Name,Gender" per line)
    python scraper/fetch_results.py --from-file squad.txt -o squad_results.csv

    # include pre-2022 archived records (slower)
    python scraper/fetch_results.py "Joanne Lou" --gender F --archived

Then open the dashboard and drop the CSV onto it.

NOTE ON GENDER
--------------
The portal does not publish a swimmer's gender, but World Aquatics points
cannot be calculated without it — the score is relative to the world record
for that gender. Pass --gender, or use --from-file with a gender column, and
the CSV comes out ready to score. If you skip it the results still import
fine; the dashboard will ask you to fill the gender in.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Iterator

PORTAL_URL = "https://results.swimming.org.au/portal/"

# One result row, as printed in the portal's results table. The portal writes
# these as a single run-on string, e.g.
#   "LC 2026 Australian Age Championships Approved 17-04-2026 16y/o 100M L Breaststroke 1:18.14 Verified"
RESULT_PATTERN = re.compile(
    r"""
    ^(?P<course>LC|SC)\s+
    (?P<race_name>.+?)\s+
    (?:Approved\s+)?
    (?P<race_date>\d{2}-\d{2}-\d{4})\s+
    (?P<age_grp>\d{1,2}y/o)\s+
    (?P<distance>\d{2,4}M)\s+
    (?P<course_type>[LS])\s+
    (?P<stroke>Butterfly|Backstroke|Breaststroke|Freestyle|Medley)\s+
    (?P<time>(?:\d+:)?\d{2}\.\d{2})
    (?:\s+Verified)?
    $
    """,
    re.VERBOSE,
)

CSV_COLUMNS = [
    "name", "gender", "club", "course", "distance", "stroke",
    "time", "race_date", "age_grp", "race_name",
]


@dataclass(frozen=True)
class Result:
    name: str
    gender: str
    club: str
    course: str
    distance: str
    stroke: str
    time: str
    race_date: str
    age_grp: str
    race_name: str

    def key(self) -> tuple:
        """Identity of a swim. Re-running a swimmer must not append a second
        copy of races already in the file, which is what the old version did
        on every single run."""
        return (self.name, self.course, self.distance, self.stroke,
                self.race_date, self.time)


# ============================================================================
# PURE HELPERS  (no network — these are what the tests exercise)
# ============================================================================

def parse_result_row(text: str) -> dict | None:
    """Parse one results-table row. Returns None if it is not a result row
    (headers, footers and pagination controls all land here too)."""
    match = RESULT_PATTERN.search(text.strip())
    return match.groupdict() if match else None


def normalise_date(ddmmyyyy: str) -> str:
    """'17-04-2026' -> '2026-04-17'.

    ISO order sorts correctly as plain text, which matters because the CSV is
    read by a browser with no date library. Returns the input unchanged if it
    is not the expected shape, so one odd row cannot abort a whole scrape.
    """
    m = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", ddmmyyyy.strip())
    if not m:
        return ddmmyyyy
    day, month, year = m.groups()
    return f"{year}-{month}-{day}"


def normalise_time(value: str) -> str:
    """Leave '1:18.14' alone; leave '29.30' alone.

    The old code turned '29.30' into '0:29.30'. Coaches write a sub-minute
    swim without a minutes component, and the dashboard formats it that way
    too, so storing the padded form just created a mismatch.
    """
    return value.strip()


def parse_roster_line(line: str) -> tuple[str, str] | None:
    """'Joanne Lou, F' -> ('Joanne Lou', 'F'). Blank lines and #comments -> None."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if "," in line:
        name, _, gender = line.partition(",")
        return name.strip(), normalise_gender(gender)
    return line, ""


def normalise_gender(value: str) -> str:
    v = value.strip().lower()
    if v in {"f", "female", "girl", "girls", "w", "women"}:
        return "F"
    if v in {"m", "male", "boy", "boys", "men"}:
        return "M"
    return ""


def read_existing(path: Path) -> list[Result]:
    """Load rows already in the output file so a re-run merges instead of
    duplicating."""
    if not path.exists() or path.stat().st_size == 0:
        return []
    out: list[Result] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                out.append(Result(**{c: (row.get(c) or "") for c in CSV_COLUMNS}))
            except TypeError:
                continue  # a row from an older, differently-shaped file
    return out


def merge(existing: Iterable[Result], incoming: Iterable[Result]) -> list[Result]:
    """Union by swim identity, preserving the order results were first seen."""
    seen: set[tuple] = set()
    merged: list[Result] = []
    for r in list(existing) + list(incoming):
        k = r.key()
        if k in seen:
            continue
        seen.add(k)
        merged.append(r)
    return merged


def write_csv(path: Path, rows: Iterable[Result]) -> int:
    """Write atomically via a temp file, so an interrupted run cannot leave a
    half-written CSV where a complete one used to be."""
    rows = list(rows)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow(asdict(r))
    tmp.replace(path)
    return len(rows)


# ============================================================================
# SCRAPING
# ============================================================================

def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


async def scrape_one(page, name: str, gender: str, archived: bool) -> list[Result]:
    """Fetch every result for one swimmer.

    Raises on failure. The caller isolates each swimmer so that one bad name
    does not abandon the rest of the squad — the old version reported the
    error but then left the progress bar stuck at the same count forever.
    """
    results: list[Result] = []

    log(f"  opening portal for {name}")
    await page.goto(PORTAL_URL, wait_until="domcontentloaded")
    await page.wait_for_selector("input#places_input", timeout=20_000)

    if archived:
        try:
            toggle = page.locator("mat-slide-toggle input.mat-slide-toggle-input")
            await toggle.wait_for(state="attached", timeout=5_000)
            if not await toggle.is_checked():
                await toggle.check(force=True)
                await page.wait_for_timeout(400)
        except Exception:
            log("  (could not enable archived records — continuing without)")

    log(f"  searching for {name}")
    await page.click("input#places_input")
    await page.fill("input#places_input", name)
    await page.wait_for_timeout(400)
    await page.keyboard.press("Space")

    await page.wait_for_selector(".cdk-overlay-pane mat-option", timeout=15_000)
    options = page.locator(".cdk-overlay-pane mat-option:not([aria-disabled='true'])")
    await options.first.wait_for(state="visible", timeout=15_000)
    await options.first.click()
    await page.wait_for_timeout(1_200)

    next_btn = page.locator("button:has(mat-icon:has-text('chevron_right'))")
    await next_btn.wait_for(state="visible", timeout=15_000)

    from bs4 import BeautifulSoup  # imported here so --help works without it

    soup = BeautifulSoup(await page.content(), "lxml")
    card = soup.select_one("div.card.p-0")
    if card is None:
        raise RuntimeError("results card not found — the page layout may have changed")

    name_node = card.select_one("div.font-weight-medium")
    club_node = card.select_one("div.small")
    found_name = name_node.get_text(strip=True) if name_node else name
    found_club = club_node.get_text(strip=True) if club_node else ""
    log(f"  found {found_name} ({found_club})")

    page_num = 1
    seen_pages = 0
    while True:
        log(f"  reading page {page_num}")
        soup = BeautifulSoup(await page.content(), "lxml")
        card = soup.select_one("div.card.p-0")
        if card is None:
            break

        body = card.find("div", class_=["card-body"])
        table = body.find("table", class_=["selector-table"]) if body else None
        rows = table.find_all("tr") if table else []

        for row in rows:
            parsed = parse_result_row(row.get_text(" ", strip=True))
            if not parsed:
                continue
            results.append(Result(
                name=found_name,
                gender=gender,
                club=found_club,
                course=parsed["course"],
                distance=parsed["distance"],
                stroke=parsed["stroke"],
                time=normalise_time(parsed["time"]),
                race_date=normalise_date(parsed["race_date"]),
                age_grp=parsed["age_grp"],
                race_name=parsed["race_name"].strip(),
            ))

        if await next_btn.is_disabled():
            break

        # A hard ceiling on pagination. Without one, a portal change that
        # leaves "next" permanently enabled turns this into an infinite loop
        # that fills the disk.
        seen_pages += 1
        if seen_pages > 200:
            log("  stopping: more than 200 result pages, which is not plausible")
            break

        await next_btn.click()
        await page.wait_for_timeout(1_200)
        page_num += 1

    return results


async def scrape_all(roster: list[tuple[str, str]], archived: bool,
                     headed: bool, retries: int) -> tuple[list[Result], list[str]]:
    """Scrape a whole squad through ONE browser instance.

    The old version launched and tore down a full Chromium for every single
    swimmer. At 150 swimmers that is 150 cold starts — minutes of pure
    overhead before any page loads.
    """
    from playwright.async_api import async_playwright

    collected: list[Result] = []
    failed: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed)
        context = await browser.new_context(viewport={"width": 1600, "height": 1000})
        page = await context.new_page()
        try:
            for i, (name, gender) in enumerate(roster, start=1):
                log(f"[{i}/{len(roster)}] {name}")
                for attempt in range(1, retries + 1):
                    try:
                        rows = await scrape_one(page, name, gender, archived)
                        collected.extend(rows)
                        log(f"  {len(rows)} results")
                        break
                    except Exception as exc:                    # noqa: BLE001
                        if attempt < retries:
                            log(f"  attempt {attempt} failed ({exc}); retrying")
                            await page.wait_for_timeout(2_000)
                        else:
                            log(f"  giving up on {name}: {exc}")
                            failed.append(name)
        finally:
            await context.close()
            await browser.close()

    return collected, failed


# ============================================================================
# CLI
# ============================================================================

def build_roster(args) -> list[tuple[str, str]]:
    roster: list[tuple[str, str]] = []
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            raise SystemExit(f"No such file: {path}")
        for line in path.read_text(encoding="utf-8").splitlines():
            entry = parse_roster_line(line)
            if entry:
                roster.append(entry)
    for name in args.names:
        roster.append((name, normalise_gender(args.gender or "")))
    if not roster:
        raise SystemExit("Give at least one swimmer name, or use --from-file.")
    return roster


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch Swimming Australia results into a CSV for the SwimTracker dashboard.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Import the CSV by dropping it onto the dashboard page.",
    )
    parser.add_argument("names", nargs="*", help="swimmer names as they appear on the portal")
    parser.add_argument("--from-file", help='text file of "Name, Gender" lines (one per swimmer)')
    parser.add_argument("--gender", help="F or M, applied to names given on the command line")
    parser.add_argument("-o", "--output", default="swimmer_results.csv", help="output CSV path")
    parser.add_argument("--archived", action="store_true", help="include records before 2022 (slower)")
    parser.add_argument("--headed", action="store_true", help="show the browser window (for debugging)")
    parser.add_argument("--retries", type=int, default=2, help="attempts per swimmer (default 2)")
    args = parser.parse_args(argv)

    roster = build_roster(args)
    out_path = Path(args.output)

    log(f"Fetching {len(roster)} swimmer(s) into {out_path}")
    if any(not g for _, g in roster):
        log("Note: some swimmers have no gender set. They will import fine, but the")
        log("      dashboard cannot score them in points until you set it there.")

    collected, failed = asyncio.run(
        scrape_all(roster, args.archived, args.headed, max(1, args.retries))
    )

    merged = merge(read_existing(out_path), collected)
    total = write_csv(out_path, merged)

    log("")
    log(f"Wrote {total} results to {out_path} ({len(collected)} fetched this run).")
    if failed:
        log(f"Could not fetch: {', '.join(failed)}")
        log("Check the spelling against the portal, then re-run just those names.")
    log("Now open the dashboard and drop this CSV onto it.")

    # A non-zero exit only when nothing at all worked, so a squad scrape with
    # one bad name still counts as a success for any script wrapping this.
    return 1 if failed and not collected else 0


if __name__ == "__main__":
    raise SystemExit(main())
