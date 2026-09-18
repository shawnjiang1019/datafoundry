"""
DataFoundry-as-KramaBench-SUT harness (scaffold).

Goal: run KramaBench tasks with DataFoundry as the System-Under-Test, so a poor
score tells us *where* DataFoundry's governed SQL-first model breaks down.

Architecture (see notes/gap-analysis.md item 3/5):
  KramaBench owns iteration + scoring  ->  `python evaluate.py --sut DataFoundrySUT`
  This file owns: auth -> ingest domain lake into DuckDB -> register datasource
                  -> drive one agent run over /api/copilotkit -> read the answer back.

You must wire three things (marked  # WIRE  below) against your own checkout:
  1. SUT method name/signature  — reconcile `DataFoundrySUT.solve` with benchmark/Benchmark.
  2. A reachable model profile   — `activeLlmProfileId` must point at a working LLM
                                   (the shipped .env pointed at an internal Huawei gateway
                                   that does not resolve off-corp; fix the model profile first).
  3. Auth env                    — DF_EMAIL / DF_PASSWORD for a verified local account
                                   (AUTH_EMAIL_DELIVERY=test makes registration email-free).

Prereqs: `pip install requests duckdb`, DataFoundry API up on DF_API (default :8787).

Run the standalone smoke path first, before touching KramaBench:
  python test.py --smoke --domain-dir path/to/one/domain/lake --question "..."
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import pathlib
import sys
import time
import uuid

import requests

try:
    import duckdb
except ImportError:  # ingestion is optional if you register data another way
    duckdb = None

API = os.environ.get("DF_API", "http://127.0.0.1:8787").rstrip("/")
LLM_PROFILE = os.environ.get("DF_LLM_PROFILE", "server-default")  # WIRE #2
RUN_TIMEOUT_S = int(os.environ.get("DF_RUN_TIMEOUT", "600"))


# ── DataFoundry client ────────────────────────────────────────────────────────

class DataFoundryClient:
    """Thin client: login, register a DuckDB datasource, drive one run, read answer."""

    def __init__(self, api_base: str, email: str, password: str):
        self.api = api_base.rstrip("/")
        self.s = requests.Session()
        self._login(email, password)

    def _login(self, email: str, password: str) -> None:
        r = self.s.post(f"{self.api}/api/v1/auth/login",
                        json={"email": email, "password": password})
        if r.status_code == 403:
            raise SystemExit(
                "Login rejected (likely EMAIL_NOT_VERIFIED). Register once with "
                "AUTH_EMAIL_DELIVERY=test and verify, then retry. Body: " + r.text)
        r.raise_for_status()
        # df_session + df_csrf are now in the cookie jar; mutations need the CSRF header.
        self.csrf = self.s.cookies.get("df_csrf")

    def _mutate_headers(self) -> dict:
        return {"x-csrf-token": self.csrf} if self.csrf else {}

    def duckdb_field_names(self) -> list[str]:
        """Discover the DuckDB adapter's config field names instead of guessing them."""
        r = self.s.get(f"{self.api}/api/v1/datasource-types")
        r.raise_for_status()
        types = r.json()
        rows = types.get("types", types) if isinstance(types, dict) else types
        for t in rows:
            if t.get("name") == "duckdb":
                return [p.get("name") for p in t.get("parameters", [])]
        return ["file_path"]

    def register_duckdb_datasource(self, ds_id: str, name: str, duckdb_path: str) -> str:
        """Create (idempotently) a read-only DuckDB datasource and wait for schema."""
        fields = self.duckdb_field_names()
        # DuckDB adapters take a single file path; map whatever the field is called.
        path_field = next((f for f in fields if "path" in f.lower() or "file" in f.lower()),
                          fields[0] if fields else "file_path")
        payload = {
            "id": ds_id,
            "name": name,
            "type": "duckdb",
            "config": {path_field: os.path.abspath(duckdb_path)},  # WIRE: verify shape via GET /datasource-types
        }
        r = self.s.post(f"{self.api}/api/v1/datasources", json=payload,
                        headers=self._mutate_headers())
        if r.status_code not in (200, 201, 409):  # 409 == already exists, fine
            raise SystemExit(f"datasource create failed [{r.status_code}]: {r.text}")
        # Kick introspection, then poll the schema until it materializes.
        self.s.post(f"{self.api}/api/v1/datasources/{ds_id}/introspect",
                    headers=self._mutate_headers())
        deadline = time.time() + 120
        while time.time() < deadline:
            sr = self.s.get(f"{self.api}/api/v1/datasources/{ds_id}/schema")
            if sr.status_code == 200 and sr.json():
                return ds_id
            time.sleep(2)
        print(f"[warn] schema for {ds_id} not confirmed; continuing anyway", file=sys.stderr)
        return ds_id

    def run(self, question: str, datasource_id: str, thread_id: str | None = None) -> str:
        """Start one run over /api/copilotkit, drain the AG-UI stream, return the answer."""
        thread_id = thread_id or f"kb-{uuid.uuid4().hex[:8]}"
        run_id = f"run-{uuid.uuid4().hex[:8]}"
        body = {
            "threadId": thread_id,
            "runId": run_id,
            "messages": [{"role": "user", "content": question}],
            "forwardedProps": {
                "run_config": {
                    "enabledDatasourceIds": [datasource_id],
                    "activeDatasourceId": datasource_id,
                    "activeLlmProfileId": LLM_PROFILE,
                }
            },
        }
        # There is no JSON answer endpoint; we drain the SSE stream to completion,
        # then read the authoritative final message back from the conversation API.
        with self.s.post(f"{self.api}/api/copilotkit", json=body,
                         headers=self._mutate_headers(), stream=True,
                         timeout=RUN_TIMEOUT_S) as resp:
            resp.raise_for_status()
            for _line in resp.iter_lines(decode_unicode=True):
                pass  # (optionally parse RUN_FINISHED / RUN_ERROR here for early exit)
        return self._final_answer(thread_id)

    def _final_answer(self, thread_id: str) -> str:
        """Extract the last assistant/agent text from server conversation history."""
        r = self.s.get(f"{self.api}/api/v1/sessions/{thread_id}/conversation")
        r.raise_for_status()
        conv = r.json()
        msgs = conv.get("messages", conv) if isinstance(conv, dict) else conv
        texts: list[str] = []
        for m in msgs if isinstance(msgs, list) else []:
            role = m.get("role") or m.get("author")
            if role in ("assistant", "agent"):
                c = m.get("content")
                if isinstance(c, str):
                    texts.append(c)
                elif isinstance(c, list):  # content parts
                    texts += [p.get("text", "") for p in c if isinstance(p, dict)]
        return texts[-1].strip() if texts else json.dumps(conv)[:2000]


