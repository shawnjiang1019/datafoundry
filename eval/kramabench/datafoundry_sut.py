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
    DF_RETRY_ATTEMPTS=4            (retries for provider rate limits / unreachable API)
    DF_RETRY_BASE_S=30             (first backoff delay; doubles each attempt)
    DTRAIL_ASSUME=1 + DTRAIL_API_URL=http://127.0.0.1:8061 (+ DTRAIL_TOKEN)
                                   (submit each question to d-trail with assume=true and the domain's
                                    CSV tables, export_duckdb_tables.py --format csv, BEFORE the
                                    DataFoundry run; the receipt lands in explanation.assumptions)
    DTRAIL_TO_AGENT=1              (default; also pass the receipt to the agent as run_config
                                    assumptionReceipt, its "assumption ledger"; 0 = A/B baseline)
    DF_MCP_SERVER_IDS=             (comma-separated MCP server ids to enable per run, e.g. the
                                    DataLink server; empty = none, the semantic step falls back
                                    to the physical schema)
DataFoundry must be running (npm run start) with a verified account + working model profile.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import pathlib
import random
import re
import sys
import time
import uuid

import requests

try:
    import duckdb
except ImportError:
    duckdb = None

# The ingest package ships alongside this SUT file (eval/kramabench/ds_ingest,
# and copied to KramaBench/systems/ with the SUT). Make it importable from the
# direct smoke path and from inside the harness.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from ds_ingest import load_by_extension
    from ds_ingest.registry import DEFAULT_TABLE_NAME, SUPPORTED_EXTENSIONS
except ImportError:  # the SUT still imports standalone for --smoke without the package
    load_by_extension = None
    DEFAULT_TABLE_NAME = {}
    SUPPORTED_EXTENSIONS = frozenset()

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
RETRY_ATTEMPTS = int(os.environ.get("DF_RETRY_ATTEMPTS", "4"))
RETRY_BASE_S = float(os.environ.get("DF_RETRY_BASE_S", "30"))
RETRY_MAX_DELAY_S = float(os.environ.get("DF_RETRY_MAX_DELAY_S", "300"))
MCP_SERVER_IDS = [s.strip() for s in os.environ.get("DF_MCP_SERVER_IDS", "").split(",") if s.strip()]
DTRAIL_API_URL = os.environ.get("DTRAIL_API_URL", "").rstrip("/")
DTRAIL_TOKEN = os.environ.get("DTRAIL_TOKEN", "")
DTRAIL_ASSUME = os.environ.get("DTRAIL_ASSUME", "0") == "1"
# assume_only: d-trail compiles the question and classifies its assumptions against the
# sources without grounding or executing it. On by default because d-trail's grounder
# refuses multi-source requests without explicit joins (409 at grounding), and every
# domain is submitted as many tables. DTRAIL_ASSUME_ONLY=0 asks for the full d-trail run.
DTRAIL_ASSUME_ONLY = os.environ.get("DTRAIL_ASSUME_ONLY", "1") == "1"
# CSV copies of each domain's tables (eval/kramabench/export_duckdb_tables.py --format csv);
# d-trail reads csv/json/jsonl/sqlite only, not the DuckDB files or the raw Excel lake.
DTRAIL_SOURCES_DIR = os.environ.get(
    "DTRAIL_SOURCES_DIR", os.path.join(os.getcwd(), "system_scratch", "dtrail_sources"))
DTRAIL_WORKSPACE = os.environ.get("DTRAIL_WORKSPACE", "kramabench")
DTRAIL_TIMEOUT_S = float(os.environ.get("DTRAIL_TIMEOUT", "900"))
DTRAIL_READ_TIMEOUT_S = float(os.environ.get("DTRAIL_READ_TIMEOUT", "120"))
# Hand the pre-run receipt to the agent (run_config.assumptionReceipt); 0 keeps it out for A/B runs.
DTRAIL_TO_AGENT = os.environ.get("DTRAIL_TO_AGENT", "1") == "1"

# A failed run is reported as answer text, not raised, so retry decisions read the
# text. Gate on these prefixes first: a task answer may legitimately contain the
# word "rate limit", but only a failure report starts with one of these.
FAILURE_PREFIXES = ("[DataFoundry run failed]", "[DataFoundry error]")

