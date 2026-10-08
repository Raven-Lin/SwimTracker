"""Tests for the results fetcher's pure logic.

These deliberately do not touch the network. Everything that can be tested
without the portal — row parsing, date and time handling, roster files, and
the merge that stops re-runs duplicating data — is tested here.

Run with:  python3 -m unittest discover -s tests -p 'test_*.py'
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))

import fetch_results as F  # noqa: E402


class TestRowParsing(unittest.TestCase):
    def test_parses_a_real_result_row(self):
        row = ("LC 2026 Australian Age Championships Approved 17-04-2026 "
               "16y/o 100M L Breaststroke 1:18.14 Verified")
        got = F.parse_result_row(row)
        self.assertIsNotNone(got)
        self.assertEqual(got["course"], "LC")
        self.assertEqual(got["race_name"], "2026 Australian Age Championships")
        self.assertEqual(got["race_date"], "17-04-2026")
        self.assertEqual(got["distance"], "100M")
        self.assertEqual(got["stroke"], "Breaststroke")
        self.assertEqual(got["time"], "1:18.14")

    def test_parses_a_sub_minute_row_without_the_approved_marker(self):
        row = "SC 2025 Winter Short Course 03-08-2025 15y/o 50M S Freestyle 28.91"
        got = F.parse_result_row(row)
        self.assertIsNotNone(got)
        self.assertEqual(got["time"], "28.91")
        self.assertEqual(got["course"], "SC")

    def test_ignores_non_result_rows(self):
        for junk in ["", "Event Date Time", "Showing 1-20 of 43", "Next page",
                     "LC something malformed"]:
            self.assertIsNone(F.parse_result_row(junk), junk)


class TestNormalisation(unittest.TestCase):
    def test_dates_become_sortable_iso(self):
        self.assertEqual(F.normalise_date("17-04-2026"), "2026-04-17")
        self.assertEqual(F.normalise_date("01-01-2020"), "2020-01-01")

    def test_bad_dates_pass_through_rather_than_crashing(self):
        self.assertEqual(F.normalise_date("not a date"), "not a date")

    def test_sub_minute_times_keep_their_natural_form(self):
        # The old code rewrote "29.30" as "0:29.30", which is not how a coach
        # writes it and did not match the dashboard's own formatting.
        self.assertEqual(F.normalise_time("29.30"), "29.30")
        self.assertEqual(F.normalise_time("1:18.14"), "1:18.14")

    def test_gender_spellings(self):
        for v in ["F", "f", "Female", " female ", "girls", "W"]:
            self.assertEqual(F.normalise_gender(v), "F", v)
        for v in ["M", "male", "Boys", "men"]:
            self.assertEqual(F.normalise_gender(v), "M", v)
        for v in ["", "unknown", "x"]:
            self.assertEqual(F.normalise_gender(v), "", v)


class TestRoster(unittest.TestCase):
    def test_name_with_gender(self):
        self.assertEqual(F.parse_roster_line("Joanne Lou, F"), ("Joanne Lou", "F"))

    def test_name_without_gender(self):
        self.assertEqual(F.parse_roster_line("Joanne Lou"), ("Joanne Lou", ""))

    def test_blank_lines_and_comments_are_skipped(self):
        self.assertIsNone(F.parse_roster_line(""))
        self.assertIsNone(F.parse_roster_line("   "))
        self.assertIsNone(F.parse_roster_line("# the sprint squad"))


def make(name="Jo", time="1:00.00", date="2025-03-01", stroke="Freestyle"):
    return F.Result(name=name, gender="F", club="Artemis", course="LC",
                    distance="100M", stroke=stroke, time=time,
                    race_date=date, age_grp="15y/o", race_name="State Champs")


class TestMergeAndWrite(unittest.TestCase):
    def test_merge_drops_exact_repeats(self):
        # This is the fix for the bug where re-scraping a swimmer doubled
        # every one of their races in the file.
        a = make()
        merged = F.merge([a], [a, a])
        self.assertEqual(len(merged), 1)

    def test_merge_keeps_genuinely_different_swims(self):
        merged = F.merge([make()], [make(time="59.00"), make(stroke="Backstroke")])
        self.assertEqual(len(merged), 3)

    def test_merge_preserves_first_seen_order(self):
        first, second = make(time="1:00.00"), make(time="59.00")
        self.assertEqual([r.time for r in F.merge([first], [second])],
                         ["1:00.00", "59.00"])

    def test_round_trip_through_csv(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.csv"
            rows = [make(), make(time="59.00")]
            self.assertEqual(F.write_csv(path, rows), 2)
            back = F.read_existing(path)
            self.assertEqual(len(back), 2)
            self.assertEqual(back[0].name, "Jo")
            self.assertEqual(back[0].race_date, "2025-03-01")

    def test_rerunning_a_scrape_does_not_grow_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.csv"
            rows = [make(), make(time="59.00")]
            F.write_csv(path, F.merge(F.read_existing(path), rows))
            F.write_csv(path, F.merge(F.read_existing(path), rows))
            F.write_csv(path, F.merge(F.read_existing(path), rows))
            self.assertEqual(len(F.read_existing(path)), 2)

    def test_reading_a_missing_file_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(F.read_existing(Path(tmp) / "nope.csv"), [])

    def test_commas_and_quotes_in_names_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.csv"
            tricky = make(name='Smith, Jordan "JJ"')
            F.write_csv(path, [tricky])
            self.assertEqual(F.read_existing(path)[0].name, 'Smith, Jordan "JJ"')

    def test_header_matches_what_the_dashboard_imports(self):
        self.assertEqual(
            F.CSV_COLUMNS,
            ["name", "gender", "club", "course", "distance", "stroke",
             "time", "race_date", "age_grp", "race_name"],
        )


if __name__ == "__main__":
    unittest.main()
