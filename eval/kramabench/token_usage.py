"""Token usage per task and condition, from DataFoundry's own token_usage events.

KramaBench's token fields are always 0 for DataFoundry (the SUT does not report them), so this
reads the metadata database instead: every model call emits a `token_usage` run event with
input/output tokens and a `source` (the agent, or internal callers such as the contract grounder).

    python eval/kramabench/token_usage.py eval/kramabench/run_exports_annotation_study/1_baseline \\
        eval/kramabench/run_exports_annotation_study/4_datalink_annotation_tools

Each argument is an export folder written by export_runs.py (its index.csv maps tasks to runs).
Prints one row per task x condition and per-condition totals; --csv PATH also writes the rows.
Reads the database read-only; safe while the API is running.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import sqlite3
from collections import defaultdict

DB_PATH = pathlib.Path(__file__).resolve().parents[2] / "apps" / "api" / "storage" / "metadata" / "workbench.sqlite"


def run_usage(db: sqlite3.Connection, run_id: str) -> dict:
    usage = {"calls": 0, "input": 0, "output": 0, "agent_input": 0, "agent_output": 0, "other_input": 0}
    for (payload,) in db.execute("select payload_json from run_events where run_id = ?", (run_id,)):
        event = json.loads(payload)
        if event.get("name") != "token_usage":
            continue
        value = event.get("value") or {}
        tokens_in = int(value.get("input_tokens") or value.get("prompt_tokens") or 0)
        tokens_out = int(value.get("output_tokens") or value.get("completion_tokens") or 0)
        usage["calls"] += 1
        usage["input"] += tokens_in
        usage["output"] += tokens_out
        if value.get("source") == "AGENT":
            usage["agent_input"] += tokens_in
            usage["agent_output"] += tokens_out
        else:
            usage["other_input"] += tokens_in
    return usage


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folders", nargs="+", help="export folders from export_runs.py")
    parser.add_argument("--csv", help="also write the per-task rows to this CSV")
    args = parser.parse_args()

    db = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
    rows, totals = [], defaultdict(lambda: defaultdict(int))
    for folder in map(pathlib.Path, args.folders):
        condition = folder.name
        with (folder / "index.csv").open(encoding="utf-8-sig") as handle:
            for entry in csv.DictReader(handle):
                run_id = entry.get("run_id")
                if not run_id:
                    continue
                usage = run_usage(db, run_id)
                rows.append({"condition": condition, "task_id": entry["task_id"], "run_id": run_id,
                             "steps": entry.get("steps", ""), **usage})
                for key, value in usage.items():
                    totals[condition][key] += value
                totals[condition]["tasks"] += 1

    print(f"{'condition':30} {'task':20} {'calls':>5} {'input':>10} {'output':>8} {'agent in':>10} {'other in':>9}")
    for row in rows:
        print(f"{row['condition']:30} {row['task_id'].replace('biomedical-', ''):20} {row['calls']:>5} "
              f"{row['input']:>10,} {row['output']:>8,} {row['agent_input']:>10,} {row['other_input']:>9,}")
    print()
    print(f"{'condition (total)':30} {'tasks':>5} {'calls':>6} {'input':>11} {'output':>9} {'input/task':>11}")
    for condition, total in totals.items():
        per_task = total["input"] // max(total["tasks"], 1)
        print(f"{condition:30} {total['tasks']:>5} {total['calls']:>6} {total['input']:>11,} "
              f"{total['output']:>9,} {per_task:>11,}")
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)


if __name__ == "__main__":
    main()
