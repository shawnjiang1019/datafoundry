"""Self-test for the OMNI ingestor (omni.py).

Builds tiny synthetic fixtures inline (a 3-row 55-column fixed-width ``.dat``
snippet and a small ``.lst`` snippet), runs :func:`omni.load` on each, and
asserts the produced rows/columns are as expected.  Prints PASS/FAIL.
"""

import os
import shutil
import tempfile

import omni

DAT_LINES = (
    "2024   1  0 2596 51 52  60  36   5.3   5.1  -7.3 322.9   4.0  -3.0  -0.6  -2.8  -1.4   0.1   1.5   0.3   0.4   1.5   31114.   7.4  306.  -2.3   2.8 0.042  1.35    4691.   0.4    2.   0.3   1.3 0.007   0.43   1.75   7.9  7  55     0   20 999999.99 99999.99 99999.99 99999.99 99999.99 99999.99  0   3 131.2 999.9    -9    11  5.0",
    "2024   1  1 2596 51 52  53  33   5.4   5.2 -21.3 333.4   4.4  -2.2  -1.9  -1.6  -2.4   0.1   1.1   0.5   0.4   1.0   28455.   6.5  301.  -2.1   1.9 0.040  1.14    4102.   0.4    4.   0.4   1.2 0.008   0.72   1.45   7.1  7  55     2   25 999999.99 99999.99 99999.99 99999.99 99999.99 99999.99  0   3 131.2 999.9   -11    14  4.7",
    "2024   1  2 2596 51 52  63  33   4.5   4.1 -42.3 324.4   2.5  -1.8  -2.8  -1.0  -3.1   0.7   2.0   0.6   1.2   1.4   36413.   7.9  309.  -0.8   1.7 0.034  1.43    2767.   1.0    2.   0.6   1.0 0.008   0.96   2.67   9.7  7  55     4   32 999999.99 99999.99 99999.99 99999.99 99999.99 99999.99  0   3 131.2 999.9   -11    21  5.3",
)

LST_LINES = (
    "2024 132  0 90",
    "2024 132  1 90",
    "2024 132  2 90",
    "2024 132  3 83",
)

FAILURES = []


def check(label, ok):
    if ok:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def write_named_file(tmpdir, name, lines):
    path = os.path.join(tmpdir, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def main():
    print("omni_selftest")
    tmpdir = tempfile.mkdtemp(prefix="omni_selftest_dir_")

    print("  -- static --")
    check("COLUMNS has exactly 55 entries", len(omni.COLUMNS) == 55)
    check("COLUMNS are unique", len(set(omni.COLUMNS)) == 55)
    check("WIDTHS has exactly 55 entries", len(omni.WIDTHS) == 55)
    check("WIDTHS sums to 327", sum(omni.WIDTHS) == 327)
    for i in range(len(DAT_LINES)):
        check(f"fixture line widths sum to 327 (row {i})", len(DAT_LINES[i]) == 327)

    print("  -- .dat fixed-width parse --")
    dat_path = write_named_file(tmpdir, "omni2_2024.dat", list(DAT_LINES))
    rows = omni.load_dat(dat_path)
    check("load(.dat) returns 3 rows", len(rows) == 3)
    check("each row has exactly 55 keys", all(len(r) == 55 for r in rows))
    check("keys == COLUMNS in order", all(list(r.keys()) == omni.COLUMNS for r in rows))
    r0 = rows[0]
    check("year == 2024 (int)", r0["year"] == 2024 and isinstance(r0["year"], int))
    check("doy == 1 (int)", r0["doy"] == 1 and isinstance(r0["doy"], int))
    check("hour == 0 (int)", r0["hour"] == 0 and isinstance(r0["hour"], int))
    check("Bx_GSE == 4.0 (float)", r0["Bx_GSE"] == 4.0 and isinstance(r0["Bx_GSE"], float))
    check("By_GSE == -3.0", r0["By_GSE"] == -3.0)
    check("Bz_GSM == -1.4", r0["Bz_GSM"] == -1.4)
    check("proton_temp == 31114.0", r0["proton_temp"] == 31114.0)
    check("flow_speed == 306.0", r0["flow_speed"] == 306.0)
    check("Na_Np == 0.042", r0["Na_Np"] == 0.042)
    check("flow_pressure == 1.35", r0["flow_pressure"] == 1.35)
    check("Kp == 7 (raw, not /10)", r0["Kp"] == 7)
    check("ap == 3", r0["ap"] == 3)
    check("f10.7 == 131.2 (float)", r0["f10.7"] == 131.2 and isinstance(r0["f10.7"], float))
    check("mach_number == 5.0", r0["mach_number"] == 5.0)
    check("pf_1MeV sentinel 999999.99 kept", r0["pf_1MeV"] == 999999.99)
    check("PC_N sentinel 999.9 kept", r0["PC_N"] == 999.9)
    check("row2 hour == 2, mach_number == 5.3", rows[2]["hour"] == 2 and rows[2]["mach_number"] == 5.3)

    print("  -- .dat with_datetime option --")
    rows_dt = omni.load_dat(dat_path, with_datetime=True)
    check("56 keys with datetime_utc", all(len(r) == 56 for r in rows_dt))
    check(
        "datetime_utc == 2024-01-01T00:00:00Z",
        rows_dt[0]["datetime_utc"] == "2024-01-01T00:00:00Z",
    )

    print("  -- .dat defensive skipping --")
    txt_path = write_named_file(tmpdir, "omni2.txt", ["# comment header", "not a data line", *DAT_LINES])
    rows_txt = omni.load(txt_path)
    check("load(.txt) routed to fixed-width, skips header, 3 rows", len(rows_txt) == 3)

    print("  -- .lst parse --")
    lst_path = write_named_file(tmpdir, "omni2_Kp_Index.lst", ["# comment header", "", *LST_LINES])
    lrows = omni.load(lst_path)
    check("load(.lst) returns 4 rows", len(lrows) == 4)
    check("parameter derived as 'Kp_Index'", lrows[0]["parameter"] == "Kp_Index")
    check("year/doy/hour == 2024/132/0", (lrows[0]["year"], lrows[0]["doy"], lrows[0]["hour"]) == (2024, 132, 0))
    check("value == 90 (raw Kp, not /10)", lrows[0]["value"] == 90)
    check("datetime_utc == 2024-05-11T00:00:00Z", lrows[0]["datetime_utc"] == "2024-05-11T00:00:00Z")
    l2 = omni.load_lst(lst_path, parameter="Flow_Pressure")
    check("parameter override == 'Flow_Pressure'", l2[0]["parameter"] == "Flow_Pressure")
    check("lst row keys", list(lrows[0].keys()) == ["parameter", "year", "doy", "hour", "value", "datetime_utc"])

    print("  -- dispatcher --")
    check("load(.dat) == load_dat", omni.load(dat_path) == omni.load_dat(dat_path))
    check("load(.lst) == load_lst", omni.load(lst_path) == omni.load_lst(lst_path))
    try:
        omni.load("whatever.csv")
        check("load raises on unsupported extension", False)
    except ValueError:
        check("load raises on unsupported extension", True)

    shutil.rmtree(tmpdir, ignore_errors=True)

    print("RESULT: " + ("PASS" if not FAILURES else f"FAIL ({len(FAILURES)} failed)"))


if __name__ == "__main__":
    main()
