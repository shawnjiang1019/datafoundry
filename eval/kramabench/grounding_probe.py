"""Offline probe for evidence-aware grounding on a KramaBench domain lake.

Answers one question before any runtime code is written: can semantic candidates
(names + in-lake data dictionaries) followed by physical validation (exact value
containment over full distinct sets) find the join keys a task needs, and reject
the wrong ones?

No LLM, no DataFoundry. Reads the same DuckDB lake the SUT builds.

    python grounding_probe.py --lake wildfire.duckdb --workload workload/wildfire.json \
        [--task wildfire-hard-17] [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field

import duckdb

VERIFIED = 0.8          # containment of the referencing side needed to call a join verified
REJECTED = 0.05         # below this a candidate is rejected outright
MIN_DISTINCT = 10       # smaller domains overlap trivially; flag instead of verifying
DICT_COVERAGE = 0.5     # share of a table's columns a dictionary column must name

STOP = {"the", "and", "for", "with", "from", "that", "this", "are", "was", "what", "which", "how",
        "many", "much", "used", "data", "dataset", "number", "value", "values", "according", "based",
        "each", "their", "into", "per", "only", "answer", "average", "total", "find", "give", "does",
        "described", "defined", "unnamed", "description", "variable", "name", "alternative"}
ID_NAME = re.compile(r"(^|[\s_])(id|ids|code|key|no|num|number|identifier)$", re.I)
ID_DESC = re.compile(r"\b(id|identifier|identifying|number|code)\b", re.I)


def terms(text: str) -> set[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text or "")
    out = set()
    for tok in re.split(r"[^A-Za-z0-9]+", text.lower()):
        if len(tok) < 3 or tok in STOP or tok.isdigit():
            continue
        out.add(tok[:-1] if tok.endswith("s") and len(tok) > 4 else tok)
    return out


@dataclass
class Column:
    table: str
    name: str
    dtype: str
    rows: int
    distinct: int = 0
    as_text: set = field(default_factory=set)
    as_num: set = field(default_factory=set)
    description: str = ""

    @property
    def ref(self) -> str:
        return f"{self.table}.{self.name}"

    @property
    def id_like(self) -> bool:
        return bool(ID_NAME.search(self.name) or ID_DESC.search(self.description))

    def context_terms(self) -> set[str]:
        return terms(self.name) | terms(self.description)


def q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def load_columns(con) -> dict[str, list[Column]]:
    tables: dict[str, list[Column]] = {}
    for (table,) in con.execute("SHOW TABLES").fetchall():
        rows = con.execute(f"SELECT COUNT(*) FROM {q(table)}").fetchone()[0]
        cols = con.execute(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? "
            "ORDER BY ordinal_position", [table]).fetchall()
        tables[table] = [Column(table, name, dtype, rows) for name, dtype in cols]
    return tables


def is_key_like(col: Column) -> bool:
    return col.dtype in ("BIGINT", "INTEGER", "SMALLINT", "HUGEINT", "VARCHAR") and col.rows > 0


def profile(con, col: Column) -> None:
    """Full distinct set in two normal forms: trimmed upper text, and integer when the value is integral."""
    rows = con.execute(
        f"SELECT DISTINCT UPPER(TRIM(CAST({q(col.name)} AS VARCHAR))) AS t, "
        f"TRY_CAST(TRIM(CAST({q(col.name)} AS VARCHAR)) AS DOUBLE) AS n "
        f"FROM {q(col.table)} WHERE {q(col.name)} IS NOT NULL").fetchall()
    col.as_text = {t for t, _ in rows if t}
    col.as_num = {int(n) for _, n in rows if n is not None and float(n).is_integer()}
    col.distinct = len(col.as_text)


def norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def same_rows(con, ta: str, tb: str, columns: list[str]) -> bool:
    cols = ", ".join(q(c) for c in columns)
    return con.execute(
        f"SELECT COUNT(*) FROM (SELECT {cols} FROM {q(ta)} EXCEPT SELECT {cols} FROM {q(tb)})").fetchone()[0] == 0


def avg_length(con, table: str, column: str) -> float:
    return con.execute(f"SELECT AVG(LENGTH({q(column)})) FROM {q(table)}").fetchone()[0] or 0.0


def detect_dictionaries(con, tables) -> list[dict]:
    """A dictionary is a table whose text column names most of another table's columns.

    Checked against the data, not guessed from table names: the value set must cover the
    target table's column names. Returns (dict table, key column, target table) and fills
    Column.description on the target table.
    """
    found = []
    for dtable, dcols in tables.items():
        text_cols = [c.name for c in dcols if c.dtype == "VARCHAR"]
        for key in dcols:
            # A dictionary row describes one variable: the key is unique and another column
            # holds prose. Without these checks a code column (state abbreviations) matches
            # any wide table whose column names happen to be codes.
            if key.dtype != "VARCHAR" or not key.as_text or key.distinct < key.rows * 0.95:
                continue
            if not any(c != key.name and avg_length(con, dtable, c) >= 20 for c in text_cols):
                continue
            for target, tcols in tables.items():
                if target == dtable or len(tcols) < 4:
                    continue
                names = {c.name.upper() for c in tcols}
                coverage = len(names & key.as_text) / len(names)
                if coverage < DICT_COVERAGE:
                    continue
                select = ", ".join(q(c) for c in text_cols if c != key.name)
                by_name = {c.name.upper(): c for c in tcols}
                described = 0
                for row in con.execute(f"SELECT {q(key.name)}, {select} FROM {q(dtable)}").fetchall():
                    parts = [str(v) for v in row[1:] if v not in (None, "", "None")]
                    col = by_name.get(str(row[0]).strip().upper())
                    if col and parts:
                        col.description = " | ".join(parts)
                        described += 1
                found.append({"dictionary": dtable, "key_column": key.name, "describes": target,
                              "coverage": round(coverage, 3), "columns_described": described})
    return found


def containment(a: Column, b: Column) -> tuple[float, str, int]:
    """Share of a's distinct values found in b, best of the text and numeric forms."""
    text_hits = len(a.as_text & b.as_text)
    num_hits = len(a.as_num & b.as_num) if a.as_num and b.as_num else 0
    hits, form = (num_hits, "numeric") if num_hits > text_hits else (text_hits, "text")
    return (hits / a.distinct if a.distinct else 0.0), form, hits


