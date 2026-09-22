"""
DataFoundry-as-DA-Code-runner.

DA-Code (EMNLP 2024, https://github.com/yiyihum/da-code) grades *files*: for each task
the agent must leave `result.csv` (or another named artifact) in its working directory,
and `evaluate.py` compares it with the gold file. This runner drives DataFoundry over
DA-Code's tasks and lays the produced files out the way DA-Code's evaluator expects.

Per task it:
  1. builds a DuckDB from the task's tabular source files (one table per file) and
     registers it as a datasource, so the SQL-first agent can query the data;
  2. copies the raw source files (README.md, tips.md, CSVs, ...) into the session
     workspace, so read_file still works for anything SQL cannot express;
  3. runs the task instruction through the agent;
  4. collects the expected output files into <output_dir>/<task-id>/.

The answer is taken from the workspace file when the agent wrote one, and otherwise
from a fenced block in the final message (DataFoundry's analysis protocol can refuse
write_file until requirement claims are committed, and the deliverable here is the file,
not the claim).

Usage:
    python eval/dacode/datafoundry_dacode.py --list
    python eval/dacode/datafoundry_dacode.py --types di,dw,dm,sa --limit 5
    python evaluate.py --output_dir <output_dir> --gold_dir da_code/gold \
        --eval_json da_code/configs/eval/eval_all.jsonl --result_dir results   # in DA-Code

Environment (same as the KramaBench harness):
    DF_API, DF_EMAIL, DF_PASSWORD, DF_LLM_PROFILE, DF_RUN_TIMEOUT
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import time
import uuid

import requests

# Reuse the KramaBench harness's lake ingestion (header/delimiter detection included).
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "kramabench"))
from datafoundry_sut import _unwrap, build_domain_duckdb  # noqa: E402

API = os.environ.get("DF_API", "http://127.0.0.1:8787").rstrip("/")
LLM_PROFILE = os.environ.get("DF_LLM_PROFILE", "server-default")
RUN_TIMEOUT_S = int(os.environ.get("DF_RUN_TIMEOUT", "1800"))

TYPE_FILES = {"di": "di.jsonl", "dm": "dm.jsonl", "dw": "dw.jsonl",
              "ml": "ml.jsonl", "sa": "sa.jsonl", "visual": "visual.jsonl", "all": "all.jsonl"}

HARNESS_NOTE = """

--- How to work in this environment ---
The task's data files are in your session workspace (read them with read_file) and the
tabular ones are also loaded into the enabled SQL datasource, one table per file, named
after the file. Prefer SQL for analysis.

Deliverable: the task asks you to save a file (for example result.csv). Do both of these:
1. Write the file with write_file, at the exact path and filename the task states.
2. Also end your reply with the full file content in a fenced block tagged with the
   filename, so the result is recoverable if the file write is blocked:

```result.csv
col_a,col_b
1,2
```