# Provider-side faults that a later attempt can plausibly survive. Deliberately
# excludes "terminated" (a 30-minute stream death) and model/SQL mistakes, which
# repeat deterministically and would just burn the budget twice.
TRANSIENT_MARKERS = (
    ("rate limit", "rate limited"),
    ("too many requests", "rate limited"),
    ("getaddrinfo", "provider unreachable"),
    ("cannot connect to api", "provider unreachable"),
    ("econnreset", "connection reset"),
    ("socket hang up", "connection dropped"),
)


def transient_failure_reason(text: str) -> str | None:
    """Return why `text` is a retryable provider failure, or None if it is an answer."""
    if not text.startswith(FAILURE_PREFIXES):
        return None
    lowered = text.lower()
    for marker, reason in TRANSIENT_MARKERS:
        if marker in lowered:
            return reason
    return None


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
        self._last_thread_id: str | None = None
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

    def run(self, question: str, datasource_id: str, assumption_receipt: dict | None = None) -> str:
        thread_id = f"kb-{uuid.uuid4().hex[:8]}"
        run_config = {
            "activeDatasourceId": datasource_id,
            "enabledDatasourceIds": [datasource_id],
            "activeLlmProfileId": LLM_PROFILE,
            "enabledKnowledgeIds": [],
            "enabledMcpServerIds": MCP_SERVER_IDS,
            "enabledSkillIds": [],
        }
        if DTRAIL_ASSUME:
            run_config["assumeVerification"] = True
        if assumption_receipt:
            run_config["assumptionReceipt"] = assumption_receipt
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
                "forwardedProps": {"run_config": run_config},
            },
        }
        self._last_thread_id = thread_id
        headers = {**self._mutate_headers(), "accept": "text/event-stream"}
        with self.s.post(f"{self.api}/api/copilotkit", json=payload,
                         headers=headers, stream=True, timeout=RUN_TIMEOUT_S) as resp:
            resp.raise_for_status()
            for _ in resp.iter_lines(decode_unicode=True):
                pass  # drain the AG-UI SSE stream to completion
        return self._final_answer(thread_id)

    def _conversation(self, thread_id: str) -> dict:
        r = self.s.get(f"{self.api}/api/v1/sessions/{thread_id}/conversation")
        r.raise_for_status()
        return _unwrap(r)

    def _final_answer(self, thread_id: str) -> str:
        conv = self._conversation(thread_id)
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

    def executed_sql(self) -> list[str]:
        """Every statement the last run sent through run_sql_readonly, from the session trace DAG."""
        if not self._last_thread_id:
            return []
        r = self.s.get(f"{self.api}/api/v1/sessions/{self._last_thread_id}/trace-dag",
                       params={"limit": 500})
        r.raise_for_status()
        statements: list[str] = []
        for node in (_unwrap(r) or {}).get("nodes") or []:
            detail = node.get("detail") if isinstance(node, dict) else None
            if not isinstance(detail, dict) or detail.get("toolName") != "run_sql_readonly":
                continue
            args = detail.get("arguments")
            if not isinstance(args, dict):
                try:
                    args = json.loads(detail.get("argumentsText") or "")
                except ValueError:
                    args = None
            sql = args.get("sql") if isinstance(args, dict) else None
            if isinstance(sql, str) and sql.strip():
                statements.append(sql)
        return statements

    def read_assumptions(self) -> dict | None:
        """Best-effort readback of the d-trail assumptions receipt for the last run.

        The receipt is advisory and only present when d-trail classified assumptions
        (`DTRAIL_ASSUME=1` with a configured service); missing metadata yields None.
        """
        if not (DTRAIL_ASSUME and DTRAIL_API_URL) or not self._last_thread_id:
            return None
        task_id = self._find_dtrail_task_id(self._conversation(self._last_thread_id))
        if not task_id:
            return None
        headers = {"Accept": "application/json"}
        if DTRAIL_TOKEN:
            headers["Authorization"] = f"Bearer {DTRAIL_TOKEN}"
        r = requests.get(f"{DTRAIL_API_URL}/runs/{task_id}/assumptions", headers=headers, timeout=30)
        return r.json() if r.status_code == 200 else None

    @staticmethod
    def _find_dtrail_task_id(conv: dict) -> str | None:
        candidates = []
        for cp in conv.get("checkpoints") or []:
            md = cp.get("metadata") if isinstance(cp, dict) else None
            if isinstance(md, dict):
                candidates.append(md.get("dtrail_task_id"))
        for m in conv.get("messages") or [] if isinstance(conv, dict) else []:
            content = m.get("content", "")
            if not isinstance(content, str):
                continue
            found = re.search(r'"dtrail_task_id"\s*:\s*"([^"]+)"', content)
            if found:
                candidates.append(found.group(1))
        for c in candidates:
            if isinstance(c, str) and c.strip():
                return c.strip()
        return None


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
    con = duckdb.connect(out_path)
    made, skipped = 0, []
    files, grouped = _group_file_families(con, files, dataset_directory)
    made += grouped
    names = _unique_table_names(files)
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
            elif ext in (".html", ".htm"):
                made += _load_html_tables(con, path, name)
            elif load_by_extension is not None and ext in SUPPORTED_EXTENSIONS:
                outcome = _load_special(con, path, rel)
                if outcome < 0:
                    skipped.append(f"{rel} (no data rows parsed)")
                else:
                    made += outcome
            else:
                skipped.append(rel)
        except Exception as e:  # noqa: BLE001 — a load failure is also a finding
            skipped.append(f"{rel} ({str(e).splitlines()[0]})")
    con.close()
    print(f"[ingest] {made} tables built, {len(skipped)} files skipped -> {out_path}")
    for s in skipped[:50]:
        print("   skip:", s)
    return out_path


