"""
DataFoundry-as-KramaBench-SUT.

Implements KramaBench's System interface (process_dataset + serve_query) backed
by DataFoundry, so a poor score shows *where* DataFoundry's governed SQL-first
model breaks down (see notes/gap-analysis.md items 3/5).

Setup and usage: see eval/kramabench/README.md. In short, copy this file to
KramaBench/systems/datafoundry_sut.py and register it in KramaBench/systems/__init__.py:
    from .datafoundry_sut import DataFoundrySUT
Run one domain (final-answer scoring only, serial):
    python evaluate.py --sut DataFoundrySUT --workload environment --no_pipeline_eval --num_workers 1 --verbose

Prereqs (env vars):
    DF_API=http://127.0.0.1:8787   DF_EMAIL=...   DF_PASSWORD=...
    DF_LLM_PROFILE=server-default  (must point at a reachable model)
    DF_RUN_TIMEOUT=180             (fail slow/un-runnable tasks fast)
DataFoundry must be running (npm run start) with a verified account + working model profile.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import pathlib
import re
import sys
import time
import uuid

import requests

try:
    import duckdb
except ImportError:
    duckdb = None

# KramaBench's base class when run inside the harness; a shim for standalone --smoke.
try:
    from benchmark.benchmark_api import System
except Exception:
    class System:  # type: ignore
        def __init__(self, system_name: str, verbose: bool = False, *args, **kwargs):
            self.name = system_name
            self.dataset_directory = None
            self.verbose = verbose

API = os.environ.get("DF_API", "http://127.0.0.1:8787").rstrip("/")
LLM_PROFILE = os.environ.get("DF_LLM_PROFILE", "server-default")
RUN_TIMEOUT_S = int(os.environ.get("DF_RUN_TIMEOUT", "180"))


def _unwrap(resp):
    """DataFoundry wraps every response as {success, data}; return the payload."""
    body = resp.json()
    if isinstance(body, dict) and "data" in body and set(body) <= {"success", "data", "error"}:
        return body["data"]
    return body


# ── DataFoundry client ────────────────────────────────────────────────────────

class DataFoundryClient:
    """Login, register a DuckDB datasource, drive one run, read the answer back."""

    def __init__(self, api_base: str, email: str, password: str):
        self.api = api_base.rstrip("/")
        self.s = requests.Session()
        self._login(email, password)

    def _login(self, email: str, password: str) -> None:
        r = self.s.post(f"{self.api}/api/v1/auth/login",
                        json={"email": email, "password": password})
        if r.status_code == 403:
            raise SystemExit("Login rejected (EMAIL_NOT_VERIFIED?). Register+verify once "
                             "(AUTH_EMAIL_DELIVERY=test). Body: " + r.text)
        r.raise_for_status()
        self.csrf = self.s.cookies.get("df_csrf")

    def _mutate_headers(self) -> dict:
        return {"x-csrf-token": self.csrf} if self.csrf else {}

    def _duckdb_field_names(self) -> list[str]:
        r = self.s.get(f"{self.api}/api/v1/datasource-types")
        r.raise_for_status()
        rows = _unwrap(r)
        for t in rows if isinstance(rows, list) else []:
            if isinstance(t, dict) and t.get("name") == "duckdb":
                return [p.get("name") for p in t.get("parameters", []) if isinstance(p, dict)]
        return ["path"]

    def register_duckdb_datasource(self, ds_id: str, name: str, duckdb_path: str) -> str:
        fields = self._duckdb_field_names()
        path_field = next((f for f in fields if "path" in f.lower() or "file" in f.lower()),
                          fields[0] if fields else "path")
        payload = {"id": ds_id, "name": name, "type": "duckdb",
                   "config": {path_field: os.path.abspath(duckdb_path)}}
        r = self.s.post(f"{self.api}/api/v1/datasources", json=payload, headers=self._mutate_headers())
        if r.status_code not in (200, 201, 409):
            raise SystemExit(f"datasource create failed [{r.status_code}]: {r.text}")
        self.s.post(f"{self.api}/api/v1/datasources/{ds_id}/introspect", headers=self._mutate_headers())
        deadline = time.time() + 120
        while time.time() < deadline:
            sr = self.s.get(f"{self.api}/api/v1/datasources/{ds_id}/schema")
            if sr.status_code == 200 and _unwrap(sr):
                return ds_id
            time.sleep(2)
        print(f"[warn] schema for {ds_id} not confirmed; continuing", file=sys.stderr)
        return ds_id

    def run(self, question: str, datasource_id: str) -> str:
        thread_id = f"kb-{uuid.uuid4().hex[:8]}"
        payload = {
            "method": "agent/run",
            "params": {"agentId": "dataFoundry"},
            "body": {
                "threadId": thread_id,
                "runId": f"run-{uuid.uuid4().hex[:8]}",
                "state": {},
                "messages": [{"id": f"m-{uuid.uuid4().hex[:8]}", "role": "user", "content": question}],
                "tools": [],
                "context": [],
                "forwardedProps": {"run_config": {
                    "activeDatasourceId": datasource_id,
                    "enabledDatasourceIds": [datasource_id],
                    "activeLlmProfileId": LLM_PROFILE,
                    "enabledKnowledgeIds": [],
                    "enabledMcpServerIds": [],
                    "enabledSkillIds": [],
                }},
            },
        }
        headers = {**self._mutate_headers(), "accept": "text/event-stream"}
        with self.s.post(f"{self.api}/api/copilotkit", json=payload,
                         headers=headers, stream=True, timeout=RUN_TIMEOUT_S) as resp:
            resp.raise_for_status()
            for _ in resp.iter_lines(decode_unicode=True):
                pass  # drain the AG-UI SSE stream to completion
        return self._final_answer(thread_id)

    def _final_answer(self, thread_id: str) -> str:
        r = self.s.get(f"{self.api}/api/v1/sessions/{thread_id}/conversation")
        r.raise_for_status()
        conv = _unwrap(r)
        msgs = conv.get("messages", conv) if isinstance(conv, dict) else conv
        texts: list[str] = []
        for m in msgs if isinstance(msgs, list) else []:
            if (m.get("role") or m.get("author")) in ("assistant", "agent"):
                c = m.get("contentText") or m.get("content")
                if isinstance(c, list):
                    c = "".join(p.get("text", "") for p in c if isinstance(p, dict))
                if isinstance(c, str) and c.strip():
                    texts.append(c.strip())
        if texts:
            return texts[-1]
        # No assistant text: surface the run failure instead of dumping the whole conversation.
        failed = [cp for cp in (conv.get("checkpoints") or [] if isinstance(conv, dict) else [])
                  if cp.get("status") == "failed"]
        return f"[DataFoundry run failed] {failed[-1].get('errorMessage')}" if failed else "[DataFoundry] no answer"


# ── Domain-lake ingestion ─────────────────────────────────────────────────────

def build_domain_duckdb(dataset_directory: str, out_path: str) -> str:
    """Consolidate a KramaBench domain lake into one DuckDB (one table per tabular file).

    Files it can't ingest are printed — that skip list is itself a finding about
    what the SQL-first model can't handle.
    """
    if duckdb is None:
        raise SystemExit("pip install duckdb")
    files = [p for p in sorted(glob.glob(os.path.join(dataset_directory, "**", "*"), recursive=True))
             if not os.path.isdir(p)]
    names = _unique_table_names(files)
    con = duckdb.connect(out_path)
    made, skipped = 0, []
    for path in files:
        name = names[path]
        rel = os.path.relpath(path, dataset_directory)
        ext = pathlib.Path(path).suffix.lower()
        try:
            if ext in (".csv", ".tsv", ".txt"):
                try:
                    con.execute(f'CREATE OR REPLACE TABLE "{name}" AS '
                                "SELECT * FROM read_csv_auto(?, sample_size=-1)", [path])
                    _fix_csv_header(con, name, path)
                except duckdb.InvalidInputException:
                    # Several KramaBench CSVs are Windows-1252 (curly quotes, en dashes in 0x80-0x9F),
                    # which DuckDB's latin-1 reader rejects; transcode to a UTF-8 copy first.
                    utf8_copy = out_path + ".utf8.csv"
                    with open(path, encoding="cp1252", errors="replace") as src, \
                            open(utf8_copy, "w", encoding="utf-8") as dst:
                        dst.write(src.read())
                    try:
                        con.execute(f'CREATE OR REPLACE TABLE "{name}" AS '
                                    "SELECT * FROM read_csv_auto(?, sample_size=-1)", [utf8_copy])
                        _fix_csv_header(con, name, utf8_copy)
                    finally:
                        os.remove(utf8_copy)
                made += 1
            elif ext in (".parquet", ".pq"):
                con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM read_parquet(?)', [path])
                made += 1
            elif ext == ".json":
                con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM read_json_auto(?)', [path])
                made += 1
            elif ext in (".xlsx", ".xls"):
                made += _load_workbook(con, path, name)  # one table per sheet; sheet 1 is often a README
            else:
                skipped.append(rel)
        except Exception as e:  # noqa: BLE001 — a load failure is also a finding
            skipped.append(f"{rel} ({str(e).splitlines()[0]})")
    con.close()
    print(f"[ingest] {made} tables built, {len(skipped)} files skipped -> {out_path}")
    for s in skipped[:50]:
        print("   skip:", s)
    return out_path


def _unique_table_names(files: list[str]) -> dict[str, str]:
    """Name tables by file stem, prefixing the parent folder when stems collide.

    Lakes like legal have e.g. 'Fraud data/Alabama.csv' and 'Identity Theft data/Alabama.csv';
    naming by stem alone would silently overwrite one with the other.
    """
    stems = {p: _safe_ident(pathlib.Path(p).stem) for p in files}
    counts: dict[str, int] = {}
    for s in stems.values():
        counts[s] = counts.get(s, 0) + 1
    names: dict[str, str] = {}
    used: set[str] = set()
    for p in files:
        name = stems[p]
        if counts[name] > 1:
            name = f"{_safe_ident(pathlib.Path(p).parent.name)}__{name}"
        base, n = name, 2
        while name.lower() in used:
            name, n = f"{base}_{n}", n + 1
        used.add(name.lower())
        names[p] = name
    return names


HEADER_SCAN_ROWS = 25


def _split_csv_line(line: str, delimiter: str) -> list[str]:
    """Split on the delimiter, honouring simple double-quoted fields."""
    cells, cell, quoted = [], "", False
    for char in line.rstrip("\r\n"):
        if char == '"':
            quoted = not quoted
        elif char == delimiter and not quoted:
            cells.append(cell.strip().strip('"'))
            cell = ""
        else:
            cell += char
    cells.append(cell.strip().strip('"'))
    return cells


def _best_delimiter(lines: list[str]) -> str:
    """The delimiter that splits every line into the same number of fields.

    Frequency alone is wrong for files like nifc_wildfires.csv: it is tab separated but
    its numbers contain thousands separators, so commas outnumber tabs and the sniffer
    shreds each row. Consistency of the field count identifies the true delimiter.
    """
    def score(delimiter: str) -> tuple[int, int]:
        counts = [len(_split_csv_line(line, delimiter)) for line in lines if line.strip()]
        if not counts:
            return (0, 0)
        common = max(set(counts), key=counts.count)
        return (counts.count(common) if common > 1 else 0, common)

    return max([",", "\t", ";", "|"], key=score)


def _fix_csv_header(con, name: str, path: str) -> None:
    """Re-read a CSV whose header or delimiter DuckDB got wrong.

    Two shapes appear in the KramaBench lakes: title/licence lines before the header
    (noaa_wildfires_monthly_stats.csv), and a tab-separated file whose values contain
    commas (nifc_wildfires.csv). Both leave the real header sitting in the data.
    """
    columns = [r[0] for r in con.execute(
        "select column_name from information_schema.columns where table_name = ?", [name]).fetchall()]
    degenerate = (
        len(columns) <= 1
        or sum(1 for c in columns if re.fullmatch(r"column\d+", c)) > len(columns) / 2
        or any("\t" in c for c in columns)
        or sum(1 for c in columns if _looks_numeric(c)) > len(columns) / 2
    )
    if not degenerate:
        return
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = [line for _, line in zip(range(HEADER_SCAN_ROWS), handle)]
    if not lines:
        return
    delimiter = _best_delimiter(lines)
    rows = [_split_csv_line(line, delimiter) for line in lines]
    skip = detect_header_row(rows)
    # A file of pure data (e.g. the SILSO sunspot series) has no header-like row at all;
    # reading one anyway would consume a data row and name the columns after its values.
    headed = _header_row_score(rows[skip]) > 0 if skip < len(rows) else False
    con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM '
                "read_csv_auto(?, sample_size=-1, delim=?, skip=?, header=?)",
                [path, delimiter, skip if headed else 0, headed])
    print(f"[ingest] {name}: re-read with delimiter {delimiter!r}"
          + (f", skipping {skip} preamble row(s)" if headed and skip else "")
          + ("" if headed else ", no header row (columns named positionally)"))


def _header_row_score(values: list) -> float:
    """How much a row looks like a header: wide, textual, and all names distinct.

    Title and unit rows lose out: a title fills one cell (narrow), a unit row such as
    '(ppm) (ppm) (ppm)' repeats itself (not distinct), and a data row is mostly numeric.
    """
    cells = [v for v in values if v is not None and str(v).strip() != "" and str(v) != "nan"]
    if len(cells) < 2:
        return 0.0
    labels = [str(v).strip() for v in cells]
    textual = sum(1 for v in cells if isinstance(v, str) and not _looks_numeric(v))
    distinct = len(set(labels)) / len(labels)
    return len(cells) * (textual / len(cells)) * distinct


def _looks_numeric(value: str) -> bool:
    try:
        float(str(value).replace(",", ""))
        return True
    except ValueError:
        return False


def detect_header_row(rows: list[list]) -> int:
    """Index of the most header-like row among the first HEADER_SCAN_ROWS, else 0.

    KramaBench workbooks (climateMeasurements.xlsx, for example) carry a title, a note
    and a units row before the real header. Reading row 0 as the header turns every
    column into 'Unnamed: N' and buries the real names in the data, which forces the
    agent to guess which column is which.
    """
    best_index, best_score = 0, 0.0
    for index, row in enumerate(rows[:HEADER_SCAN_ROWS]):
        score = _header_row_score(list(row))
        # A header must be followed by data.
        if score > best_score and index + 1 < len(rows) and _header_row_score(list(rows[index + 1])) >= 0:
            best_index, best_score = index, score
    return best_index


def _load_workbook(con, path: str, name: str) -> int:
    """Load every sheet of an Excel workbook as its own table; returns tables created."""
    import pandas as pd  # openpyxl engine; KramaBench's biomedical workbooks put a README on sheet 1

    raw_sheets = pd.read_excel(path, sheet_name=None, header=None)
    made = 0
    for sheet, raw in raw_sheets.items():
        table = name if len(raw_sheets) == 1 else f"{name}__{_safe_ident(str(sheet))}"
        if raw.shape[1] == 1:
            # One-column sheets are bare lists (e.g. gene names) with no header row.
            df = raw.rename(columns={raw.columns[0]: "value"})
        else:
            rows = raw.values.tolist()
            header_index = detect_header_row(rows)
            if rows and _header_row_score(rows[header_index]) == 0:
                # No header-like row: keep every row as data and name columns positionally.
                df = raw.rename(columns={c: f"col_{c}" for c in raw.columns})
            else:
                # Re-read through pandas so duplicate names get its .1/.2 suffixes, which is
                # what the KramaBench reference pipelines refer to (e.g. 'Age_ky.1').
                df = pd.read_excel(path, sheet_name=sheet, header=header_index)
                df = df.dropna(axis=1, how="all").dropna(axis=0, how="all")
                if header_index > 0:
                    print(f"[ingest] {table}: header row {header_index} "
                          f"({', '.join(str(c) for c in df.columns[:6])}…)")
        df.columns = [str(c) for c in df.columns]
        for col in df.columns[df.dtypes == object]:
            df[col] = df[col].astype("string")  # mixed-type columns break DuckDB's type inference
        con.register("_sheet", df)
        con.execute(f'CREATE OR REPLACE TABLE "{table}" AS SELECT * FROM _sheet')
        con.unregister("_sheet")
        made += 1
    return made


ANSWER_FORMAT_INSTRUCTION = (
    "\n\nWhen you are done, end your response with one final line exactly of the form\n"
    "FINAL_ANSWER: <answer>\n"
    "where <answer> is only the value: a bare number (no units, no % sign, no thousands separators), "
    "a short string, or a JSON list such as [\"a\", \"b\"]."
)

_FINAL_ANSWER_RE = re.compile(r"FINAL_ANSWER\s*[:：]\s*(.+)", re.IGNORECASE)


def extract_final_answer(text: str) -> str:
    """Pull the bare value KramaBench's exact-match metrics need out of a prose response."""
    matches = _FINAL_ANSWER_RE.findall(text or "")
    if not matches:
        return text  # no marker: fall back to the full response (still gradable by llm_paraphrase)
    value = matches[-1].strip().strip("`*").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def _safe_ident(name: str) -> str:
    keep = "".join(c if c.isalnum() else "_" for c in name).strip("_")
    return keep or "t"