Use the exact column names the task specifies, no index column, and no commentary inside
the block.
"""


class DaCodeClient:
    """DataFoundry client that also exposes the identity needed to seed a workspace."""

    def __init__(self, api_base: str, email: str, password: str):
        self.api = api_base.rstrip("/")
        self.s = requests.Session()
        r = self.s.post(f"{self.api}/api/v1/auth/login", json={"email": email, "password": password})
        if r.status_code == 403:
            raise SystemExit("Login rejected (EMAIL_NOT_VERIFIED?). Body: " + r.text)
        r.raise_for_status()
        identity = _unwrap(r)
        self.user_id = (identity.get("user") or {}).get("id")
        self.workspace_id = (identity.get("workspace") or {}).get("id")
        if not self.user_id or not self.workspace_id:
            raise SystemExit(f"login response lacked user/workspace id: {identity}")
        self.csrf = self.s.cookies.get("df_csrf")

    def _headers(self) -> dict:
        return {"x-csrf-token": self.csrf} if self.csrf else {}

    def register_duckdb_datasource(self, ds_id: str, name: str, duckdb_path: str) -> str:
        payload = {"id": ds_id, "name": name, "type": "duckdb",
                   "config": {"path": os.path.abspath(duckdb_path)}}
        r = self.s.post(f"{self.api}/api/v1/datasources", json=payload, headers=self._headers())
        if r.status_code not in (200, 201, 409):
            raise SystemExit(f"datasource create failed [{r.status_code}]: {r.text}")
        self.s.post(f"{self.api}/api/v1/datasources/{ds_id}/introspect", headers=self._headers())
        deadline = time.time() + 120
        while time.time() < deadline:
            sr = self.s.get(f"{self.api}/api/v1/datasources/{ds_id}/schema")
            if sr.status_code == 200 and _unwrap(sr):
                return ds_id
            time.sleep(2)
        print(f"[warn] schema for {ds_id} not confirmed; continuing", file=sys.stderr)
        return ds_id

    def run(self, prompt: str, datasource_id: str, thread_id: str) -> str:
        payload = {
            "method": "agent/run",
            "params": {"agentId": "dataFoundry"},
            "body": {
                "threadId": thread_id,
                "runId": f"run-{uuid.uuid4().hex[:8]}",
                "state": {},
                "messages": [{"id": f"m-{uuid.uuid4().hex[:8]}", "role": "user", "content": prompt}],
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
        headers = {**self._headers(), "accept": "text/event-stream"}
        with self.s.post(f"{self.api}/api/copilotkit", json=payload,
                         headers=headers, stream=True, timeout=RUN_TIMEOUT_S) as resp:
            resp.raise_for_status()
            for _ in resp.iter_lines(decode_unicode=True):
                pass  # drain the AG-UI stream to completion
        return self.final_message(thread_id)

    def final_message(self, thread_id: str) -> str:
        r = self.s.get(f"{self.api}/api/v1/sessions/{thread_id}/conversation")
        r.raise_for_status()
        conv = _unwrap(r)
        messages = conv.get("messages", conv) if isinstance(conv, dict) else conv
        texts = []
        for message in messages if isinstance(messages, list) else []:
            if (message.get("role") or message.get("author")) in ("assistant", "agent"):
                content = message.get("contentText") or message.get("content")
                if isinstance(content, list):
                    content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
                if isinstance(content, str) and content.strip():
                    texts.append(content.strip())
        return texts[-1] if texts else ""


def session_workspace(workspace_root: str, user_id: str, workspace_id: str, session_id: str) -> pathlib.Path:
    """Mirror of resolveSessionWorkspaceDir in packages/agent-runtime/src/tools/workspace-factory.ts."""
    return pathlib.Path(workspace_root) / user_id / workspace_id / "sessions" / session_id


def expected_files(eval_entry: dict) -> list[str]:
    """Output files DA-Code's evaluator will look for, from its eval config entry."""
    names: list[str] = []
    for result in eval_entry.get("result", []) or []:
        value = result.get("file") if isinstance(result, dict) else None
        for name in (value if isinstance(value, list) else [value]):
            if isinstance(name, str) and name:
                names.append(name)
    return names or ["result.csv"]


def fenced_block(text: str, filename: str) -> str | None:
    """Content of a ``` block tagged with the filename (or the first block as a fallback)."""
    stem = re.escape(pathlib.Path(filename).name)
    tagged = re.search(rf"```(?:{stem}|csv|text)?[^\S\n]*\n(.*?)```", text, re.S | re.I)
    return tagged.group(1).strip("\n") if tagged else None


def load_tasks(dacode_root: pathlib.Path, type_key: str) -> list[dict]:
    path = dacode_root / "da_code" / "configs" / "task" / TYPE_FILES[type_key]
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load_eval_config(dacode_root: pathlib.Path) -> dict[str, dict]:
    path = dacode_root / "da_code" / "configs" / "eval" / "eval_all.jsonl"
    entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return {entry["id"]: entry for entry in entries}