def _load_special(con, path: str, rel: str) -> int:
    """Ingest a file type with no native DuckDB reader (tle/sp3/lst/dat/npz/cdf).

    Same-family files (OMNI2 .dat, TLE, POD .sp3) append to one table keyed by
    the extension's default name; ``source_file`` is stamped with the relative
    path so SQL can isolate a specific year/satellite.  Files that parse to no
    rows (e.g. a non-OMNI .dat) return -1 and are recorded as skipped rather
    than creating an empty table.
    """
    suffix = pathlib.Path(path).suffix.lower()
    rows = load_by_extension(path)
    if not rows:
        return -1
    table = _special_table_name(suffix, rel)
    for row in rows:
        row["source_file"] = rel
    import pandas as pd

    frame = pd.DataFrame(rows)
    con.register("_special", frame)
    identifier = f'"{_safe_ident(table)}"'
    existing = {t[0].lower() for t in con.execute(
        "select table_name from information_schema.tables where table_schema='main'").fetchall()}
    if table.lower() in existing:
        con.execute(f"INSERT INTO {identifier} SELECT * FROM _special")
    else:
        con.execute(f"CREATE TABLE {identifier} AS SELECT * FROM _special")
    con.unregister("_special")
    return 1


def _special_table_name(suffix: str, rel: str) -> str:
    """Table name for a ds_ingest file: stem for one-offs, fixed family name otherwise."""
    if suffix in (".npz", ".cdf"):
        return _safe_ident(pathlib.Path(rel).stem)
    return DEFAULT_TABLE_NAME.get(suffix, "special")


FAMILY_MIN_FILES = 3


def _family_key(path: str, dataset_directory: str) -> tuple[str, str, str]:
    """(directory, shape, extension) for a file, where shape drops dates and ids.

    'Sat_Density/swarma-wu113-20141230_to_20150102.csv' and its 714 siblings share a
    shape; 'water-body-testing-2002.csv' and its 21 siblings do too.
    """
    relative = os.path.relpath(path, dataset_directory)
    directory = os.path.dirname(relative)
    stem = pathlib.Path(relative).stem
    shape = re.sub(r"\d{4}-\d{2}-\d{2}", "<date>", stem)
    shape = re.sub(r"\d{8}", "<date>", shape)
    shape = re.sub(r"\d{4,}", "<num>", shape)
    shape = re.sub(r"(?<=[A-Za-z_])\d{2,3}\b", "<id>", shape)
    return directory, shape, pathlib.Path(relative).suffix.lower()


def _family_table_name(directory: str, shape: str) -> str:
    """Readable table name for a family: the shape without placeholders, folder-qualified."""
    base = re.sub(r"<[a-z]+>", " ", shape)
    base = _safe_ident(" ".join(base.split()).strip(" _-")) or "files"
    folder = _safe_ident(os.path.basename(directory))
    if folder and folder.lower() not in ("", ".", "input") and folder.lower() != base.lower():
        return f"{folder}__{base}"
    return base


