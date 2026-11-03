#!/usr/bin/env python
# coding: utf-8
"""Self-tests for sp3.py using an inline synthetic SP3 fixture.

Fixture: 2 epochs x 1 satellite (Swarm-A PRN L47), mixing P and V records plus
EP / EN lines that must be ignored.

Run:  python sp3_selftest.py
"""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sp3  # noqa: E402

PASS = []
FAIL = []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    if not condition:
        print(f"FAIL {name}: {detail}")


SP3_SMALL = """#cP2019  9 29  0  0  0.00000000      2 P+   IGb14 FIT TUD
##          2      0.00000000    10.00000000 58755 0.0000000000000
+    1   L47  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0                          
+          0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0                          
%c M  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc                          
%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc                          
%f  0.0000000  0.000000000  0.00000000000  0.000000000000000                          
%i    0    0    0    0      0      0      0      0         0                          
/* Synthetic fixture, two epochs, one satellite.                                      
*  2019 09 29 00 00 00.00000000                             
PL47   489.5961572   793.1388813 -6757.7883437 999999.999999
VL47-58781.4376871-47308.3362640 -9809.9895251 999999.999999
EPL47 12345.6789012   9876.5432109  leaky line that must be ignored
ENL47 111.1111111     222.2222222   333.3333333
*  2019 09 29 00 00 10.00000000                             
PL47   430.7510084   745.8251195 -6767.1750274 999999.999999
VL47-58907.6425111-47318.1759816 -8963.1848034 999999.999999
EOF
"""


def test_parse_rows():
    rows = sp3.parse(SP3_SMALL, source_file="swarm_fixture.sp3")
    check("two P rows", len(rows) == 2, f"got {len(rows)}")
    if len(rows) < 2:
        return
    (r1, r2) = rows

    check("sat = L47", r1["sat"] == "L47", repr(r1["sat"]))
    check("epoch0", r1["epoch"] == dt.datetime(2019, 9, 29, 0, 0, 0), repr(r1["epoch"]))
    check("epoch1", r2["epoch"] == dt.datetime(2019, 9, 29, 0, 0, 10), repr(r2["epoch"]))
    check("x_km0", abs(r1["x_km"] - 489.5961572) < 1e-9, repr(r1["x_km"]))
    check("y_km0", abs(r1["y_km"] - 793.1388813) < 1e-9, repr(r1["y_km"]))
    check("z_km0", abs(r1["z_km"] - (-6757.7883437)) < 1e-9, repr(r1["z_km"]))
    check("clock_usec sentinel preserved",
          r1["clock_usec"] == sp3.CLOCK_SENTINEL, repr(r1["clock_usec"]))
    check("x_km1", abs(r2["x_km"] - 430.7510084) < 1e-9, repr(r2["x_km"]))
    check("source_file", r1["source_file"] == "swarm_fixture.sp3", repr(r1["source_file"]))
    # VL / EP / EN / + / % / /* lines must NOT produce rows
    check("non-P records skipped", all(r["sat"] == "L47" for r in rows))


def test_parse_header_file(tmp_path=None):
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".sp3", delete=False, encoding="utf-8") as fh:
        fh.write(SP3_SMALL)
        path = fh.name
    try:
        h = sp3.parse_header(path)
        check("start epoch parsed", h["start_epoch"] == dt.datetime(2019, 9, 29, 0, 0, 0),
              repr(h["start_epoch"]))
        check("version char", h["version"] == "c", repr(h["version"]))
        check("position/velocity flag", h["data_used"] == "P", repr(h["data_used"]))
        check("epoch_count from # line", h["epoch_count"] == 2, repr(h["epoch_count"]))
        check("interval from ##", h["interval_seconds"] == 10.0, repr(h["interval_seconds"]))
        check("## count", h["count_from_double_hash"] == 2, repr(h["count_from_double_hash"]))
        check("mjd from ##", h["mjd_doublehash"] == 58755, repr(h["mjd_doublehash"]))
        check("epoch_count_actual == 2", h["epoch_count_actual"] == 2, repr(h["epoch_count_actual"]))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def test_satellite_from_filename():
    check("SP3A COM -> A",
          sp3.satellite_from_filename("SW_OPER_SP3ACOM_2__20190928T235942_20190929T235942_0201.sp3") == "A")
    check("SP3B -> B",
          sp3.satellite_from_filename("SW_OPER_SP3BCOM_2__20190928T235942_20190929T235942_0201.sp3") == "B")
    check("no match -> None", sp3.satellite_from_filename("orbits2019.sp3") is None)


def test_missing_epoch_error():
    try:
        sp3.parse("#cP2019  9 29  0  0  0.00000000      2 P+   IGb14 FIT TUD\nPL47   1.0 2.0 3.0 0.0\n")
        check("P-before-epoch raises", False)
    except sp3.Sp3Error:
        check("P-before-epoch raises", True)


def test_no_header_error():
    try:
        sp3.parse("just some text\nnot an sp3 file\n")
        check("missing header raises", False)
    except sp3.Sp3Error:
        check("missing header raises", True)


def main():
    test_parse_rows()
    test_parse_header_file()
    test_satellite_from_filename()
    test_missing_epoch_error()
    test_no_header_error()

    print(f"PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
        sys.exit(1)
    print("sp3_selftest OK")


if __name__ == "__main__":
    main()