# ── Domain-lake ingestion ─────────────────────────────────────────────────────

def build_domain_duckdb(dataset_directory: str, out_path: str) -> str:
    """Consolidate a KramaBench domain lake (many files) into one DuckDB file.

    One table per CSV/TSV/Parquet, named after the file stem. Non-tabular /
    scientific formats are skipped — that skip list is itself a finding about
    what DataFoundry cannot ingest.
    """
    if duckdb is None:
        raise SystemExit("pip install duckdb (or register the datasource yourself)")
    con = duckdb.connect(out_path)
    made, skipped = 0, []
    for path in sorted(glob.glob(os.path.join(dataset_directory, "**", "*"), recursive=True)):
        if os.path.isdir(path):
            continue
        stem = _safe_ident(pathlib.Path(path).stem)
        ext = pathlib.Path(path).suffix.lower()
        try:
            if ext in (".csv", ".tsv", ".txt"):
                con.execute(f'CREATE OR REPLACE TABLE "{stem}" AS '
                            f"SELECT * FROM read_csv_auto(?, sample_size=-1)", [path])
            elif ext in (".parquet", ".pq"):
                con.execute(f'CREATE OR REPLACE TABLE "{stem}" AS SELECT * FROM read_parquet(?)', [path])
            elif ext in (".xlsx", ".xls"):
                con.execute("INSTALL excel; LOAD excel;")
                con.execute(f'CREATE OR REPLACE TABLE "{stem}" AS SELECT * FROM read_xlsx(?)', [path])
            else:
                skipped.append(os.path.relpath(path, dataset_directory))
                continue
            made += 1
        except Exception as e:  # noqa: BLE001 — a load failure is also a finding
            skipped.append(f"{os.path.relpath(path, dataset_directory)} ({e})")
    con.close()
    print(f"[ingest] {made} tables built, {len(skipped)} files skipped -> {out_path}")
    if skipped:
        print("[ingest] skipped (un-ingestible by the SQL-first model):")
        for s in skipped[:50]:
            print("   -", s)
    return out_path


