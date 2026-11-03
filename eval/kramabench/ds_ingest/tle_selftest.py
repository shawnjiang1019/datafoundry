#!/usr/bin/env python
# coding: utf-8
"""Self-tests for tle.py using an inline synthetic fixture (real TLE wire format).

Run:  python tle_selftest.py
"""
import datetime as dt
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tle  # noqa: E402

PASS = []
FAIL = []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    if not condition:
        print(f"FAIL {name}: {detail}")


# ---------------------------------------------------------------------------
# Synthetic fixture 1: a real-format 3-line TLE (name line + line1 + line2).
# I wrote these values; deltas chosen to be easy to verify by hand.
#   epoch yy=24 ddd=001.50000000  -> 2024-01-01 12:00:00
#   ndot      .00004675   (plain float, cols 34-43)
#   nddot     -12345-3    -> -0.12345e-3
#   bstar     +20621-4    -> +0.20621e-4
#   element set 9994
#   inc 97.3997  raan 30.6612  ecc 0001844 -> 0.0001844
#   argper 94.0751  M 266.0696  n 15.22259301  rev 34648
# ---------------------------------------------------------------------------
TLE3 = """MY SYNTH SAT 48445 BETA
1 48445U 21040T   24001.50000000  .00004675 -12345-3 +20621-4 0  9994
2 48445  97.3997  30.6612 0001844  94.0751 266.0696 15.22259301346483
"""

# Fixture 2: century boundary checks + 2-line (no-name) groups.
TLE_PAIRS = """1 99999U 00001A   56001.50000000  .00000000  00000-0  00000-0 0    57
2 99999  51.6000   0.0000 0000000   0.0000   0.0000 14.96708820375004
1 99998U 00001A   99001.00000000  .00000000  00000-0  00000-0 0  9999
2 99998  98.0000 350.0000 0009000 180.0000 180.0000 16.0000000012345
"""


def test_three_line_group():
    rows = tle.parse(TLE3, source_file="fixture.tle")
    check("3-line: exactly one row", len(rows) == 1, f"got {len(rows)} rows")
    if not rows:
        return
    r = rows[0]

    check("name parsed", r["name"] == "MY SYNTH SAT 48445 BETA", repr(r["name"]))
    check("satname alias", r["satname"] == r["name"])
    check("norad on 2-line", r["norad_cat_id"] == 48445, repr(r["norad_cat_id"]))
    check(
        "epoch 2024-01-01T12:00:00",
        r["epoch"] == dt.datetime(2024, 1, 1, 12, 0, 0),
        repr(r["epoch"]),
    )
    check("inclination", abs(r["inclination_deg"] - 97.3997) < 1e-12)
    check("raan", abs(r["raan_deg"] - 30.6612) < 1e-12)
    check("eccentricity implied decimal", abs(r["eccentricity"] - 0.0001844) < 1e-12, repr(r["eccentricity"]))
    check("arg perigee", abs(r["arg_perigee_deg"] - 94.0751) < 1e-12)
    check("mean anomaly", abs(r["mean_anomaly_deg"] - 266.0696) < 1e-12)
    check("mean motion exact", abs(r["mean_motion_rev_per_day"] - 15.22259301) < 1e-12,
          repr(r["mean_motion_rev_per_day"]))
    check("ndot", abs(r["ndot"] - 0.00004675) < 1e-15, repr(r["ndot"]))
    check("ndot alias first_derivative", r["first_derivative"] == r["ndot"])
    check("nddot implied-decimal", abs(r["nddot"] - (-0.12345e-3)) < 1e-15, repr(r["nddot"]))
    check("nddot alias", r["second_derivative"] == r["nddot"])
    check("bstar signed implied-decimal", abs(r["bstar"] - 0.20621e-4) < 1e-15, repr(r["bstar"]))
    check("element set number", r["element_set_number"] == 999, repr(r["element_set_number"]))
    check("revolution number", r["revolution_number"] == 34648, repr(r["revolution_number"]))
    check("source_file", r["source_file"] == "fixture.tle")
    check("classification", r["classification"] == "U")


def test_two_line_pairs_and_century():
    rows = tle.parse(TLE_PAIRS, source_file="pairs.tle")
    check("2-line pairs: two rows", len(rows) == 2, f"got {len(rows)} rows")
    if len(rows) < 2:
        return
    r0, r1 = rows

    check("no name -> None", r0["name"] is None)
    check("century yy=56 -> 2056", r0["epoch"].year == 2056, repr(r0["epoch"].year))
    check("epoch .500 -> 12:00", r0["epoch"].hour == 12 and r0["epoch"].minute == 0, repr(r0["epoch"]))
    check("century yy=99 -> 1999", r1["epoch"].year == 1999, repr(r1["epoch"].year))
    check("epoch ddd=001.00000000 -> Jan 1 00:00", r1["epoch"] == dt.datetime(1999, 1, 1, 0, 0, 0), repr(r1["epoch"]))
    check("ecc 0009000 -> 0.0009", abs(r1["eccentricity"] - 0.0009) < 1e-15, repr(r1["eccentricity"]))
    check("mean motion token aligned", abs(r1["mean_motion_rev_per_day"] - 16.0) < 1e-12,
          repr(r1["mean_motion_rev_per_day"]))
    check("rev number cols 64-68", r1["revolution_number"] == 12345, repr(r1["revolution_number"]))


def test_field_level_tolerance():
    # blank/invalid fields yield None, file still parses
    txt = """1 00000U 00001A   24001.00000000  .00000000  xxxxx-0  00000-0 0  9999
2 00000  51.6000   0.0000 0000000   0.0000   0.0000 14.00000000000000
"""
    rows = tle.parse(txt)
    check("tolerant parse: 1 row", len(rows) == 1, f"got {len(rows)}")
    if rows:
        r = rows[0]
        check("nddot invalid -> None", r["nddot"] is None, repr(r["nddot"]))
        check("norad short 00000 -> int 0", r["norad_cat_id"] in (0, None), repr(r["norad_cat_id"]))
        check("epoch still parsed", r["epoch"] == dt.datetime(2024, 1, 1), repr(r["epoch"]))


def test_extract_norad():
    check("extract_norad ok", tle.extract_norad("2 48445  53.0537 165.0873 0001342  91.1262 268.9881 15.06394811146316") == 48445)
    check("extract_norad short", tle.extract_norad("2 12") is None)
    check("extract_norad None", tle.extract_norad(None) is None)


def test_hard_structural_error():
    try:
        tle.parse("1 48445U 21040T   24001.50000000  .00004675  00000-0  20621-3 0  9993\n")
        check("hard error raised", False)
    except ValueError:
        check("hard error raised", True)


def main():
    test_three_line_group()
    test_two_line_pairs_and_century()
    test_field_level_tolerance()
    test_extract_norad()
    test_hard_structural_error()

    print(f"PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
        sys.exit(1)
    print("tle_selftest OK")


if __name__ == "__main__":
    main()
