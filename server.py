#!/usr/bin/env python3
"""
SwimTracker — Local Server
==========================
This script runs a small local web server that:
  1. Serves the swim_coach_dashboard.html file
  2. Accepts scrape requests from the browser
  3. Runs the Playwright scraper and streams progress back in real-time

HOW TO START:
    Open Terminal and run:
        python server.py

Then open your browser and go to:
    http://localhost:8080

INSTALL REQUIREMENTS (run once in Terminal):
    pip install flask flask-cors playwright beautifulsoup4 lxml pandas
    python -m playwright install
"""

import re
import json
import asyncio
import threading
import pandas as pd
from pathlib import Path
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS
from playwright.async_api import async_playwright
import nest_asyncio

nest_asyncio.apply()

# ==============================================================================
# SETTINGS
# ==============================================================================

# Where to save the scraped CSV (same folder as this script by default)
OUTPUT_CSV = str(Path(__file__).parent / "swimmer_results.csv")

# Port the server runs on
PORT = 8080

# ==============================================================================
# FLASK APP
# ==============================================================================

app = Flask(__name__, static_folder=".")
CORS(app)

# ==============================================================================
# REGEX PATTERN (same as scraper)
# ==============================================================================

pattern = re.compile(
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
    re.VERBOSE
)

BROWSER_ARGS = ["--window-size=1980,1080"]
VIEWPORT     = {"width": 1980, "height": 1080}

# ==============================================================================
# SCRAPER (async)
# ==============================================================================

async def scrape_swimmer(name, include_archived, progress_cb):
    """
    Scrapes one swimmer. Calls progress_cb(message) to report progress.
    Returns dict with name, club, results list.
    """
    result = {"name": name, "club": "", "results": []}

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=False,           # Headless — no visible browser window needed
                args=BROWSER_ARGS,
                slow_mo=50
            )
            context = await browser.new_context(viewport=VIEWPORT)
            page    = await context.new_page()

            progress_cb(f"Opening website for {name}...")
            await page.goto(
                "https://results.swimming.org.au/portal/",
                wait_until="domcontentloaded"
            )
            await page.wait_for_timeout(3000)

            await page.wait_for_selector("input#places_input", timeout=15_000)

            if include_archived:
                try:
                    toggle = page.locator("mat-slide-toggle input.mat-slide-toggle-input")
                    await toggle.wait_for(state="attached", timeout=5000)
                    if not await toggle.is_checked():
                        await toggle.check(force=True)
                        await page.wait_for_timeout(500)
                except:
                    pass

            progress_cb(f"Searching for {name}...")
            await page.click("input#places_input")
            await page.fill("input#places_input", name)
            await page.wait_for_timeout(300)
            await page.keyboard.press("Space")

            await page.wait_for_selector(".cdk-overlay-pane mat-option", timeout=12_000)

            options = page.locator(".cdk-overlay-pane mat-option:not([aria-disabled='true'])")
            await options.first.wait_for(state="visible", timeout=12_000)
            await options.first.click()
            await page.wait_for_timeout(1000)

            await page.wait_for_selector(
                "button:has(mat-icon:has-text('chevron_right'))",
                timeout=12_000
            )
            next_btn = page.locator("button:has(mat-icon:has-text('chevron_right'))")
            await next_btn.wait_for(state="visible", timeout=12_000)

            html        = await page.content()
            soup        = BeautifulSoup(html, "lxml")
            result_card = soup.select_one("div.card.p-0")

            found_name = result_card.select_one("div.font-weight-medium").text.strip()
            found_club = result_card.select_one("div.small").text.strip()
            result["name"] = found_name
            result["club"] = found_club

            progress_cb(f"Found {found_name} ({found_club}). Reading results...")

            page_num = 1
            while True:
                progress_cb(f"Reading page {page_num} for {found_name}...")

                html        = await page.content()
                soup        = BeautifulSoup(html, "lxml")
                result_card = soup.select_one("div.card.p-0")

                rows = (
                    result_card
                    .find("div", class_=["card-body"])
                    .find("table", class_=["selector-table"])
                    .find_all("tr")
                )

                for row in rows:
                    match = pattern.search(row.text.strip())
                    if match:
                        result["results"].append(match.groupdict())

                if await next_btn.is_disabled():
                    break

                await next_btn.click()
                await page.wait_for_timeout(1000)
                page_num += 1

            await browser.close()
            progress_cb(f"Done — {len(result['results'])} results found for {found_name}.")

    except Exception as e:
        progress_cb(f"Could not scrape '{name}': {str(e)}")

    return result


