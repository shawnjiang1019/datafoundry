"""Clean tables out of report-style CSVs and keep their notes.

Data-book exports (FTC Consumer Sentinel, for example) are laid out for reading, not
loading: a title line, blank lines, one or more sections each with an optional
section title and its own header, then footnotes and a source line. Loading them
with a CSV sniffer takes the title as the header, buries the real header in the
data, skips rows that hold values, and keeps footnotes as data rows.

This module parses such a file into sections (one clean table each) plus notes
(title, section titles, footnotes, source), and normalizes numeric text in any
DuckDB table. Notes go into a `<table>__notes` table because the data gateway only
shows tables and columns to the agent; they also go into the table comment.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field

# A value with thousands separators, a currency sign, a percent sign or a decimal point
# is data; a bare 4-digit integer may be a year used as a header (2022, 2023, 2024).
_NUMBER = re.compile(r"^\*?-?\$?\s*(\d[\d,]*(\.\d+)?|\.\d+)([eE][+-]?\d+)?\s*%?\*?$")
# Same shape for DuckDB; '*' is a footnote marker ('*8,097,880'), stripped on conversion;
# an exponent covers Fortran-style output ('0.30634757E-12').
NUMBER_SQL = r"^\*?-?\$?\s*([0-9][0-9,]*(\.[0-9]+)?|\.[0-9]+)([eE][+-]?[0-9]+)?\s*%?\*?$"
# Missing-value spellings that should become NULL rather than block a numeric column.
NULL_TOKENS = ("NO DATA", "N/A", "NA", "M", "--", "—", "–")  # 'M' is NOAA's missing month
# Labels of aggregate rows printed under a table ('Min', 'Mean', 'Max' under monthly rainfall).
SUMMARY_LABELS = ("min", "max", "mean", "average", "avg", "median", "total", "sum", "std", "count")


@dataclass
class Section:
    title: str
    columns: list[str]
    rows: list[list[str]]
    headed: bool


@dataclass
class Report:
    title: str = ""
    sections: list[Section] = field(default_factory=list)
    notes: list[tuple[str, str]] = field(default_factory=list)  # (kind, text)


def read_rows(path: str, delimiter: str) -> list[list[str]]:
    """Every row of the file, cells stripped; tries UTF-8 then Windows-1252."""
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            with open(path, encoding=encoding, newline="") as handle:
                text = handle.read()
            break
        except UnicodeDecodeError:
            continue
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text), delimiter=delimiter)]


def _filled(row: list[str]) -> list[str]:
    return [cell for cell in row if cell]


def _is_data_value(cell: str) -> bool:
    return bool(_NUMBER.match(cell)) and (any(c in cell for c in ",.$%") or len(cell.lstrip("-")) > 4)


def is_report_style(rows: list[list[str]]) -> bool:
    """Title line before the data, several blank-separated data blocks, or text-only trailing lines."""
    nonblank = [row for row in rows if _filled(row)]
    if len(nonblank) < 2 or max(len(_filled(row)) for row in nonblank) < 2:
        return False
    if any(row[0].startswith("#") for row in nonblank[:5] if row):
        return False  # '#'-commented data files (Swarm density, OMNI) are not report layouts
    if len(nonblank) > 20 and sum(len(_filled(row)) >= 2 for row in nonblank) < len(nonblank) / 2:
        # Most lines single-cell in a long file: a delimiter mismatch, not a report. Short
        # files are exempt; a one-metro state is mostly its title and footnotes.
        return False
    if len(_filled(nonblank[0])) == 1:
        return True
    blocks = _blocks(rows)
    data_blocks = [block for block in blocks if any(len(_filled(row)) >= 2 for row in block)]
    return len(data_blocks) > 1 or (len(blocks) > 1 and not any(len(_filled(r)) >= 2 for r in blocks[-1]))


_COLUMN_DEF = re.compile(r"^#\s*Column\s+(\d+)\s*:\s*(?:[aefi]\d+(?:\.\d+)?\s+)?(.+?)\s*$", re.IGNORECASE)


def parse_commented_table(path: str) -> Report | None:
    """Whitespace-separated data under '#' comment lines that name each column ('# Column 4: f10.3 Altitude (m)').

    Swarm/GRACE density files use this layout. Returns None unless the comment
    header defines columns and every data line splits into exactly that many fields.
    """
    names: dict[int, str] = {}
    comments: list[str] = []
    data: list[list[str]] = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                match = _COLUMN_DEF.match(stripped)
                if match:
                    names[int(match.group(1))] = match.group(2)
                elif stripped.strip("# "):
                    comments.append(stripped.lstrip("# ").rstrip())
                continue
            data.append(stripped.split())
    if not names or not data or set(names) != set(range(1, len(names) + 1)):
        return None
    if any(len(row) != len(names) for row in data):
        return None
    columns = _column_names([names[i] for i in range(1, len(names) + 1)], len(names), headed=True)
    return Report(title=comments[0] if comments else "",
                  sections=[Section("", columns, data, headed=True)],
                  notes=[("header", text) for text in comments[1:40]])


def _blocks(rows: list[list[str]]) -> list[list[list[str]]]:
    blocks, current = [], []
    for row in rows:
        if _filled(row):
            current.append(row)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def _is_header(row: list[str]) -> bool:
    cells = _filled(row)
    return len(cells) >= 2 and not any(_is_data_value(cell) for cell in cells)


def _note_kind(text: str) -> str:
    return "source" if text.lower().startswith("source") else "footnote"


def parse_report(rows: list[list[str]], merge_continuations: bool = False) -> Report:
    """Split a report-style file into titled sections and notes; no row holding a value is dropped.

    `merge_continuations` appends a headerless block to the table above it when the
    widths match ('.Puerto Rico' after the states). It is opt-in per file: a summary
    block of the same width ('Number of Fraud Reports') looks identical.
    """
    report = Report()
    seen_data = False
    for block in _blocks(rows):
        if all(len(_filled(row)) <= 1 for row in block):
            for row in block:
                text = _filled(row)[0]
                if seen_data:
                    report.notes.append((_note_kind(text), text))
                elif not report.title:
                    report.title = text
                else:
                    report.notes.append(("preamble", text))
            continue
        seen_data = True
        index, title = 0, ""
        while index < len(block) and len(_filled(block[index])) <= 1:
            title = " ".join(filter(None, [title, _filled(block[index])[0]]))
            index += 1
        body = block[index:]
        headed = bool(body) and _is_header(body[0]) and len(body) > 1
        header, data = (body[0], body[1:]) if headed else ([], body)
        # A sparse row of group labels ('I Street', 'McCormack Bathhouse') over the full header row.
        while headed and len(data) > 1 and _is_header(data[0]) and len(_filled(header)) < len(_filled(data[0])):
            header, data = _stack_headers(header, data[0]), data[1:]
        rows_out, trailing = [], []
        for row in data:
            if len(_filled(row)) == 1 and not _is_data_value(_filled(row)[0]) and len(_filled(row)[0]) > 30:
                trailing.append(row)  # a footnote printed inside the block
            else:
                rows_out.append(row)
        while rows_out and len(_filled(rows_out[-1])) == 1:
            trailing.insert(0, rows_out.pop())  # citation/release lines printed under the data
        width = max([len(header)] + [len(row) for row in rows_out])
        while width > 1 and not any(len(row) >= width and row[width - 1] for row in [header] + rows_out):
            width -= 1
        previous = report.sections[-1] if report.sections else None
        if (merge_continuations and not headed and not title and previous and previous.headed
                and width == len(previous.columns)):
            # Rows set off by a blank line under a table ('.Puerto Rico' after the states) continue it.
            previous.rows += [(row + [""] * width)[:width] for row in rows_out]
            report.notes += [(_note_kind(_filled(row)[0]), _filled(row)[0]) for row in trailing]
            continue
        report.sections.append(Section(title, _column_names(header, width, headed),
                                       [(row + [""] * width)[:width] for row in rows_out], headed))
        report.notes += [(_note_kind(_filled(row)[0]), _filled(row)[0]) for row in trailing]
        if title:
            report.notes.append(("section", title))
    return report


def _stack_headers(groups: list[str], names: list[str]) -> list[str]:
    """Prefix each column name with the group label spanning it (labels carry right until the next one)."""
    width = max(len(groups), len(names))
    combined, group = [], ""
    for i in range(width):
        group = (groups[i] if i < len(groups) and groups[i] else group)
        name = names[i] if i < len(names) else ""
        combined.append(" ".join(part for part in (group, name) if part))
    return combined


def _column_names(header: list[str], width: int, headed: bool) -> list[str]:
    if not headed:
        # Headerless blocks are key/value summaries ('Median $ Loss', '$497') or bare grids.
        return ["label", "value", "note"][:width] if width <= 3 else [f"column{i}" for i in range(width)]
    names, used = [], {}
    for i in range(width):
        # A blank header cell sits over annotations such as '40.2% of total reports'.
        name = header[i] if i < len(header) and header[i] else "note"
        count = used.get(name, 0)
        used[name] = count + 1
        names.append(name if count == 0 else f"{name}.{count}")
    return names


def section_table_names(name: str, report: Report) -> list[str]:
    """One table keeps the file's name; several get `name__<section>` (or `__summary` when headerless)."""
    if len(report.sections) == 1:
        return [name]
    names, used = [], set()
    for index, section in enumerate(report.sections, start=1):
        if section.title:
            suffix = re.sub(r"[^0-9A-Za-z]+", "_", section.title).strip("_")[:48] or f"section{index}"
        else:
            suffix = "summary" if not section.headed else f"section{index}"
        candidate, n = f"{name}__{suffix}", 2
        while candidate.lower() in used:
            candidate, n = f"{name}__{suffix}_{n}", n + 1
        used.add(candidate.lower())
        names.append(candidate)
    return names