def semantic_support(a: Column, b: Column) -> tuple[float, list[str]]:
    """Evidence that a refers to b, from names and dictionary text only.

    Three signals, each recorded so a reader can see why a candidate exists:
    - same column name (DataBridge joins.py name_heuristic)
    - b's column name is contained in a's name or description (start_year -> Year)
    - a is described as an identifier, b is identifier-like, and a's name or
      description names b's table (station_verified_in_psa "RAWS ID" -> RAWS table)
    Shared description words alone are not evidence: measures from one source share
    most of their vocabulary.
    """
    reasons = []
    score = 0.0
    if a.name.strip().lower() == b.name.strip().lower():
        reasons.append("same column name")
        score += 0.6
    b_name = terms(b.name)
    if b_name and b_name <= a.context_terms() and "same column name" not in reasons:
        reasons.append(f"target column name {sorted(b_name)} appears in source name/description")
        score += 0.4
    table_named = terms(b.table) & (terms(a.description) | terms(a.name))
    if a.id_like and b.id_like and table_named:
        reasons.append(f"identifier whose name/description names table term(s) {sorted(table_named)}")
        score += 0.5
    return min(1.0, score), reasons


def gate(a: Column, b: Column) -> dict:
    sem, reasons = semantic_support(a, b)
    contained, form, hits = containment(a, b)
    text_contained = len(a.as_text & b.as_text) / a.distinct if a.distinct else 0.0
    unique_rate = b.distinct / b.rows if b.rows else 0.0
    if min(a.distinct, b.distinct) < MIN_DISTINCT and contained >= VERIFIED:
        status = "small-domain"
    elif contained >= VERIFIED and sem > 0:
        status = "verified"
    elif contained >= VERIFIED:
        status = "physical-only"
    elif contained < REJECTED:
        status = "rejected"
    else:
        status = "partial"
    # What the agent would plausibly miss: the names differ, or plain text equality
    # finds well under the real overlap (leading zeros, int vs string, padding).
    hidden = []
    if norm_name(a.name) != norm_name(b.name):
        hidden.append("different names")
    if form == "numeric" and contained - text_contained >= 0.2:
        hidden.append(f"needs numeric normalization (text match only {text_contained:.2f})")
    return {
        "from": a.ref, "to": b.ref, "status": status, "non_obvious": hidden,
        "semantic": {"score": round(sem, 2), "reasons": reasons},
        "physical": {"containment": round(contained, 3), "matched": hits, "from_distinct": a.distinct,
                     "to_distinct": b.distinct, "to_unique_rate": round(unique_rate, 3), "form": form,
                     "types": f"{a.dtype}->{b.dtype}"},
    }