def _group_file_families(con, files: list[str], dataset_directory: str) -> tuple[list[str], int]:
    """Union same-shaped files into one table each; return the files left to ingest singly.

    A lake often ships one logical table cut into shards — 715 `swarma-*` files for one
    satellite series, 104 `State_MSA_*` files one per state, 22 `water-body-testing-<year>`
    files. One table per file makes the obvious question ("average density in 2015") a
    walk over hundreds of tables, which is how an astronomy run spent 40 queries and hit
    the run timeout without reaching any analysis.

    Only files that share a directory, a name shape and an exact column signature are
    merged (`union_by_name=false` makes DuckDB refuse a mismatch, and the family then
    falls back to one table per file). Each row keeps its `source_file`.
    """
    # A subdirectory usually holds one dataset cut into pieces, whatever the pieces are
    # called ('State MSA Fraud and Other data/Alabama.csv'), so files there group by
    # directory. At the top level, where unrelated datasets sit side by side, only files
    # that share a name shape group ('water-body-testing-<year>.csv').
    by_directory: dict[tuple[str, str], list[str]] = {}
    for path in files:
        directory, _, extension = _family_key(path, dataset_directory)
        by_directory.setdefault((directory, extension), []).append(path)

    groups: dict[tuple[str, str, str], list[str]] = {}
    for (directory, extension), members in by_directory.items():
        if directory and len(members) >= FAMILY_MIN_FILES:
            groups[(directory, os.path.basename(directory), extension)] = members
            continue
        for path in members:
            groups.setdefault(_family_key(path, dataset_directory), []).append(path)

    remaining, made = [], 0
    for (directory, shape, extension), members in groups.items():
        if len(members) < FAMILY_MIN_FILES or extension not in (".csv", ".tsv", ".txt", ".parquet", ".pq"):
            remaining.extend(members)
            continue
        table = _family_table_name(directory, shape)
        reader = "read_parquet" if extension in (".parquet", ".pq") else "read_csv_auto"
        options = "filename = true, union_by_name = false" + ("" if reader == "read_parquet" else ", sample_size = -1")
        listed = ", ".join("'" + member.replace("'", "''") + "'" for member in sorted(members))
        try:
            con.execute(f'CREATE OR REPLACE TABLE "{table}" AS '
                        f"SELECT * FROM {reader}([{listed}], {options})")
            con.execute(f'ALTER TABLE "{table}" RENAME COLUMN filename TO source_file')
            rows = con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            print(f"[ingest] {table}: {len(members)} files unioned into one table ({rows} rows)")
            made += 1
        except Exception as error:  # noqa: BLE001 — mixed schemas stay one table per file
            print(f"[ingest] {table}: kept {len(members)} files separate ({str(error).splitlines()[0][:90]})")
            remaining.extend(members)
    return sorted(remaining), made


def _load_html_tables(con, path: str, name: str) -> int:
    """Load every table in an HTML page (legal's metropolitan_statistics.html, for example)."""
    import pandas as pd

    frames = [frame for frame in pd.read_html(path) if frame.shape[0] >= 5 and frame.shape[1] >= 2]
    for index, frame in enumerate(frames):
        frame.columns = [str(column) for column in frame.columns]
        for column in frame.columns[frame.dtypes == object]:
            frame[column] = frame[column].astype("string")
        table = name if len(frames) == 1 else f"{name}__t{index + 1}"
        con.register("_html", frame)
        con.execute(f'CREATE OR REPLACE TABLE "{table}" AS SELECT * FROM _html')
        con.unregister("_html")
    print(f"[ingest] {name}: {len(frames)} HTML table(s)")
    return len(frames)


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
    try:
        con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM '
                    "read_csv_auto(?, sample_size=-1, delim=?, skip=?, header=?)",
                    [path, delimiter, skip if headed else 0, headed])
    except Exception as error:  # noqa: BLE001 — keep whatever the first read produced
        print(f"[ingest] {name}: kept the sniffed layout ({str(error).splitlines()[0][:80]})")
        return
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


_TABLE_REF = re.compile(r'\b(?:from|join)\s+((?:"[^"]+"|\w+)(?:\s*\.\s*(?:"[^"]+"|\w+))*)', re.IGNORECASE)


def referenced_tables(statements: list[str], known: list[str]) -> list[str]:
    """Names from `known` that follow FROM/JOIN in any statement, in `known` order.

    Matching against the exported tables drops CTE names, subquery aliases and
    schema prefixes (main.t) without parsing SQL.
    """
    hits = {
        ref.split(".")[-1].strip().strip('"').lower()
        for sql in statements
        for ref in _TABLE_REF.findall(sql)
    }
    return [name for name in known if name.lower() in hits]