def write_notes(con, table: str, notes: list[tuple[str, str]], extra: list[tuple[str, str]] = ()) -> None:
    """Store notes as `<table>__notes(kind, note)` and as the table comment."""
    all_notes = list(notes) + list(extra)
    if not all_notes:
        return
    notes_table = f"{table}__notes"
    con.execute(f'CREATE OR REPLACE TABLE "{notes_table}" (kind VARCHAR, note VARCHAR)')
    con.executemany(f'INSERT INTO "{notes_table}" VALUES (?, ?)', all_notes)
    comment = " | ".join(f"{kind}: {text}" for kind, text in all_notes).replace("'", "''")[:4000]
    con.execute(f"COMMENT ON TABLE \"{table}\" IS '{comment}'")


def split_summary_rows(con, table: str) -> list[tuple[str, str]]:
    """Move trailing aggregate rows ('Min', 'Mean', 'Max' in the first column) to `<table>__summary`.

    Printed reports append them under the data, where they block the columns from
    typing as numbers and would be summed with the data. Nothing is dropped.
    """
    first = con.execute("select column_name, data_type from information_schema.columns where table_name = ? "
                        "and ordinal_position = 1", [table]).fetchone()
    if not first or first[1] != "VARCHAR":
        return []
    ident = '"' + first[0].replace('"', '""') + '"'
    labels = ", ".join("'" + label + "'" for label in SUMMARY_LABELS)
    rows = con.execute(f'select rowid, lower(trim({ident})) in ({labels}) from "{table}" order by rowid').fetchall()
    trailing = []
    for rowid, is_summary in reversed(rows):
        if not is_summary:
            break
        trailing.append(rowid)
    if not trailing or len(trailing) == len(rows) or any(flag for _, flag in rows[:len(rows) - len(trailing)]):
        return []
    listed = ", ".join(str(r) for r in trailing)
    con.execute(f'CREATE OR REPLACE TABLE "{table}__summary" AS SELECT * FROM "{table}" WHERE rowid IN ({listed})')
    con.execute(f'DELETE FROM "{table}" WHERE rowid IN ({listed})')
    names = [r[0] for r in con.execute(f'select {ident} from "{table}__summary"').fetchall()]
    return [("summary", f"{len(trailing)} aggregate row(s) printed under the data ({', '.join(names)}) "
                        f"were moved to {table}__summary")]