def run_task(task: dict, *, client: DaCodeClient, dacode_root: pathlib.Path, output_dir: pathlib.Path,
             workspace_root: str, eval_entry: dict, keep_db: pathlib.Path) -> dict:
    task_id = task["id"]
    source_dir = dacode_root / "da_code" / "source" / task_id
    target_dir = output_dir / task_id
    wanted = expected_files(eval_entry)

    if not source_dir.is_dir():
        return {"id": task_id, "status": "skipped", "reason": "no source directory"}

    stamp = uuid.uuid4().hex[:8]
    session_id = f"dac-{task_id}-{stamp}"
    workspace = session_workspace(workspace_root, client.user_id, client.workspace_id, session_id)
    workspace.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source_dir.iterdir()):
        if entry.is_file():
            shutil.copy(entry, workspace / entry.name)

    database = keep_db / f"{task_id}-{stamp}.duckdb"
    database.parent.mkdir(parents=True, exist_ok=True)
    build_domain_duckdb(str(source_dir), str(database))
    datasource_id = f"dac-{task_id}-{stamp}".lower()
    client.register_duckdb_datasource(datasource_id, f"DA-Code {task_id}", str(database))

    started = time.time()
    try:
        final_text = client.run(task["instruction"] + HARNESS_NOTE, datasource_id, session_id)
        status = "completed"
    except Exception as error:  # noqa: BLE001 — a failed run is a result, not a crash
        final_text, status = f"[run failed] {error}", "failed"
    elapsed = round(time.time() - started, 1)

    target_dir.mkdir(parents=True, exist_ok=True)
    produced: dict[str, str] = {}
    for name in wanted:
        written = workspace / name
        destination = target_dir / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if written.is_file():
            shutil.copy(written, destination)
            produced[name] = "file"
            continue
        block = fenced_block(final_text, name)
        if block is not None and name.lower().endswith((".csv", ".txt", ".json", ".md")):
            destination.write_text(block + "\n", encoding="utf-8")
            produced[name] = "reply-block"
        else:
            produced[name] = "missing"

    record = {"id": task_id, "type": task.get("type"), "hardness": task.get("hardness"),
              "status": status, "seconds": elapsed, "session": session_id,
              "datasource": datasource_id, "expected": wanted, "produced": produced,
              "final_message": final_text[-4000:]}
    runs_dir = output_dir / "_runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / f"{task_id}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dacode-root", default=os.environ.get("DACODE_ROOT", r"C:\Users\shawn\DA-Code"))
    parser.add_argument("--types", default="di,dw,dm,sa",
                        help="comma-separated task groups: di, dw, dm, sa, ml, visual, all")
    parser.add_argument("--ids", default="", help="comma-separated task ids (overrides --types)")
    parser.add_argument("--limit", type=int, default=0, help="run at most N tasks")
    parser.add_argument("--output-dir", default="", help="default: <dacode-root>/output/datafoundry")
    parser.add_argument("--workspace-root", default=os.environ.get(
        "DF_WORKSPACE_ROOT",
        str(pathlib.Path(__file__).resolve().parents[2] / "apps" / "api" / "storage" / "workspaces")))
    parser.add_argument("--resume", action="store_true", help="skip tasks whose outputs already exist")
    parser.add_argument("--list", action="store_true", help="list runnable tasks and exit")
    args = parser.parse_args()

    dacode_root = pathlib.Path(args.dacode_root)
    output_dir = pathlib.Path(args.output_dir) if args.output_dir else dacode_root / "output" / "datafoundry"
    eval_config = load_eval_config(dacode_root)

    if args.ids:
        wanted_ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        tasks = [t for t in load_tasks(dacode_root, "all") if t["id"] in wanted_ids]
    else:
        tasks, seen = [], set()
        for key in [t.strip() for t in args.types.split(",") if t.strip()]:
            for task in load_tasks(dacode_root, key):
                if task["id"] not in seen:
                    seen.add(task["id"])
                    tasks.append(task)

    runnable = [t for t in tasks if (dacode_root / "da_code" / "source" / t["id"]).is_dir()]
    if args.list:
        print(f"{len(runnable)} runnable of {len(tasks)} selected (source data present)")
        for task in runnable:
            print(f"  {task['id']:20} {task.get('hardness','?'):7} {task.get('type','')}"
                  f"  -> {', '.join(expected_files(eval_config.get(task['id'], {})))}")
        return

    if args.resume:
        runnable = [t for t in runnable
                    if not all((output_dir / t["id"] / name).exists()
                               for name in expected_files(eval_config.get(t["id"], {})))]
    if args.limit:
        runnable = runnable[:args.limit]

    email, password = os.environ.get("DF_EMAIL"), os.environ.get("DF_PASSWORD")
    if not email or not password:
        raise SystemExit("set DF_EMAIL and DF_PASSWORD")
    client = DaCodeClient(API, email, password)
    print(f"running {len(runnable)} task(s) -> {output_dir}")

    for index, task in enumerate(runnable, 1):
        record = run_task(task, client=client, dacode_root=dacode_root, output_dir=output_dir,
                          workspace_root=args.workspace_root,
                          eval_entry=eval_config.get(task["id"], {}),
                          keep_db=output_dir / "_db")
        produced = record.get("produced", {})
        print(f"[{index}/{len(runnable)}] {task['id']:20} {record['status']:9} "
              f"{record.get('seconds', 0):6}s  " + ", ".join(f"{k}:{v}" for k, v in produced.items()))

    print(f"\nnow score with DA-Code's evaluator, from {dacode_root}:")
    print(f"  python evaluate.py --output_dir {output_dir} --gold_dir da_code/gold \\\n"
          f"      --eval_json da_code/configs/eval/eval_all.jsonl --result_dir results")


if __name__ == "__main__":
    main()
