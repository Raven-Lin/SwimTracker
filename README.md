# SwimTracker

Squad analytics for swim coaches. Built to handle a **150-swimmer squad**
without falling over, and to show the charts coaches actually use rather than
the ones that are easy to draw.

**There is no server and nothing to install.** The dashboard is a single
static page. Open `index.html` and it works — from a hard drive, a USB stick,
or a GitHub Pages link. Your squad's data never leaves the machine it is on.

---

## Getting started

### Option 1 — put it on the web (recommended, and free)

You do not need a server or hosting account. GitHub Pages serves static files
for free from this repository:

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under *Build and deployment*, set **Source** to **GitHub Actions**.

That is it. Every push to `main` runs the tests and republishes the dashboard
at `https://<your-username>.github.io/<repository-name>/`. Send that link to
anyone — they open it in a browser and start working. No install, no login.

### Option 2 — just open the file

Download the repository as a ZIP, unzip it, and double-click `index.html`.
Everything works — charts, the sample data button, and saved results — with
no internet connection and nothing installed.

(Browsers block `fetch()` from a page opened off disk, so the demo dataset
also ships as `assets/sample-squad.js`, which loads as an ordinary script.
Regenerate it with `node tools/make-sample-js.mjs` if you change the CSV.)

### Loading your results

Drop a CSV onto the **Data** tab, or click *Choose CSV file*. You can drop
several at once. Re-importing a file you have already loaded is safe — repeat
races are ignored rather than duplicated.

The CSV needs at minimum a `name` and a `time` column. The full set it
understands:

| Column | Example | Notes |
|---|---|---|
| `name` | `Joanne Lou` | required |
| `time` | `1:18.14` or `29.30` | required |
| `gender` | `F` / `Female` / `M` | needed for points scoring |
| `club` | `Artemis Aquatics` | |
| `course` | `LC` or `SC` | long or short course |
| `distance` | `100M` or `100` | |
| `stroke` | `Freestyle`, `Free`, `IM`… | long or short names both work |
| `race_date` | `2026-04-17` or `17-04-2026` | |
| `age_grp` | `16y/o` or `16` | |
| `race_name` | `2026 State Age Championships` | the meet |

Anything the app cannot use is skipped and reported, rather than breaking the
page. Your data is saved in the browser so it is still there next time — and
you can export it back to CSV at any point as a backup.

---

## What the charts show, and why these ones

Coaches consistently rely on a small number of views. These are those views.

### Times lead. Points are a tool, not the subject

Coaches work in seconds, and so does this app: best-time boards, PB
progression, "how far off your best are you", event rankings. If a question
can be answered in seconds, it is.

Points are kept for the one job seconds genuinely cannot do. Across 150
swimmers of different ages, genders and events, **seconds are not
comparable** — a 12-year-old's 50 Free and a 17-year-old's 400 IM cannot go
on the same axis and mean anything. World Aquatics points (still widely
called FINA points) fix that by scoring every swim against the world record
for its gender, course and event:

```
points = 1000 × (world record ÷ your time)³
```

The base time scores 1000, so every swim lands on one 0–1000 scale and a
50-point gain in the 400 IM is comparable to a 50-point gain in the 50 Free.

That is used in exactly three places, and nowhere else:

- **Event portfolio** — ranking one swimmer's own events against each other,
  to see what they are actually best at. A 1:18 breaststroke can be a better
  swim than a 1:00 freestyle; only points can tell you that.
- **Squad standard and the improvement leaderboard** — squad-wide questions
  that have no common time.
- **Colour on the coverage grid** — so strength is comparable across
  columns. The cells themselves show times.

An earlier version of this app used points almost everywhere, including for
"how far off your best are you". That put an abstraction between the coach
and the thing they work in, and it was wrong.

Base times live in one editable table in [`src/points.js`](src/points.js).
World records move; update a number there and every chart re-scores itself.
Within a single event, changing a base time rescales everyone by the same
factor, so rankings inside an event never shift.

### The views

| Tab | What it answers |
|---|---|
| **Squad** | What standard is my squad at, and who is moving? A points histogram shows the squad's shape; a leaderboard ranks the biggest points gains this season; a sortable table covers every swimmer. |
| **Swimmer** | How is this one swimmer tracking? PB progression, current form, event portfolio and race consistency. |
| **Events** | Who is fastest in this event, and how do a few swimmers compare across seasons? |
| **Coverage** | A best-times board: every swimmer's PB in every event, colour-coded by strength. Doubles as the answer to "who has never raced what?" — the *empty* cells are half the value. |
| **Results** | Every race, filtered and sorted however you like. |

### Design decisions worth knowing about

**Progression is plotted against the actual meet date, with the PB as a
stepped line.** The previous version binned every swim into a calendar year,
which hides tapers, mid-season plateaus and which meet a swim came from. A
stepped PB line is also the honest shape — a PB holds flat until it is broken.
A smooth curve through every swim implies improvement between races that never
happened.

**Season best vs personal best is its own chart, measured in seconds.** This
is the diagnostic coaches use most: a season best closing in on the PB means a
swimmer is coming into form; a wide gap means they are still climbing back.
The unit is seconds off the PB, because that is what a coach says out loud —
and because "1.2 seconds off" and "3.5 seconds off" compare honestly across
events whose raw times never could.

**Time axes are reversed so faster is up (or further right).** Coaches read
"up" as "better", and an un-reversed time axis gets misread at a glance.

**Event rankings by time are a dot plot, not bars.** A 100m field might span
55–75 seconds. Bars from zero squash every real difference into the last 20%
of the bar; bars from a non-zero baseline are worse, because the *slowest*
swimmer ends up with the longest bar. A dot plot has no baseline to get wrong.
Ranking by points switches back to bars, because points have a true zero and
bar length means something.