def _safe_ident(name: str) -> str:
    keep = "".join(c if c.isalnum() else "_" for c in name).strip("_")
    return keep or "t"


# ── d-trail assumption check ──────────────────────────────────────────────────

class DtrailAssumptionClient:
    """Submit a benchmark question to d-trail with `assume: true` and read the receipt back.

    Runs before the DataFoundry run, outside it: the receipt is stored beside the answer
    and (DTRAIL_TO_AGENT=1) handed to the agent as its assumption ledger. d-trail gets, as
    CSV sources, the tables named by `executed_sql` when given, else the whole domain
    (fine with assume_only; a full grounding run stops at "multiple sources without a join").
    Every failure is returned as data so a d-trail problem cannot fail a benchmark task.
    """

    # d-trail's Budget defaults (dtrail/contracts.py); raised per request to fit the
    # largest exported table so a big source is read rather than rejected.
    DEFAULT_MAX_ROWS = 100_000
    DEFAULT_MAX_BYTES = 50_000_000

    def __init__(self, api_url: str, token: str = "", sources_dir: str = DTRAIL_SOURCES_DIR,
                 workspace_id: str = DTRAIL_WORKSPACE):
        self.api = api_url.rstrip("/")
        self.sources_dir = sources_dir
        self.workspace_id = workspace_id
        self.s = requests.Session()
        self.s.headers["Accept"] = "application/json"
        if token:
            self.s.headers["Authorization"] = f"Bearer {token}"

    def _manifest(self, domain: str) -> tuple[list[dict], dict]:
        folder = pathlib.Path(self.sources_dir) / domain
        manifest_path = folder / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(
                f"no CSV export for {domain!r} at {folder}; run "
                f"eval/kramabench/export_duckdb_tables.py --format csv {domain}")
        tables = json.loads(manifest_path.read_text(encoding="utf-8"))["tables"]
        sources = [{"name": t["table"], "kind": "csv", "path": str((folder / t["file"]).resolve())}
                   for t in tables]
        budget = {
            "max_rows": max(self.DEFAULT_MAX_ROWS, max((t["rows"] for t in tables), default=0) + 1),
            "max_bytes": max(self.DEFAULT_MAX_BYTES, max((t["bytes"] for t in tables), default=0) + 1),
            "timeout_seconds": DTRAIL_READ_TIMEOUT_S,
        }
        return sources, budget

    def check(self, question: str, domain: str, executed_sql: list[str] | None = None) -> dict:
        result: dict = {"mode": "assume_only" if DTRAIL_ASSUME_ONLY else "direct", "domain": domain,
                        "task_id": None, "run_status": None, "receipt": None}
        try:
            sources, budget = self._manifest(domain)
            queried = referenced_tables(executed_sql or [], [s["name"] for s in sources])
            result["source_selection"] = "queried" if queried else "all"
            if queried:
                sources = [s for s in sources if s["name"] in queried]
            result["sources"] = [s["name"] for s in sources]
            r = self.s.post(f"{self.api}/runs", timeout=DTRAIL_TIMEOUT_S, json={
                "text": question, "sources": sources, "assume": True,
                "assume_only": DTRAIL_ASSUME_ONLY,
                "workspace_id": self.workspace_id, "budget": budget})
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code != 200:
                # 409 WAITING_HUMAN (grounding asked a question), 422 MODEL_UNAVAILABLE / a
                # refuted assumption, 4xx/5xx otherwise: keep d-trail's own code and message.
                result["run_status"] = body.get("code") or f"HTTP_{r.status_code}"
                result["error"] = {"http": r.status_code, **{k: body.get(k) for k in ("code", "message", "stage")}}
                return result
            result["task_id"] = body.get("task_id")
            result["run_status"] = body.get("status")
            if not result["task_id"]:
                result["error"] = {"message": "d-trail returned no task_id"}
                return result
            a = self.s.get(f"{self.api}/runs/{result['task_id']}/assumptions", timeout=60)
            if a.status_code == 200:
                result["receipt"] = a.json()
            else:
                # 404: no receipt, usually the service has no model configured
                # (DTRAIL_MODEL_URL / DTRAIL_MODEL), so no classifier ran.
                result["error"] = {"http": a.status_code, "message": a.text[:300]}
        except Exception as e:  # noqa: BLE001 — advisory: report, never fail the task
            result["error"] = {"message": f"{type(e).__name__}: {e}"}
        return result


