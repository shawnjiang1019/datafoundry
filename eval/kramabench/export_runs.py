"""Export every graded KramaBench run into folders you can analyse yourself.

    python eval/kramabench/export_runs.py                  # every task in every domain
    python eval/kramabench/export_runs.py legal wildfire   # some domains
    python eval/kramabench/export_runs.py --task legal-easy-19 --task wildfire-easy-9
    python eval/kramabench/export_runs.py --all-attempts   # also every earlier attempt
    python eval/kramabench/export_runs.py --failed --out eval/kramabench/run_exports_failed
                                                           # only tasks scoring below 1.0

For each task it takes the cached answer that was graded (legal: first attempt,
other domains: latest, matching graded_snapshot.csv), finds the DataFoundry run
that produced it, and writes:

  <out>/index.csv          one row per task: score, failure reason, run facts, counts
  <out>/all_steps.csv      every agent step of every exported run, one row each
  <out>/README.md          the index as a linked table, plus how to load the CSVs
  <out>/<task_id>/
      README.md            question, expected vs graded answer, run facts, file guide
      trace.md             the full untruncated trace (export_traces.py --full)
      steps.csv            one row per agent step: tool, status, error, SQL, rows, message
      steps.jsonl          the same steps with complete arguments and results
      sql.csv              every statement the run sent: status, rows, ms, error, full SQL
      sql_results/         full result CSV of each successful query, named by step
      requirements.json    extracted requirements, acceptance criteria, assertions,
                           and the contract-grounding outcome

Step numbers are the same as in notes/traces/ and the step diagrams. Reads the
DataFoundry metadata database read-only; safe while the API is running. The
default output folder, eval/kramabench/run_exports/, and any run_exports_*/ sibling
are git-ignored.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import export_traces as et  # noqa: E402

REPO = et.REPO
DOMAINS = ["legal", "wildfire", "biomedical", "archeology", "environment", "astronomy"]
OUT_DIR = REPO / "eval" / "kramabench" / "run_exports"

STEP_FIELDS = ["step", "kind", "tool", "status", "error_code", "error_message", "requirement_ids",
               "sql", "result_rows", "rows_shown", "result_columns", "audit_log_id", "sql_result_file", "message", "seq"]
INDEX_FIELDS = ["domain", "task_id", "attempt", "answer_type", "expected", "graded_answer", "score",
                "failure_reason", "owner", "evidence", "run_id", "run_status", "duration_s", "model",
                "steps", "agent_messages", "tool_calls", "failed_tool_calls", "sql_calls", "sql_ok",
                "requirements", "contract_grounding", "folder"]


def write_csv(path: pathlib.Path, fields: list[str], rows: list[dict]) -> None:
    # utf-8-sig so Excel opens non-ASCII text correctly.
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: pathlib.Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def cache_files(kb_root: pathlib.Path, task_id: str) -> list[tuple[str, pathlib.Path]]:
    cache = kb_root / "results" / "DataFoundrySUT" / "response_cache" / "tasks"
    found = []
    for path in cache.glob(f"*_task_{task_id}_*.json"):
        match = et.CACHE_NAME.match(path.name)
        if match and match["tid"] == task_id:
            found.append((f"{match['day']}_{match['time']}", path))
    return sorted(found)


def result_file(db: sqlite3.Connection, artifact_id: str | None) -> pathlib.Path | None:
    """Stored CSV behind a SQL result: artifact -> file asset ref -> file asset."""
    if not artifact_id:
        return None
    row = db.execute(
        """select fa.storage_path from artifacts a
           join file_asset_refs r on r.id = a.file_asset_ref_id
           join file_assets fa on fa.id = r.file_asset_id
           where a.id = ?""", (artifact_id,)).fetchone()
    return pathlib.Path(row[0]) if row and row[0] and os.path.exists(row[0]) else None


def describe_step(db, raw: dict, results_dir: pathlib.Path | None) -> tuple[dict, dict]:
    """Flatten one step for steps.csv, and keep its complete form for steps.jsonl."""
    flat = {"step": raw["step"], "kind": raw["kind"], "seq": raw["seq"]}
    if raw["kind"] == "agent":
        flat.update(status="message", message=raw["message"])
        return flat, dict(flat)
    args = et.parse_json(raw["args"])
    result = et.parse_json(raw["result"]) if raw["result"] is not None else None
    flat["tool"] = raw["tool"]
    if isinstance(args, dict):
        flat["sql"] = args.get("sql", "")
        ids = args.get("requirement_ids")
        flat["requirement_ids"] = " ".join(ids) if isinstance(ids, list) else ""
    if result is None:
        flat["status"] = "no_result"
    elif isinstance(result, dict) and result.get("ok") is False:
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        flat.update(status="failed", error_code=error.get("code", ""),
                    error_message=et.norm(error.get("message", result.get("error", ""))))
    else:
        flat["status"] = "ok"
        found = et.find_rows(result) if isinstance(result, dict) else None
        if found:
            # result_rows = rows the query returned; rows_shown = rows the agent actually received.
            flat["result_rows"] = result.get("row_count", len(found[1])) if isinstance(result, dict) else len(found[1])
            flat["rows_shown"] = len(found[1])
            flat["result_columns"] = " | ".join(map(str, found[0]))
        if isinstance(result, dict):
            flat["audit_log_id"] = result.get("audit_log_id", "")
            source = result_file(db, result.get("artifact_id"))
            if source and results_dir is not None:
                results_dir.mkdir(exist_ok=True)
                target = results_dir / f"step-{raw['step']:02d}.csv"
                shutil.copyfile(source, target)
                flat["sql_result_file"] = f"sql_results/{target.name}"
    full = dict(flat)
    full.update(args=args, result=result)
    return flat, full


def sql_rows(db, run_id: str, steps: list[dict]) -> list[dict]:
    """Every audited statement, tied to its step by audit id, else by identical SQL text."""
    by_audit = {s["audit_log_id"]: s["step"] for s in steps if s.get("audit_log_id")}
    unmatched = [s for s in steps if s.get("tool") == "run_sql_readonly" and not s.get("audit_log_id")]
    rows = []
    for audit_id, created, status, row_count, elapsed, blocked, sql in db.execute(
            """select id, created_at, status, row_count, elapsed_ms, blocked_reason, sql_text
               from sql_audit_logs where run_id=? order by created_at""", (run_id,)):
        step = by_audit.get(audit_id)
        if step is None:
            for candidate in unmatched:
                if et.norm(candidate.get("sql", "")).rstrip("; ") == et.norm(sql or "").rstrip("; "):
                    step = candidate["step"]
                    unmatched.remove(candidate)
                    break
        rows.append({"step": step or "", "created_at": created, "status": status, "rows": row_count,
                     "elapsed_ms": elapsed, "error": et.norm(blocked or ""), "sql": sql,
                     "audit_log_id": audit_id})
    return rows


def contract_state(db, run_id: str, extracted: list[dict]) -> dict:
    row = db.execute("select state_json from protocol_state_snapshots where run_id=?", (run_id,)).fetchone()
    domain = (json.loads(row[0]).get("domain") or {}) if row and row[0] else {}
    stored = [r for r in domain.get("requirements", []) if r.get("source") != "protocol"]
    findings = domain.get("contractGroundingFindings", [])
    if not stored:
        outcome = "none"
    elif findings and {f.get("requirementId") for f in findings} >= {r.get("id") for r in stored}:
        outcome = "failed"
    elif findings:
        outcome = "partial"
    else:
        outcome = "clean"
    return {"extracted": extracted, "stored": stored, "grounding_outcome": outcome,
            "contract_grounded_flag": domain.get("contractGrounded"), "grounding_findings": findings}


def task_readme(task: dict, facts: dict, reason: dict) -> str:
    lines = [f"# {task['id']}", "", f"> {task['query']}", "",
             "| | |", "|---|---|",
             f"| Expected | `{task['answer']}` ({task['answer_type']}) |",
             f"| Graded answer | `{facts['graded_answer']}` |",
             f"| Score | {facts['score']} |",
             f"| Failure reason | {reason.get('reason', '—') or '—'} ({reason.get('evidence', '') or 'n/a'}) |",
             f"| Run | `{facts['run_id']}` · {facts['run_status']} · {facts['duration_s']}s · {facts['model']} |",
             f"| Activity | {facts['steps']} steps: {facts['agent_messages']} messages, {facts['tool_calls']} tool calls "
             f"({facts['failed_tool_calls']} failed), {facts['sql_calls']} SQL ({facts['sql_ok']} ok) |",
             f"| Contract grounding | {facts['contract_grounding']} |",
             f"| Declared sources | {', '.join(f'`{s}`' for s in task.get('data_sources', []))} |",
             "", "## Files", "",
             "| file | what it holds |", "|---|---|",
             "| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |",
             "| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |",
             "| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |",
             "| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |",
             "| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |",
             "| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |",
             ""]
    return "\n".join(lines)


def load_snapshot(kb_root: pathlib.Path) -> dict:
    path = kb_root / "results" / "DataFoundrySUT" / "graded_snapshot.csv"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return {row["task_id"]: row for row in csv.DictReader(handle)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("domains", nargs="*", default=DOMAINS, help=f"any of {', '.join(DOMAINS)}")
    parser.add_argument("--task", action="append", default=[], help="export only these task ids")
    parser.add_argument("--failed", action="store_true",
                        help="export only tasks scoring below 1.0 in graded_snapshot.csv (partial credit included)")
    parser.add_argument("--all-attempts", action="store_true",
                        help="also export every earlier attempt, as <task_id>@<timestamp>/")
    parser.add_argument("--no-results", action="store_true", help="skip copying full SQL result CSVs")
    parser.add_argument("--kb-root", default=os.environ.get("KB_ROOT", str(pathlib.Path.home() / "KramaBench")))
    parser.add_argument("--out", default=str(OUT_DIR))
    args = parser.parse_args()

    et.FULL = True  # traces are exported untruncated
    kb_root, out = pathlib.Path(args.kb_root), pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{et.DB_PATH.as_posix()}?mode=ro", uri=True)
    snapshot = load_snapshot(kb_root)
    if args.failed:
        if not snapshot:
            parser.error("--failed needs graded_snapshot.csv; run grade_cached.py first")
        args.task += [tid for tid, row in snapshot.items()
                      if float(row.get("score") or 0) < 0.999 and tid not in args.task]
    reasons = {}
    if et.REASONS_CSV.exists():
        with et.REASONS_CSV.open(encoding="utf-8") as handle:
            reasons = {row["task_id"]: row for row in csv.DictReader(handle)}

    index, all_steps = [], []
    domains = sorted({t.split("-")[0] for t in args.task}) if args.task else args.domains
    for domain in domains:
        tasks = json.loads((kb_root / "workload" / f"{domain}.json").read_text(encoding="utf-8"))
        for task in tasks:
            if args.task and task["id"] not in args.task:
                continue
            reason = reasons.get(task["id"], {})
            graded = snapshot.get(task["id"], {})
            base = {"domain": domain, "task_id": task["id"], "answer_type": task["answer_type"],
                    "expected": json.dumps(task["answer"], ensure_ascii=False) if not isinstance(task["answer"], str)
                    else task["answer"], "failure_reason": reason.get("reason", ""),
                    "owner": reason.get("owner", ""), "evidence": reason.get("evidence", "")}
            attempts = cache_files(kb_root, task["id"])
            if not attempts:
                index.append({**base, "attempt": "none", "run_status": "not run",
                              "score": graded.get("score", "")})
                print(f"  {task['id']:22} no cached answer")
                continue
            graded_stamp = (attempts[0] if domain in et.FIRST_DOMAINS else attempts[-1])[0]
            for stamp, cache_path in attempts:
                is_graded = stamp == graded_stamp
                if not (is_graded or args.all_attempts):
                    continue
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                run, events, how = et.match_run(db, task, cached, cache_path)
                if run is None:
                    index.append({**base, "attempt": stamp, "run_status": "run not found"})
                    print(f"  {task['id']:22} {stamp}: run not found")
                    continue
                run_id, _session, status, started, finished, model, _error = run
                folder_name = task["id"] if is_graded else f"{task['id']}@{stamp}"
                folder = out / folder_name
                if folder.exists():
                    shutil.rmtree(folder)
                folder.mkdir(parents=True)

                raw_steps, extracted = et.agent_steps(events)
                flat_steps, full_steps = [], []
                for raw in raw_steps:
                    flat, full = describe_step(db, raw, None if args.no_results else folder / "sql_results")
                    flat_steps.append(flat)
                    full_steps.append(full)
                write_csv(folder / "steps.csv", STEP_FIELDS, flat_steps)
                with (folder / "steps.jsonl").open("w", encoding="utf-8") as handle:
                    for step in full_steps:
                        handle.write(json.dumps(step, ensure_ascii=False) + "\n")
                write_csv(folder / "sql.csv", ["step", "created_at", "status", "rows", "elapsed_ms", "error",
                                                "sql", "audit_log_id"], sql_rows(db, run_id, flat_steps))
                contract = contract_state(db, run_id, extracted)
                (folder / "requirements.json").write_text(json.dumps(contract, indent=2, ensure_ascii=False),
                                                          encoding="utf-8")
                trace, _summary = et.render_trace(db, task, reason, cache_path, cached, run, events, how)
                (folder / "trace.md").write_text(trace, encoding="utf-8")

                tools = [s for s in flat_steps if s["kind"] == "tool"]
                sql_calls = [s for s in tools if s.get("tool") == "run_sql_readonly"]
                duration = (et.iso_epoch(finished) or 0) - (et.iso_epoch(started) or 0) if finished else None
                facts = {**base, "attempt": "graded" if is_graded else stamp,
                         "graded_answer": (cached.get("model_output") or {}).get("answer"),
                         "score": graded.get("score", "") if is_graded else "",
                         "run_id": run_id, "run_status": status,
                         "duration_s": round(duration) if duration else "", "model": model or "",
                         "steps": len(flat_steps), "agent_messages": len(flat_steps) - len(tools),
                         "tool_calls": len(tools), "failed_tool_calls": sum(s["status"] == "failed" for s in tools),
                         "sql_calls": len(sql_calls), "sql_ok": sum(s["status"] == "ok" for s in sql_calls),
                         "requirements": len(contract["stored"]) or len(extracted),
                         "contract_grounding": contract["grounding_outcome"], "folder": folder_name}
                (folder / "README.md").write_text(task_readme(task, facts, reason), encoding="utf-8")
                index.append(facts)
                all_steps += [{"task_id": task["id"], "domain": domain, "run_id": run_id,
                               "folder": folder_name, **s} for s in flat_steps]
                print(f"  {folder_name:40} {run_id}  {len(flat_steps):3} steps  {len(sql_calls):3} SQL  "
                      f"grounding={contract['grounding_outcome']}")

    # A partial export (--task / some domains) updates its tasks and keeps everyone else's rows.
    done = {row["task_id"] for row in index}
    index = [r for r in read_csv(out / "index.csv") if r["task_id"] not in done] + index
    all_steps = [r for r in read_csv(out / "all_steps.csv") if r["task_id"] not in done] + all_steps
    order = {task_id: n for n, task_id in enumerate(
        t["id"] for d in DOMAINS for t in json.loads((kb_root / "workload" / f"{d}.json").read_text("utf-8")))}
    index.sort(key=lambda r: order.get(r["task_id"], 10**6))
    all_steps.sort(key=lambda r: (order.get(r["task_id"], 10**6), r["folder"], int(r["step"])))
    write_csv(out / "index.csv", INDEX_FIELDS, index)
    write_csv(out / "all_steps.csv", ["task_id", "domain", "run_id", "folder", *STEP_FIELDS], all_steps)
    lines = ["# KramaBench run exports", "",
             "Generated by `eval/kramabench/export_runs.py`. One folder per graded run; each folder's README "
             "lists its files.", "",
             "Load everything into pandas:", "",
             "```python", "import pandas as pd",
             "runs  = pd.read_csv('index.csv')", "steps = pd.read_csv('all_steps.csv')",
             "steps[steps.status == 'failed'].groupby('error_code').size()   # e.g. what fails most",
             "```", "",
             "| task | score | failure reason | steps | SQL (ok) | grounding | run |",
             "|---|---|---|---|---|---|---|"]
    for row in index:
        link = f"[{row['task_id']}]({row['folder']}/README.md)" if row.get("folder") else row["task_id"]
        lines.append(f"| {link} | {row.get('score', '')} | {row.get('failure_reason', '')} | "
                     f"{row.get('steps', '')} | {row.get('sql_calls', '')} ({row.get('sql_ok', '')}) | "
                     f"{row.get('contract_grounding', '')} | `{row.get('run_id', row.get('run_status', ''))}` |")
    (out / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    exported = sum(1 for r in index if r.get("folder"))
    print(f"\nexported {exported} run(s) to {out}  ({len(index) - exported} task(s) without a run)")


if __name__ == "__main__":
    main()