**No chart ever draws 150 lines.** Line charts are capped at 8 deliberately
chosen swimmers. Everything squad-wide is a bar, a histogram or a heatmap —
forms that stay readable at scale.

---

## Fetching results from Swimming Australia

Reading results and collecting them are separate jobs, so they are separate
tools. The dashboard needs nothing installed. The fetcher is a command-line
script you run occasionally:

```bash
pip install playwright beautifulsoup4 lxml
python -m playwright install chromium

# one swimmer
python scraper/fetch_results.py "Joanne Lou" --gender F

# a whole squad from a file of "Name, Gender" lines
python scraper/fetch_results.py --from-file squad.txt -o squad_results.csv
```

It writes a CSV. Drop that CSV onto the dashboard. Re-running it merges into
the existing file rather than duplicating rows.

---

## Development

```bash
npm install          # Playwright, for the browser tests
npm run fixture      # generate a 150-swimmer test dataset
npm test             # data tests + scraper tests + browser tests
npm run serve        # optional dev server on :8080
```

| Path | |
|---|---|
| `index.html` | the whole app shell |
| `src/points.js` | World Aquatics points and the base-time table |
| `src/data.js` | CSV parsing, normalisation, and the indexes every view reads |
| `src/charts.js` | chart builders |
| `src/ui.js` | escaping, the virtualised table, colour |
| `src/store.js` | IndexedDB / localStorage persistence |
| `src/app.js` | wiring |
| `scraper/fetch_results.py` | the results fetcher |
| `assets/sample-squad.{csv,js}` | demo dataset (the `.js` is generated from the `.csv`) |

Plain `<script>` tags, no build step, no bundler — which is what lets
`index.html` work straight from disk.

---

## What changed from version 1, and why

### Crashes and correctness

- **`ReferenceError` on every scrape.** The scrape handler referenced an
  undefined `evtSource` variable, throwing the moment a scrape started.
- **`Math.min(...array)` on unbounded arrays** throws
  `RangeError: Maximum call stack size exceeded` past roughly 65,000 elements.
  Minimums are now accumulated in loops.
- **`innerHTML +=` per table row** re-parses the entire table on every
  iteration — quadratic work. With a 150-swimmer squad this froze and then
  killed the Results tab. Tables are now virtualised: only the ~40 visible
  rows exist in the DOM regardless of dataset size.
- **Charts re-scanned all data inside nested loops.** Everything is indexed in
  a single pass at load time; views read Maps rather than re-filtering.
- **Re-scraping duplicated every race.** Imports are now deduplicated by swim
  identity, so re-importing is a no-op.
- **The gender filter never matched.** Gender was keyed on the name the coach
  *typed*, while the CSV stored the name the website *returned*. Gender is now
  part of the data, with a UI to fill in anything missing.
- **The CSV parser** broke on escaped quotes, newlines inside quoted fields,
  CRLF line endings, and the UTF-8 BOM Excel writes (which turned the `name`
  header into `﻿name`, so every name lookup silently returned nothing).
- **Ties marked several swims as the PB at once**, inflating the "PBs
  recorded" count. One swim per event now holds the PB.
- **Swimmer names were interpolated straight into HTML**, including into an
  inline `onclick` handler — so an ordinary name like O'Brien broke the
  handler, and a name containing markup was a real injection risk. Everything
  is escaped now, and there is a test that proves it.
- **A duplicate Gender filter** appeared twice in the results toolbar.
- **A failed scrape left the progress bar stuck** at the same count forever,
  and an exception in the scrape thread left the HTTP stream open indefinitely.

### Interface

- Denser layout — the old spacing fit about four swimmers on screen.
- Tabular numerals, so times and points do not jitter between rows.
- Real empty states: a chart with nothing to draw says *why*, instead of
  showing a blank rectangle that could equally mean "broken".
- Keyboard support and visible focus rings throughout; the old build used
  `div`s with click handlers, which cannot be reached by keyboard at all.
- The 150-row toggle sidebar is gone, replaced by search, filters and a
  deliberate 8-swimmer comparison picker.
- Sub-minute times render as `29.30`, not `0:29.30`.

### Architecture

- **No server.** The Flask + server-sent-events backend is gone; the dashboard
  is static.
- **No installer.** The Electron wrapper existed only to host that server. CI
  now publishes to GitHub Pages instead of building a Windows `.exe`.
- **Chart.js is vendored** into the repository rather than loaded from a CDN,
  so charts work offline and behind a school content filter.

### Tests

100 tests: 42 on the data and points engines, 18 on the scraper, and 40
end-to-end tests driving a real browser against a real 150-swimmer dataset —
checking import time, chart rendering, table virtualisation, sorting,
filtering, escaping, persistence across a reload, that the app works from a
`file://` URL, and that the console stays clean throughout.

---

## Sources

Chart and metric choices follow coaching practice as described in:

- [World Aquatics — Swimming Points](https://www.worldaquatics.com/swimming/points)
- [FINA (World Aquatics) Points Explained — Swim Community](https://community.swimstandards.com/topic/284/fina-world-aquatics-points-explained)
- [Season Best vs Personal Best: What Counts](https://blog.gophin.app/blog/season-best-vs-personal-best-what-counts)
- [Swimming coaches' perceptions and practices on periodization, performance monitoring, and training management — Frontiers in Sports and Active Living](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1642020/full)
- [SwimStats — coaching software for results, rankings and planning](https://swimstats.de/)