def _safe_ident(name: str) -> str:
    keep = "".join(c if c.isalnum() else "_" for c in name).strip("_")
    return keep or "t"


# ── KramaBench SUT adapter ────────────────────────────────────────────────────

class DataFoundrySUT:
    """System-Under-Test for KramaBench, backed by DataFoundry.

    WIRE #1: the method KramaBench calls per task is *not* documented — read
    `benchmark/Benchmark` and rename/reshape `solve(...)` to match. Keep the
    DataFoundry logic (below) untouched; only the entry shim changes.
    """

    def __init__(self, system_output_directory: str | None = None, **_kw):
        self.out = system_output_directory or "./_df_sut"
        os.makedirs(self.out, exist_ok=True)
        self.client = DataFoundryClient(API, os.environ["DF_EMAIL"], os.environ["DF_PASSWORD"])
        self._ds_by_domain: dict[str, str] = {}  # register each domain lake once

    def _ensure_domain(self, domain: str, dataset_directory: str) -> str:
        if domain in self._ds_by_domain:
            return self._ds_by_domain[domain]
        duckdb_path = os.path.join(self.out, f"kb_{_safe_ident(domain)}.duckdb")
        if not os.path.exists(duckdb_path):
            build_domain_duckdb(dataset_directory, duckdb_path)
        ds_id = f"kb-{_safe_ident(domain)}"
        self.client.register_duckdb_datasource(ds_id, f"KramaBench {domain}", duckdb_path)
        self._ds_by_domain[domain] = ds_id
        return ds_id

    def solve(self, prompt, dataset_directory: str, **_kw):  # WIRE #1: match real signature
        """Given a task prompt + its data lake dir, return DataFoundry's answer string."""
        if isinstance(prompt, str):
            question, domain = prompt, pathlib.Path(dataset_directory).name
        else:  # JSON task object
            question = prompt.get("question") or prompt.get("prompt") or prompt.get("query")
            domain = prompt.get("domain") or pathlib.Path(dataset_directory).name
        ds_id = self._ensure_domain(domain, dataset_directory)
        return self.client.run(question, ds_id)


# ── Standalone smoke path (run this before wiring KramaBench) ──────────────────

def _smoke(domain_dir: str, question: str) -> None:
    sut = DataFoundrySUT()
    answer = sut.solve({"question": question, "domain": pathlib.Path(domain_dir).name}, domain_dir)
    print("\n=== ANSWER ===\n" + answer)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--smoke", action="store_true", help="run one task end-to-end")
    ap.add_argument("--domain-dir", help="path to one KramaBench domain lake")
    ap.add_argument("--question", help="task question text")
    args = ap.parse_args()
    if args.smoke:
        if not (args.domain_dir and args.question):
            ap.error("--smoke requires --domain-dir and --question")
        _smoke(args.domain_dir, args.question)
    else:
        ap.print_help()
