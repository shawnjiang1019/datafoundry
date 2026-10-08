"""Tests for report-style table parsing and numeric clean-up (run: python -m pytest eval/kramabench)."""

import csv
import io

import duckdb
import pytest

import report_tables as rt


def rows(text: str) -> list[list[str]]:
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]


FRAUD = """Fraud Reports by Amount Lost,,
,,
Number of Fraud Reports,"2,600,678",
Reports with $ Loss,"987,520",38% of the total
Median $ Loss,$497 ,
,,
"Reported Fraud Losses in $1 - $1,000 Range",,
Amount Lost,# of Reports,
$1 - $100,"243,174",
$101 - $200,"114,336",
,,
"The amount lost is based on reports in which consumers indicated they lost between $1 and $999,999. ",,
,,
"Source: Consumer Sentinel Network Data Book 2024, Federal Trade Commission",,
"""


def test_report_sections_keep_every_value_row_and_notes():
    report = rt.parse_report(rows(FRAUD))
    assert report.title == "Fraud Reports by Amount Lost"
    summary, buckets = report.sections
    assert not summary.headed and summary.columns == ["label", "value", "note"]
    assert summary.rows[0] == ["Number of Fraud Reports", "2,600,678", ""]  # the row the old loader dropped
    assert buckets.headed and buckets.title == "Reported Fraud Losses in $1 - $1,000 Range"
    assert buckets.columns == ["Amount Lost", "# of Reports"] and len(buckets.rows) == 2
    kinds = [kind for kind, _ in report.notes]
    assert kinds.count("footnote") == 1 and kinds.count("source") == 1
    assert rt.section_table_names("fraud", report) == ["fraud__summary", "fraud__Reported_Fraud_Losses_in_1_1_000_Range"]


def test_plain_csv_is_not_report_style_but_titled_table_is():
    assert not rt.is_report_style(rows("a,b\n1,2\n3,4\n"))
    assert rt.is_report_style(rows("Identity Theft Reports by Age,\n,\nAge Range,# of Reports\n20 - 29,\"187,195\"\n"))


def test_stacked_header_prefixes_group_labels():
    report = rt.parse_report(rows(
        "Carson Beach,,,,\n,,I Street,,Bathhouse\nDate,Rain,Tag,Enterococcus,Enterococcus\n"
        "\"August 27, 2024\",0,,61,41\n"))
    assert report.sections[0].columns == ["Date", "Rain", "I Street Tag", "I Street Enterococcus",
                                          "Bathhouse Enterococcus"]


def test_continuation_rows_merge_only_when_asked():
    text = "Title,,\n,,\nArea,2020,2021\n.Ohio,1,2\n.Utah,3,4\n,,\n.Puerto Rico,5,6\n"
    assert len(rt.parse_report(rows(text)).sections) == 2
    merged = rt.parse_report(rows(text), merge_continuations=True)
    assert len(merged.sections) == 1 and merged.sections[0].rows[-1][0] == ".Puerto Rico"


@pytest.fixture()
def con():
    connection = duckdb.connect()
    connection.execute("""create table t as select * from (values
        ('2001', '1,135,291', '17.54%', '$497 ', '017', 'NO DATA', '*8,097,880'),
        ('2002', '86,250',    '20.91%', '$1,500', '009', '.3 %',   '12'))
        v(year, reports, pct, loss, county, humidity, acres)""")
    return connection


def test_numeric_text_converts_and_identifiers_stay_text(con):
    notes = rt.normalize_numeric_text(con, "t")
    types = dict(con.execute("select column_name, data_type from information_schema.columns where table_name='t'")
                 .fetchall())
    assert types == {"year": "BIGINT", "reports": "BIGINT", "pct": "DOUBLE", "loss": "BIGINT",
                     "county": "VARCHAR", "humidity": "DOUBLE", "acres": "BIGINT"}
    assert con.execute("select reports, pct, humidity, acres from t order by year").fetchall() == [
        (1135291, 17.54, None, 8097880), (86250, 20.91, 0.3, 12)]
    text = " ".join(note for _, note in notes)
    assert "percent" in text and "footnote marker" in text and "NO DATA" in text


def test_trailing_summary_rows_move_to_their_own_table():
    connection = duckdb.connect()
    connection.execute("create table p as select * from (values ('2023','1.2'),('2024','2.0'),('Min','1.2 2023'),"
                       "('Max','2.0 2024')) v(Year, Jan)")
    notes = rt.split_summary_rows(connection, "p")
    assert connection.execute("select count(*) from p").fetchone() == (2,)
    assert connection.execute("select Year from p__summary order by Year").fetchall() == [("Max",), ("Min",)]
    assert notes and "p__summary" in notes[0][1]
    assert rt.normalize_numeric_text(connection, "p") == []  # Year and Jan now type as numbers
    assert dict(connection.execute("select column_name, data_type from information_schema.columns "
                                   "where table_name='p'").fetchall()) == {"Year": "BIGINT", "Jan": "DOUBLE"}


def test_commented_whitespace_table_takes_names_from_column_comments(tmp_path=None):
    import pathlib
    import tempfile

    folder = pathlib.Path(tmp_path or tempfile.mkdtemp())
    path = folder / "density.txt"
    path.write_text("# Swarm B density\n# Column  1:         Date (yyyy-mm-dd)\n# Column  2:  f10.3  Altitude (m)\n"
                    "# Column  3:  e15.8  Density (kg/m3)\n2024-01-01 511948.313 0.30634757E-12\n"
                    "2024-01-02 512048.665 0.30168190E-12\n", encoding="utf-8")
    report = rt.parse_commented_table(str(path))
    assert report.sections[0].columns == ["Date (yyyy-mm-dd)", "Altitude (m)", "Density (kg/m3)"]
    assert len(report.sections[0].rows) == 2 and report.title == "Swarm B density"
    connection = duckdb.connect()
    connection.execute("create table d as select * from (values ('0.30634757E-12'), ('1.5e-3')) v(dens)")
    rt.normalize_numeric_text(connection, "d")
    assert connection.execute("select data_type from information_schema.columns where table_name='d'").fetchone() \
        == ("DOUBLE",)
    assert not rt.is_report_style(rows("# a comment\n1,2\n3,4\n"))


def test_notes_become_a_table_and_the_table_comment():
    connection = duckdb.connect()
    connection.execute("create table r (x integer)")
    rt.write_notes(connection, "r", [("footnote", "86% included age")])
    assert connection.execute('select * from "r__notes"').fetchall() == [("footnote", "86% included age")]
    assert "86% included age" in connection.execute(
        "select comment from duckdb_tables() where table_name = 'r'").fetchone()[0]