def agent_receipt(result: dict | None) -> dict | None:
    """The classifier receipt to hand the agent, or None; drops the raw conditioner reply."""
    receipt = (result or {}).get("receipt")
    inner = receipt.get("assumptions") if isinstance(receipt, dict) else None
    if not isinstance(inner, dict):  # GET /runs/{id}/assumptions wraps it as {task_id, assumptions}
        return None
    inner = {k: v for k, v in inner.items() if k != "conditioner_reply"}
    if not inner.get("trees"):
        return None
    inner.setdefault("task_id", receipt.get("task_id"))
    return inner


# ── KramaBench System implementation ──────────────────────────────────────────

class DataFoundrySUT(System):
    """KramaBench System backed by DataFoundry (governed read-only SQL)."""

    def __init__(self, system_name: str = "DataFoundrySUT", verbose: bool = False, *args, **kwargs):
        super().__init__(system_name, verbose=verbose, *args, **kwargs)
        self.out = kwargs.get("system_output_directory") or os.path.join(os.getcwd(), "system_scratch", system_name)
        os.makedirs(self.out, exist_ok=True)
        self.client: DataFoundryClient | None = None      # lazy: auth happens on first use
        self._ds_id: str | None = None
        self._domain: str | None = None
        self.dtrail = (DtrailAssumptionClient(DTRAIL_API_URL, DTRAIL_TOKEN)
                       if DTRAIL_ASSUME and DTRAIL_API_URL else None)

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
        self._domain = tag
        self.dataset_directory = dataset_directory

    def _run_with_backoff(self, question: str, assumption_receipt: dict | None = None) -> str:
        """Run one task, retrying provider rate limits with exponential backoff.

        Without this a single 429 cascades: the limiter stays tripped, KramaBench
        immediately starts the next task into it, and a whole domain dies in
        seconds (8 astronomy tasks were lost in 8s this way). Retrying in place
        spends wall time instead of tasks.
        """
        client = self._ensure_client()
        assert self._ds_id is not None
        full_text = ""
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                full_text = client.run(question, self._ds_id, assumption_receipt)
            except Exception as e:  # noqa: BLE001 — a run failure is a scored outcome, not a crash
                full_text = f"[DataFoundry error] {e}"
            reason = transient_failure_reason(full_text)
            if reason is None or attempt == RETRY_ATTEMPTS:
                break
            # Equal jitter: half the delay is fixed so a tripped limiter always gets
            # real recovery time, half is random so parallel domains do not retry in
            # lockstep and re-trip it together.
            ceiling = min(RETRY_MAX_DELAY_S, RETRY_BASE_S * 2 ** (attempt - 1))
            delay = ceiling / 2 + random.uniform(0, ceiling / 2)
            print(f"[retry] {reason} (attempt {attempt}/{RETRY_ATTEMPTS}); "
                  f"sleeping {delay:.0f}s", file=sys.stderr, flush=True)
            time.sleep(delay)
        return full_text

    def serve_query(self, query: str, query_id: str = "q-0", subset_files=None) -> dict:
        self._ensure_client()
        if self._ds_id is None:
            raise RuntimeError("process_dataset must run before serve_query")
        assumptions = None
        if self.dtrail is not None and self._domain:
            # Before the run, so the agent can plan around it. The bare question, without
            # the FINAL_ANSWER formatting instruction; no SQL yet, so the whole domain.
            assumptions = self.dtrail.check(query, self._domain)
            if self.verbose:
                summary = (agent_receipt(assumptions) or {}).get("summary")
                print(f"DataFoundrySUT: {query_id} d-trail {assumptions.get('run_status')} "
                      f"task={assumptions.get('task_id')} summary={summary} error={assumptions.get('error')}")
        receipt = agent_receipt(assumptions) if DTRAIL_TO_AGENT else None
        full_text = self._run_with_backoff(query + ANSWER_FORMAT_INSTRUCTION, receipt)
        answer = extract_final_answer(full_text)
        explanation = {"answer": answer, "id": query_id, "full_response": full_text}
        if assumptions is not None:
            explanation["assumptions"] = assumptions
        else:
            assumptions = self.client.read_assumptions()  # receipt recorded by DataFoundry, if any
            if assumptions is not None:
                explanation["assumptions"] = assumptions
        if self.verbose:
            print(f"DataFoundrySUT: {query_id} -> {answer!r}")
        return {
            "explanation": explanation,
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