def normalize_time(t):
    if ":" in t:
        return t
    try:
        return f"0:{float(t):05.2f}"
    except ValueError:
        return t
    
def append_swimmer_to_csv(swimmer):
    flat = []
    for r in swimmer["results"]:
        flat.append({"name": swimmer["name"], "club": swimmer["club"], **r})
    if not flat:
        return
    df_new = pd.DataFrame(flat)
    df_new["time"] = df_new["time"].apply(normalize_time)
    df_new["race_date"] = pd.to_datetime(df_new["race_date"], format="%d-%m-%Y")
    df_new["race_date"] = df_new["race_date"].dt.strftime("%Y-%m-%d")
    import os
    if os.path.exists(OUTPUT_CSV) and os.path.getsize(OUTPUT_CSV) > 0:
        df_existing = pd.read_csv(OUTPUT_CSV, encoding="utf-8-sig")
        df_combined = pd.concat([df_existing, df_new], ignore_index=True)
    else:
        df_combined = df_new
    df_combined.to_csv(OUTPUT_CSV, index=False, encoding="utf-8-sig")

# ==============================================================================
# ROUTES
# ==============================================================================

@app.route("/")
def index():
    return send_from_directory(".", "swim_coach_dashboard.html")


@app.route("/scrape-stream", methods=["GET"])
def scrape():
    """
    Accepts query params: names=["Name1", "Name2"]&archived=true/false
    Streams Server-Sent Events back with progress updates and final CSV data.
    """
    import json
    names    = json.loads(request.args.get("names", "[]"))
    archived = request.args.get("archived", "false").lower() == "true"
    
    def generate():
        swimmer_results = []

        # We need a synchronous generator, so run async in a new event loop
        import queue
        msg_queue  = queue.Queue()
        done_event = threading.Event()
        results_holder = []

        def progress_cb(msg):
            msg_queue.put(msg)

        
        async def run_all():
            for name in names:
                r = await scrape_swimmer(name.strip(), archived, progress_cb)
                swimmer_results.append(r)
                append_swimmer_to_csv(r)
            results_holder.append(swimmer_results)
            done_event.set()

        thread = threading.Thread(target=lambda: asyncio.run(run_all()))
        thread.start()
        


        # Stream messages as they arrive
        while not done_event.is_set() or not msg_queue.empty():
            try:
                msg = msg_queue.get(timeout=0.2)
                yield f"data: {json.dumps({'type': 'progress', 'message': msg})}\n\n"
            except:
                pass

        # Build CSV and send final data
       
        if results_holder:
            try:
                df = pd.read_csv(OUTPUT_CSV)
                csv_str = df.to_csv(index=False)
                yield f"data: {json.dumps({'type': 'complete', 'csv': csv_str, 'total': len(df)})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'message': 'No results found for any swimmer.'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


@app.route("/results")
def results():
    """Returns the saved CSV as JSON for the dashboard to load."""
    try:
        df = pd.read_csv(OUTPUT_CSV)
        return jsonify(df.to_dict(orient="records"))
    except FileNotFoundError:
        return jsonify([])


# ==============================================================================
# MAIN
# ==============================================================================

if __name__ == "__main__":
    print("=" * 52)
    print("  SwimTracker Server")
    print("=" * 52)
    print(f"  Starting server...")
    print(f"  Open your browser and go to:")
    print(f"  http://localhost:{PORT}")
    print(f"")
    print(f"  Press Ctrl+C to stop the server.")
    print("=" * 52)
    app.run(port=PORT, debug=False, threaded=True)
