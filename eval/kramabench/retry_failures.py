"""Rerun only the questions of a domain whose latest answer is a failed run, or that have no answer.

A run that hit a rate limit, a dropped stream ("TypeError: terminated") or a crash caches a
"[DataFoundry run failed] ..." text instead of an answer. Rerunning the whole domain to fix those
costs hours, so this builds a shard workload <domain>-retry with just those questions, wires it like
the other shards (data and D-TRAIL source links, a copy of the domain's DuckDB with its notes), and
with --run runs it. Grading afterwards (grade_cached.py) uses the newest answer per question, so the
reruns replace the failures. Wrong answers are not failures and are never rerun here.

    python retry_failures.py environment                 # list failures and write the workload
    python retry_failures.py environment --since 2026-11-12T14:41:12Z --run
"""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Same markers the SUT uses to tell a failure report from an answer.
FAILURE_PREFIXES = ("[DataFoundry run failed]", "[DataFoundry error]")

HERE = Path(__file__).resolve().parent
DEFAULT_KRAMABENCH = HERE.parents[3] / "tmp_DG" / "KramaBench"


def answer_text(cached: dict) -> str:
    """The answer a cache file holds, as text ('' when it holds none)."""
    output = cached.get("model_output")
    if isinstance(output, str):
        try:
            output = ast.literal_eval(output) if output.lstrip().startswith("{") else {"answer": output}
        except (ValueError, SyntaxError):
            output = {"answer": output}
    if not isinstance(output, dict):
        return ""
    answer = output.get("answer")
    return "" if answer is None else str(answer).strip()


def cache_time(name: str) -> dt.datetime | None:
    """The timestamp at the end of a cache file name: ..._YYYYMMDD_HHMMSS.json (local time)."""
    stem = name.rsplit(".", 1)[0]
    try:
        return dt.datetime.strptime("_".join(stem.split("_")[-2:]), "%Y%m%d_%H%M%S")
    except ValueError:
        return None


def failed_tasks(kramabench: Path, domain: str, since: dt.datetime | None) -> list[tuple[str, str]]:
    """(task id, reason) for each question whose newest answer since `since` failed or is missing."""
    workload = json.loads((kramabench / "workload" / f"{domain}.json").read_text())
    task_ids = [task["id"] for task in workload]
    cache_dir = kramabench / "results" / "DataFoundrySUT" / "response_cache" / "tasks"
    newest: dict[str, tuple[dt.datetime, Path]] = {}
    for path in cache_dir.glob(f"*_task_{domain}-*.json"):
        task_id = path.name.split("_task_", 1)[1].rsplit("_", 2)[0]
        stamp = cache_time(path.name)
        if task_id not in task_ids or stamp is None or (since and stamp < since):
            continue
        if task_id not in newest or stamp > newest[task_id][0]:
            newest[task_id] = (stamp, path)
    failures = []
    for task_id in task_ids:
        if task_id not in newest:
            failures.append((task_id, "no answer"))
            continue
        text = answer_text(json.loads(newest[task_id][1].read_text()))
        if not text:
            failures.append((task_id, "empty answer"))
        elif text.startswith(FAILURE_PREFIXES):
            failures.append((task_id, text[:100]))
    return failures


def link(path: Path, target: str) -> None:
    if path.is_symlink() or path.exists():
        if path.is_symlink() and os.readlink(path) == target:
            return
        path.unlink()
    path.symlink_to(target)


def write_retry_shard(kramabench: Path, domain: str, task_ids: list[str]) -> str:
    """Write workload/<domain>-retry.json and wire it like the other shards. Returns the shard name."""
    shard = f"{domain}-retry"
    workload = json.loads((kramabench / "workload" / f"{domain}.json").read_text())
    keep = [task for task in workload if task["id"] in set(task_ids)]
    (kramabench / "workload" / f"{shard}.json").write_text(json.dumps(keep, indent=2))
    link(kramabench / "data" / shard, domain)
    sources = kramabench / "system_scratch" / "grounding" / "dtrail_sources"
    if (sources / domain).exists():
        link(sources / f"{domain}_retry", domain)
    # The SUT builds a shard's DuckDB only when it is missing; copy the domain's so the notes come along.
    db_dir = kramabench / "system_scratch" / "DataFoundrySUT"
    for suffix in (".duckdb", ".duckdb.ingest.json"):
        source = db_dir / f"{domain}{suffix}"
        if source.exists():
            shutil.copy2(source, db_dir / f"{domain}_retry{suffix}")
    return shard


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("domain")
    parser.add_argument("--since", help="only answers cached at or after this UTC time (ISO, e.g. 2026-11-12T14:41:12Z)")
    parser.add_argument("--kramabench", default=os.environ.get("KRAMABENCH_DIR", str(DEFAULT_KRAMABENCH)))
    parser.add_argument("--run", action="store_true", help="run the retry shard now (services must be up)")
    args = parser.parse_args()

    kramabench = Path(args.kramabench).resolve()
    since = None
    if args.since:
        # Cache names use local time; compare in local time.
        since = dt.datetime.fromisoformat(args.since.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    failures = failed_tasks(kramabench, args.domain, since)
    if not failures:
        print(f"{args.domain}: no failed questions")
        return 0
    for task_id, reason in failures:
        print(f"{task_id}: {reason}")
    shard = write_retry_shard(kramabench, args.domain, [task_id for task_id, _ in failures])
    print(f"wrote workload/{shard}.json ({len(failures)} question(s))")
    if not args.run:
        return 0
    grounding = kramabench / "system_scratch" / "grounding"
    env = {
        **os.environ,
        "DF_ADVISORY_CONTRACT": "1", "DF_GROUNDING": "1", "DF_ANSWER_FRAME": "1", "DF_BINDING": "1",
        "DF_MCP_SERVER_IDS": "datalink", "DTRAIL_ASSUME": "1", "DTRAIL_API_URL": "http://127.0.0.1:8061",
        "DTRAIL_SOURCES_DIR": str(grounding / "dtrail_sources"),
    }
    log = kramabench / "eval_runs" / f"{shard}.log"
    log.unlink(missing_ok=True)
    return subprocess.call(["./run_shard.sh", shard], cwd=kramabench, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    sys.exit(main())