# ── KramaBench System implementation ──────────────────────────────────────────

class DataFoundrySUT(System):
    """KramaBench System backed by DataFoundry (governed read-only SQL)."""

    def __init__(self, system_name: str = "DataFoundrySUT", verbose: bool = False, *args, **kwargs):
        super().__init__(system_name, verbose=verbose, *args, **kwargs)
        self.out = kwargs.get("system_output_directory") or os.path.join(os.getcwd(), "system_scratch", system_name)
        os.makedirs(self.out, exist_ok=True)
        self.client: DataFoundryClient | None = None      # lazy: auth happens on first use
        self._ds_id: str | None = None

    def _ensure_client(self) -> DataFoundryClient:
        if self.client is None:
            self.client = DataFoundryClient(API, os.environ["DF_EMAIL"], os.environ["DF_PASSWORD"])
        return self.client

    def process_dataset(self, dataset_directory) -> None:
        client = self._ensure_client()
        # KramaBench lakes all live at data/<domain>/input, so name by the domain, not "input";
        # otherwise every domain shares one cached DuckDB and one datasource id.
        lake = pathlib.Path(os.path.normpath(str(dataset_directory)))
        tag = _safe_ident(lake.parent.name if lake.name.lower() == "input" else lake.name)
        duckdb_path = os.path.join(self.out, f"{tag}.duckdb")
        if not os.path.exists(duckdb_path):
            build_domain_duckdb(str(dataset_directory), duckdb_path)
        self._ds_id = client.register_duckdb_datasource(f"kb-{tag}", f"KramaBench {tag}", duckdb_path)
        self.dataset_directory = dataset_directory

    def serve_query(self, query: str, query_id: str = "q-0", subset_files=None) -> dict:
        client = self._ensure_client()
        if self._ds_id is None:
            raise RuntimeError("process_dataset must run before serve_query")
        try:
            full_text = client.run(query + ANSWER_FORMAT_INSTRUCTION, self._ds_id)
        except Exception as e:  # noqa: BLE001 — a run failure is a scored outcome, not a crash
            full_text = f"[DataFoundry error] {e}"
        answer = extract_final_answer(full_text)
        if self.verbose:
            print(f"DataFoundrySUT: {query_id} -> {answer!r}")
        return {
            "explanation": {"answer": answer, "id": query_id, "full_response": full_text},
            "pipeline_code": "",   # DataFoundry emits SQL+artifacts, not a Python pipeline (use --no_pipeline_eval)
            "token_usage": 0, "token_usage_input": 0, "token_usage_output": 0,
        }


# ── Standalone smoke path (run outside KramaBench to test one task) ────────────

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="DataFoundry SUT smoke test")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--domain-dir", required=True, help="path to one domain's data lake")
    ap.add_argument("--question", required=True)
    args = ap.parse_args()
    sut = DataFoundrySUT(verbose=True)
    sut.process_dataset(args.domain_dir)
    out = sut.serve_query(args.question, "smoke-0")
    print("\n=== ANSWER ===\n" + out["explanation"]["answer"])