def normalize_numeric_text(con, table: str) -> list[tuple[str, str]]:
    """Convert text columns of numbers ('2024', '1,135,291', '$497', '17.54%') to numbers.

    A column converts only when every non-empty value parses and none has a leading
    zero (identifiers such as ZIP codes stay text). Returns one note per column whose
    text carried a separator or sign, saying what the units were.
    """
    columns = con.execute(
        "select column_name from information_schema.columns where table_name = ? and data_type = 'VARCHAR' "
        "order by ordinal_position", [table]).fetchall()
    converted: list[tuple[str, str]] = []
    selects = []
    tokens = ", ".join("'" + token + "'" for token in NULL_TOKENS)
    for (column,) in columns:
        ident = '"' + column.replace('"', '""') + '"'
        value = f"(case when upper(trim({ident})) in ({tokens}) then null else nullif(trim({ident}), '') end)"
        stats = con.execute(
            f"select count({value}), "
            f"count(*) filter (where regexp_full_match({value}, ?)), "
            f"count(*) filter (where regexp_matches({value}, '[,$%*]')), "
            f"count(*) filter (where regexp_full_match({value}, '0[0-9]+')), "
            f"count(*) filter (where {value} like '%\\%%' escape '\\'), "
            f"count(*) filter (where {value} like '%$%'), "
            f"count(*) filter (where {value} like '%.%' or lower({value}) like '%e%'), "
            f"count(*) filter (where {value} like '%*%'), "
            f"count(*) filter (where upper(trim({ident})) in ({tokens})) from \"{table}\"", [NUMBER_SQL]).fetchone()
        nonempty, matched, marked, leading_zero, percent, currency, decimal, starred, missing = stats
        if nonempty and matched == nonempty and not leading_zero:
            kind = "DOUBLE" if decimal or percent else "BIGINT"
            stripped = value
            for char in (",", "$", "%", " ", "*"):
                stripped = f"replace({stripped}, '{char}', '')"
            selects.append(f"try_cast({stripped} as {kind}) as {ident}")
            details = []
            if marked:
                details.append("values are " + ("percent (17.54 means 17.54%)" if percent
                                                else "US dollars" if currency else "plain numbers"))
            if starred:
                details.append(f"{starred} value(s) carried a '*' footnote marker, removed")
            if missing:
                details.append(f"{missing} missing-value marker(s) such as 'NO DATA' became empty")
            if details:
                converted.append(("column", f"{column}: converted from text; " + "; ".join(details)))
        else:
            selects.append(ident)
    if any(not s.startswith('"') for s in selects):
        typed = [r[0] for r in con.execute(
            "select column_name from information_schema.columns where table_name = ? order by ordinal_position",
            [table]).fetchall()]
        varchar = {c for (c,) in columns}
        order = iter(selects)
        expressions = [next(order) if c in varchar else '"' + c.replace('"', '""') + '"' for c in typed]
        con.execute(f'CREATE OR REPLACE TABLE "{table}__typed" AS SELECT {", ".join(expressions)} FROM "{table}"')
        con.execute(f'DROP TABLE "{table}"')
        con.execute(f'ALTER TABLE "{table}__typed" RENAME TO "{table}"')
    return converted
