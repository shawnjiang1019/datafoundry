"""Text above a table's header (title, notes, units row) is kept as notes, not dropped.

Run: python eval/kramabench/test_preheader_notes.py   (or pytest on this file)
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datafoundry_sut as sut  # noqa: E402

# The layout of KramaBench's climateMeasurements.xlsx: title, blank, note, blank, units row, header.
ABOVE = [
    ["Data Supplement to: a humidity index", None, None, None, None],
    [None, None, None, None, None],
    ["Note: the dust proxy is rescaled to our chronology.", None, None, None, None],
    [None, None, None, None, None],
    [None, None, "(ppm)", "(ppm)", "(see note)"],
]
HEADER = ["Site", "Age_ky", "Al", "K", "Dust proxy"]
DATA = [["ODP 967", 0.23, 64819.9, 10665.8, 0.65], ["ODP 967", 0.34, 69725.7, 11142.4, 0.71]]


def test_title_notes_and_units_become_notes() -> None:
    notes = sut.preheader_notes(ABOVE, HEADER)
    assert notes == [
        ("title", "Data Supplement to: a humidity index"),
        ("note", "Note: the dust proxy is rescaled to our chronology."),
        ("column", "Al: (ppm)"),
        ("column", "K: (ppm)"),
        ("column", "Dust proxy: (see note)"),
    ]


def test_cells_over_dropped_or_unnamed_columns_stay_as_a_note() -> None:
    notes = sut.preheader_notes([[None, "(m)", "kept as text"]], ["Site", None, None])
    assert notes == [("note", "(m) kept as text")]


def test_workbook_keeps_the_text_above_its_header() -> None:
    import duckdb
    import pandas as pd

    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "climate.xlsx")
        pd.DataFrame(ABOVE + [HEADER] + DATA).to_excel(path, header=False, index=False)
        con = duckdb.connect()
        notes: dict[str, list[tuple[str, str]]] = {}
        assert sut._load_workbook(con, path, "climate", None, notes) == 1
        assert [c[0] for c in con.execute("describe climate").fetchall()] == HEADER
        assert ("column", "K: (ppm)") in notes["climate"]
        assert notes["climate"][0] == ("title", "Data Supplement to: a humidity index")


def test_csv_keeps_its_preamble_lines() -> None:
    import duckdb

    with tempfile.TemporaryDirectory() as root:
        path = os.path.join(root, "fires.csv")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("Monthly wildfire statistics\nSource: a national agency\n"
                         "Year,Fires,Acres\n2020,100,2000\n2021,120,2500\n")
        con = duckdb.connect()
        con.execute("CREATE TABLE fires AS SELECT * FROM read_csv_auto(?, sample_size=-1)", [path])
        notes: dict[str, list[tuple[str, str]]] = {}
        sut._fix_csv_header(con, "fires", path, notes)
        assert [c[0] for c in con.execute("describe fires").fetchall()] == ["Year", "Fires", "Acres"]
        assert notes["fires"] == [("title", "Monthly wildfire statistics"),
                                  ("note", "Source: a national agency")]


def test_plain_text_list_keeps_its_first_line() -> None:
    with tempfile.TemporaryDirectory() as root:
        listing = os.path.join(root, "beaches.txt")
        with open(listing, "w", encoding="utf-8") as handle:
            handle.write("North Beach\nSouth Beach\n\nEast Beach\n")
        table = os.path.join(root, "t.txt")
        with open(table, "w", encoding="utf-8") as handle:
            handle.write("a,b\n1,2\n")
        assert sut.plain_text_list(listing) == ["North Beach", "South Beach", "East Beach"]
        assert sut.plain_text_list(table) is None


def test_build_keeps_a_plain_list_whole_but_not_a_spaced_table() -> None:
    import duckdb

    with tempfile.TemporaryDirectory() as root:
        lake = os.path.join(root, "lake"); os.makedirs(lake)
        with open(os.path.join(lake, "beaches.txt"), "w", encoding="utf-8") as handle:
            handle.write("North Beach\nSouth Beach\nEast Beach\n")
        with open(os.path.join(lake, "readings.txt"), "w", encoding="utf-8") as handle:
            handle.write("site depth\nA 3\nB 5\n")
        out = os.path.join(root, "lake.duckdb")
        sut.build_domain_duckdb(lake, out)
        con = duckdb.connect(out, read_only=True)
        assert con.execute("select * from beaches").fetchall() == [("North Beach",), ("South Beach",), ("East Beach",)]
        assert con.execute("select count(*) from readings").fetchone()[0] == 2  # header line stays the header


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