def candidate_pairs(tables, table_filter=None, semantic_only=True):
    names = [t for t in tables if table_filter is None or t in table_filter]
    for ta in names:
        for tb in names:
            if ta == tb:
                continue
            for a in tables[ta]:
                if not is_key_like(a) or a.distinct < 2:
                    continue
                for b in tables[tb]:
                    if not is_key_like(b) or b.distinct < 2:
                        continue
                    if semantic_only and semantic_support(a, b)[0] == 0:
                        continue
                    yield a, b


def question_focus(question: str, tables, dictionaries) -> list[tuple[float, Column]]:
    """Columns the question is about, scored by term overlap with name + dictionary description."""
    qt = terms(question)
    dict_tables = {d["dictionary"] for d in dictionaries}
    scored = []
    for cols in tables.values():
        for c in cols:
            if c.table in dict_tables:
                continue
            overlap = qt & (c.context_terms() | terms(c.table))
            if overlap:
                scored.append((len(overlap) / len(qt), c))
    return sorted(scored, key=lambda x: -x[0])


def source_tables(sources: list[str], tables) -> set[str]:
    """Map declared source files to lake tables, including the ingester's merged families.

    Exact stem first; otherwise the stem with years/ids stripped (water-body-testing-2002
    -> t__water_body_testing) or the folder name (State MSA Fraud and Other Data/*.csv ->
    State_MSA_Fraud_and_Other_data), matched as a substring of the table name.
    """
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    found = set()
    for source in sources:
        folder, _, leaf = source.rstrip("/").rpartition("/") if "/" in source else ("", "", source)
        stem = norm(leaf.rsplit(".", 1)[0]) if "." in leaf else norm(leaf)
        # Workbooks become one table per sheet, named <workbook>__<sheet>.
        exact = {t for t in tables if norm(t) == stem
                 or (leaf.lower().endswith((".xlsx", ".xls")) and norm(t).startswith(stem))}
        if exact:
            found |= exact
            continue
        keys = [k for k in (norm(re.sub(r"\d{2,}", "", leaf.rsplit(".", 1)[0])),
                            norm(re.sub(r"^all csv in ", "", folder or (leaf if "." not in leaf else ""))))
                if len(k) >= 6 and "csv" != k]
        found |= {t for t in tables if any(k in norm(t) for k in keys)}
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lake", required=True)
    ap.add_argument("--workload", required=True)
    ap.add_argument("--task")
    ap.add_argument("--json")
    args = ap.parse_args()

    con = duckdb.connect(args.lake, read_only=True)
    tables = load_columns(con)
    for cols in tables.values():
        for c in cols:
            if is_key_like(c):
                profile(con, c)
    dictionaries = detect_dictionaries(con, tables)
    report = {"dictionaries": dictionaries, "lake": {}, "tasks": []}

    print("== dictionaries")
    for d in dictionaries:
        print(f"  {d['dictionary']}.{d['key_column']} describes {d['describes']} "
              f"(coverage {d['coverage']}, {d['columns_described']} columns)")

    # Lake-wide: how much does physical evidence alone admit, and how much does semantics prune?
    physical = [gate(a, b) for a, b in candidate_pairs(tables, semantic_only=False)]
    joinable = [r for r in physical if r["physical"]["containment"] >= VERIFIED]
    by_status = {}
    for r in physical:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    report["lake"] = {"pairs": len(physical), "by_status": by_status}
    print(f"\n== lake-wide, all key-like pairs: {len(physical)} pairs, containment>={VERIFIED}: {len(joinable)}")
    print("  by status:", by_status)
    print("  verified (physical + semantic):")
    for r in sorted((r for r in physical if r["status"] == "verified"),
                    key=lambda r: -r["physical"]["containment"])[:30]:
        print(f"    {r['from']} -> {r['to']}  c={r['physical']['containment']} "
              f"({r['physical']['matched']}/{r['physical']['from_distinct']}, {r['physical']['form']})")

    # Two tables with the same columns and rows are one dataset shipped twice
    # (Fire_Weather_Data_* duplicates noaa_wildfires); a join between them is not a relationship.
    duplicates = set()
    for ta, ca in tables.items():
        for tb, cb in tables.items():
            if ta < tb and ca and cb and ca[0].rows == cb[0].rows \
                    and {c.name for c in ca} == {c.name for c in cb} \
                    and same_rows(con, ta, tb, [c.name for c in ca]):
                duplicates.add(frozenset((ta, tb)))
                print(f"  duplicate tables: {ta} == {tb}")

    workload = json.load(open(args.workload))
    for task in workload:
        if args.task and task["id"] != args.task:
            continue
        srcs = source_tables(task["data_sources"], tables)
        dict_tables = {d["dictionary"] for d in dictionaries}
        data_srcs = srcs - dict_tables
        entry = {"id": task["id"], "sources_in_lake": sorted(srcs),
                 "missing_sources": len(task["data_sources"]) - len(srcs)}
        print(f"\n== {task['id']}: {task['query'][:100]}")
        print(f"  sources in lake: {sorted(srcs)}  missing: {entry['missing_sources']}")
        entry["relationships"] = []
        if len(data_srcs) < 2:
            print("  oracle sources: single data table, no cross-table join needed")
        else:
            # Oracle sources: every key-like pair between the task's tables (ceiling).
            oracle = [gate(a, b) for a, b in candidate_pairs(tables, data_srcs, semantic_only=False)]
            entry["relationships"] = [r for r in oracle if r["status"] != "rejected"]
            print("  oracle sources, semantically supported pairs:")
            for r in sorted((r for r in oracle if r["semantic"]["score"] > 0),
                            key=lambda r: (r["status"] != "verified", -r["physical"]["containment"]))[:8]:
                print(f"    [{r['status']}] {r['from']} -> {r['to']}  c={r['physical']['containment']} "
                      f"({r['physical']['matched']}/{r['physical']['from_distinct']}, {r['physical']['form']})")

        # Question-driven: no source oracle. Focus columns from the question, then candidates.
        # Ranked by how relevant the source column is to the question plus semantic support;
        # containment decides status, not rank, so a large trivially-shared domain (years)
        # cannot outrank the relationship the question is about.
        focus = question_focus(task["query"], tables, dictionaries)[:5]
        print("  question focus:", [f"{c.ref}({s:.2f})" for s, c in focus])
        q_rels = []
        for relevance, a in focus:
            if not is_key_like(a):
                continue
            for cols in tables.values():
                for b in cols:
                    if b.table == a.table or b.table in dict_tables or not is_key_like(b):
                        continue
                    if frozenset((a.table, b.table)) in duplicates:
                        continue
                    if semantic_support(a, b)[0] > 0:
                        q_rels.append({**gate(a, b), "relevance": round(relevance, 2)})
        entry["question_driven"] = q_rels
        rank = lambda r: (r["status"] != "verified", -(r["relevance"] + r["semantic"]["score"]),
                          -r["physical"]["containment"])
        for r in sorted(q_rels, key=rank)[:6]:
            print(f"    [{r['status']}] {r['from']} -> {r['to']}  c={r['physical']['containment']} "
                  f"({r['physical']['matched']}/{r['physical']['from_distinct']}, {r['physical']['form']})"
                  f"  why: {'; '.join(r['semantic']['reasons'])}")

        # Ceiling: verified relationships among the task's own sources that the agent could miss.
        target = [r for r in entry["relationships"] if r["status"] == "verified" and r["non_obvious"]]
        missed_by_semantics = [r for r in entry["relationships"]
                               if r["status"] == "physical-only" and r["non_obvious"]]
        target_keys = {(r["from"].split(".", 1)[1], r["to"]) for r in target}
        top3 = sorted(q_rels, key=rank)[:3]
        entry["summary"] = {
            "data_tables": len(data_srcs),
            "non_obvious_verified": [f"{r['from']} -> {r['to']} ({', '.join(r['non_obvious'])}, "
                                     f"c={r['physical']['containment']})" for r in target],
            "non_obvious_physical_only": len(missed_by_semantics),
            "question_top3_hit": any((r["from"].split(".", 1)[1], r["to"]) in target_keys for r in top3),
        }
        report["tasks"].append(entry)

    print("\n== summary: tasks with a verified key the agent could miss")
    print(f"  {'task':<24} {'tables':>6} {'nonobvious':>10} {'phys-only':>9} {'q-top3':>6}")
    for e in report["tasks"]:
        s = e["summary"]
        print(f"  {e['id']:<24} {s['data_tables']:>6} {len(s['non_obvious_verified']):>10} "
              f"{s['non_obvious_physical_only']:>9} {str(s['question_top3_hit']):>6}")
        for line in s["non_obvious_verified"][:4]:
            print(f"      {line}")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(report, fh, indent=1, default=str)


if __name__ == "__main__":
    main()
