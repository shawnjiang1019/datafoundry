"""Export the full DataFoundry run trace behind a graded KramaBench answer.

    python eval/kramabench/export_traces.py legal-easy-19 legal-hard-22
    python eval/kramabench/export_traces.py --reason "Grain & entity key"
    python eval/kramabench/export_traces.py legal-easy-19 \
        --embed-into notes/example-population-legal-easy-19.md --mark "12=THE ERROR: ..."

For each task it finds the cached answer that was graded, matches it to the run
that produced it, and rebuilds that run's event stream into one markdown file:
the requirements the protocol extracted, every tool call with its arguments and
result, the agent's messages, protocol failures, and the SQL audit log.

By default results are clipped for skimming. --full keeps everything: every
message, every tool call's complete arguments and result, and every event in the
stream (protocol events as one line each, with their raw JSON collapsed underneath).
--embed-into writes that full trace as the "Full trace" section of an existing
markdown file, and --mark STEP=TEXT (or R=TEXT for the requirements) flags steps.

Reads the DataFoundry metadata database read-only; safe while the API is running.
Writes notes/traces/<task_id>.md plus an index at notes/traces/README.md.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import json
import os
import pathlib
import re
import sqlite3
from collections import defaultdict

REPO = pathlib.Path(__file__).resolve().parents[2]
DB_PATH = REPO / "apps" / "api" / "storage" / "metadata" / "workbench.sqlite"
REASONS_CSV = REPO / "notes" / "figures" / "kramabench_failure_reasons.csv"
OUT_DIR = REPO / "notes" / "traces"

# Matches how graded_snapshot.csv was produced: legal:first, every other domain latest.
FIRST_DOMAINS = {"legal"}

RESULT_CHARS = 2500
ARGS_CHARS = 2500
MESSAGE_CHARS = 6000
TABLE_ROWS = 15
CELL_CHARS = 60
FULL = False  # set by --full / --embed-into: no clipping, every event kept

# Protocol events worth showing inline; the rest (token usage, context compilation,
# per-action bookkeeping) is noise for reading a trace.
SHOWN_EVENTS = {
    "protocol.phase.entered",
    "protocol.action.failed",
    "protocol.completion.proposed",
    "protocol.run.degraded",
    "protocol.run.failed",
    "protocol.handoff.requested",
    "protocol.handoff.rejected",
}

CACHE_NAME = re.compile(
    r"^(?P<dom>[a-z]+)_task_(?P<tid>[a-z]+-(?:easy|hard)-\d+)_(?P<day>\d{8})_(?P<time>\d{6})\.json$")


def norm(text: str) -> str:
    return " ".join(str(text).split())


def load_task(kb_root: pathlib.Path, task_id: str) -> dict:
    domain = task_id.split("-")[0]
    for task in json.loads((kb_root / "workload" / f"{domain}.json").read_text(encoding="utf-8")):
        if task["id"] == task_id:
            return task
    raise SystemExit(f"{task_id}: not in workload/{domain}.json")


def graded_cache_file(kb_root: pathlib.Path, task_id: str) -> pathlib.Path | None:
    cache = kb_root / "results" / "DataFoundrySUT" / "response_cache" / "tasks"
    matches = []
    for path in glob.glob(str(cache / f"*_task_{task_id}_*.json")):
        m = CACHE_NAME.match(os.path.basename(path))
        if m and m["tid"] == task_id:
            matches.append((m["day"] + m["time"], pathlib.Path(path)))
    if not matches:
        return None
    matches.sort()
    return matches[0][1] if task_id.split("-")[0] in FIRST_DOMAINS else matches[-1][1]


def iso_epoch(value: str | None) -> float | None:
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def events_for(db: sqlite3.Connection, run_id: str) -> list[tuple[int, str, dict]]:
    rows = db.execute(
        "select seq, event_type, payload_json from run_events where run_id=? order by seq", (run_id,))
    return [(seq, kind, json.loads(payload)) for seq, kind, payload in rows]


def last_assistant_text(events) -> str:
    messages: dict[str, str] = defaultdict(str)
    order: list[str] = []
    for _, kind, payload in events:
        if kind == "TEXT_MESSAGE_CHUNK" and payload.get("role", "assistant") == "assistant":
            mid = payload.get("messageId", "")
            if mid not in messages:
                order.append(mid)
            messages[mid] += payload.get("delta", "")
    return messages[order[-1]] if order else ""


def match_run(db, task: dict, cached: dict, cache_path: pathlib.Path):
    """Pick the run whose final message is the cached answer; fall back to nearest finish time."""
    domain = task["id"].split("-")[0]
    candidates = db.execute(
        """select id, session_id, status, started_at, finished_at, model_name, error_message
           from runs where datasource_id=? and instr(user_input, ?) > 0 order by started_at""",
        (f"kb-{domain}", task["query"][:80]),
    ).fetchall()
    if not candidates:
        return None, None, "no run found"
    target = norm(cached.get("model_output", {}).get("full_response", ""))[:150]
    for row in candidates:
        events = events_for(db, row[0])
        if target and target in norm(last_assistant_text(events)):
            return row, events, f"final message matches the cached answer ({len(candidates)} candidate runs)"
    mtime = cache_path.stat().st_mtime
    row = min(candidates, key=lambda r: abs((iso_epoch(r[4]) or 0) - mtime))
    return row, events_for(db, row[0]), f"matched by finish time, nearest of {len(candidates)} runs"


def parse_json(text):
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return text
    # Some results are a JSON-encoded string of JSON.
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def fenced(text: str, lang: str = "") -> str:
    """Code block whose fence is longer than any backtick run in text, so content can't close it."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{lang}\n{text}\n{fence}"


def clip(text: str, limit: int | None) -> str:
    text = str(text)
    if FULL or limit is None or len(text) <= limit:
        return text
    return text[:limit] + f"\n… [{len(text) - limit:,} more characters]"


def md_table(columns: list[str], rows: list) -> str:
    def cell(value) -> str:
        text = str(value).replace("|", "\\|").replace("\n", " ")
        return text if FULL else text[:CELL_CHARS]
    shown = rows if FULL else rows[:TABLE_ROWS]
    lines = ["| " + " | ".join(cell(c) for c in columns) + " |",
             "|" + "---|" * len(columns)]
    for row in shown:
        values = [row.get(c) for c in columns] if isinstance(row, dict) else list(row)
        lines.append("| " + " | ".join(cell(v) for v in values) + " |")
    if len(rows) > len(shown):
        lines.append(f"\n… {len(rows) - len(shown)} more rows")
    return "\n".join(lines)


def find_rows(value):
    """Locate a (columns, rows) pair in a tool result, however deeply it is nested."""
    if isinstance(value, dict):
        rows = value.get("rows")
        if isinstance(rows, list) and rows:
            columns = value.get("columns")
            if isinstance(columns, list) and columns:
                names = [c.get("name", str(c)) if isinstance(c, dict) else str(c) for c in columns]
                return names, rows
            if isinstance(rows[0], dict):
                return list(rows[0].keys()), rows
        for child in value.values():
            found = find_rows(child)
            if found:
                return found
    return None


def render_result(content) -> str:
    value = parse_json(content)
    if isinstance(value, dict) and value.get("ok") is False:
        error = value.get("error") or {}
        return (f"**Failed:** `{error.get('code', '?')}` — {clip(error.get('message', ''), 400)}"
                if isinstance(error, dict) else f"**Failed:** {clip(error, 400)}")
    found = find_rows(value)
    if found:
        columns, rows = found
        return f"{len(rows)} row(s)\n\n" + md_table(columns, rows)
    if isinstance(value, str):
        return fenced(clip(value, RESULT_CHARS), "text")
    return fenced(clip(json.dumps(value, indent=2, ensure_ascii=False), RESULT_CHARS), "json")


def render_args(raw: str) -> str:
    value = parse_json(raw)
    if not isinstance(value, dict):
        return fenced(clip(raw, ARGS_CHARS), "text") if raw else ""
    parts = []
    sql = value.pop("sql", None)
    value.pop("schema_id", None)
    if sql:
        parts.append(fenced(clip(sql, ARGS_CHARS), "sql"))
    if value:
        parts.append(fenced(clip(json.dumps(value, indent=2, ensure_ascii=False), ARGS_CHARS), "json"))
    return "\n\n".join(parts)


def render_event(name: str, payload: dict) -> str:
    inner = (payload.get("value") or {}).get("payload", payload.get("value", {}))
    return f"*⟶ `{name}`* — `{clip(json.dumps(inner, ensure_ascii=False), 300)}`"


def scalar_summary(value, limit: int = 180) -> str:
    """One-line gist of an event payload: its scalar fields, one level deep."""
    parts = []
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, (str, int, float, bool)) and item != "":
                parts.append(f"{key}={item}")
            elif isinstance(item, dict):
                parts += [f"{key}.{k}={v}" for k, v in item.items() if isinstance(v, (str, int, float, bool))]
    text = "; ".join(parts)
    return text if len(text) <= limit else text[:limit] + "…"


def render_full_event(kind: str, payload: dict) -> str:
    """Any non-message, non-tool event: a one-line gist plus its raw JSON, collapsed."""
    if kind == "CUSTOM":
        value = payload.get("value")
        inner = value.get("payload", value) if isinstance(value, dict) else value
        label, gist = payload.get("name", "CUSTOM"), scalar_summary(inner)
    elif kind == "ACTIVITY_SNAPSHOT":
        content = payload.get("content") or {}
        label, gist = "activity", f"{content.get('title', '')} — {content.get('status', '')}"
    else:
        label, gist = kind, scalar_summary(payload)
    head = f"*⟶ `{label}`*" + (f" — {gist}" if gist else "")
    raw = json.dumps(payload, indent=2, ensure_ascii=False)
    return f"{head}\n\n<details><summary>raw event</summary>\n\n{fenced(raw, 'json')}\n\n</details>"


def agent_steps(events) -> tuple[list[dict], list[dict]]:
    """The agent's steps in order, numbered exactly as render_trace numbers them.

    Returns (steps, requirements). A step is an assistant message or a tool call;
    protocol events are not steps, and empty messages are skipped, as in the trace.
    Tool steps carry the raw argument string and the raw result content.
    """
    args_by_id: dict[str, str] = defaultdict(str)
    result_by_id: dict[str, object] = {}
    for _, kind, payload in events:
        if kind == "TOOL_CALL_ARGS":
            args_by_id[payload.get("toolCallId")] += payload.get("delta", "")
        elif kind == "TOOL_CALL_RESULT":
            result_by_id[payload.get("toolCallId")] = payload.get("content")
    order, messages, first_seq, requirements = [], defaultdict(str), {}, []
    for seq, kind, payload in events:
        if kind == "TEXT_MESSAGE_CHUNK" and payload.get("role", "assistant") == "assistant":
            mid = payload.get("messageId", "")
            if mid not in messages:
                order.append(("message", mid))
                first_seq[mid] = seq
            messages[mid] += payload.get("delta", "")
        elif kind == "TOOL_CALL_START":
            order.append(("call", payload["toolCallId"], payload.get("toolCallName"), seq))
        elif kind == "CUSTOM" and payload.get("name") == "analysis.requirements.extracted":
            requirements = ((payload.get("value") or {}).get("payload") or {}).get("requirements", [])
    steps, number = [], 0
    for item in order:
        if item[0] == "message":
            text = messages[item[1]].strip()
            if not text:
                continue
            number += 1
            steps.append({"step": number, "kind": "agent", "seq": first_seq[item[1]], "message": text})
        else:
            _, call_id, name, seq = item
            number += 1
            steps.append({"step": number, "kind": "tool", "seq": seq, "tool": name, "call_id": call_id,
                          "args": args_by_id.get(call_id, ""), "result": result_by_id.get(call_id)})
    return steps, requirements


def render_trace(db, task: dict, reason: dict, cache_path, cached, run, events, how) -> tuple[str, dict]:
    run_id, session_id, status, started, finished, model, error_message = run
    requirements, items = [], []
    messages: dict[str, str] = defaultdict(str)
    # The stream can record a tool result before its TOOL_CALL_START, so gather
    # arguments and results by call id first and build the timeline second.
    args_by_id: dict[str, str] = defaultdict(str)
    result_by_id: dict[str, object] = {}
    for _, kind, payload in events:
        if kind == "TOOL_CALL_ARGS":
            args_by_id[payload.get("toolCallId")] += payload.get("delta", "")
        elif kind == "TOOL_CALL_RESULT":
            result_by_id[payload.get("toolCallId")] = payload.get("content")
    calls: dict[str, dict] = {}
    for seq, kind, payload in events:
        if kind == "TEXT_MESSAGE_CHUNK" and payload.get("role", "assistant") == "assistant":
            mid = payload.get("messageId", "")
            if mid not in messages:
                items.append(("message", mid))
            messages[mid] += payload.get("delta", "")
        elif kind == "TOOL_CALL_START":
            call_id = payload["toolCallId"]
            calls[call_id] = {"name": payload.get("toolCallName"), "args": args_by_id.get(call_id, ""),
                              "result": result_by_id.get(call_id)}
            items.append(("call", call_id))
        elif kind in ("TOOL_CALL_ARGS", "TOOL_CALL_RESULT", "TOOL_CALL_END", "TEXT_MESSAGE_CHUNK"):
            continue  # folded into the call or message they belong to
        elif FULL:
            if kind == "CUSTOM" and payload.get("name") == "analysis.requirements.extracted":
                requirements = ((payload.get("value") or {}).get("payload") or {}).get("requirements", [])
            items.append(("event", render_full_event(kind, payload)))
        elif kind == "CUSTOM":
            name = payload.get("name", "")
            if name == "analysis.requirements.extracted":
                requirements = ((payload.get("value") or {}).get("payload") or {}).get("requirements", [])
            elif name in SHOWN_EVENTS:
                items.append(("event", render_event(name, payload)))
        elif kind == "RUN_ERROR":
            items.append(("event", f"**RUN_ERROR** — {clip(payload.get('message', payload), 400)}"))

    audit = db.execute(
        """select created_at, status, row_count, elapsed_ms, blocked_reason
           from sql_audit_logs where run_id=? order by created_at""", (run_id,)).fetchall()
    answer = cached.get("model_output", {}).get("answer")
    duration = (iso_epoch(finished) or 0) - (iso_epoch(started) or 0) if finished else None
    n_sql = sum(1 for c in calls.values() if c["name"] == "run_sql_readonly")

    out = [f"# {task['id']}", "",
           f"> {task['query']}", "",
           "| | |", "|---|---|",
           f"| **Expected** | `{task['answer']}` |",
           f"| **Graded answer** | `{answer}` |",
           f"| **Score** | {reason.get('score', '?')} |",
           f"| **Filed under** | {reason.get('reason', '—')} ({reason.get('evidence', '—')}) |",
           f"| **Run** | `{run_id}` · session `{session_id}` · {status} · "
           f"{f'{duration:.0f}s' if duration else '—'} · {model or '?'} |",
           f"| **Declared sources** | {', '.join(f'`{s}`' for s in task.get('data_sources', []))} |",
           f"| **Activity** | {len(calls)} tool calls, {n_sql} SQL queries, {len(audit)} audited |",
           f"| **Cached answer** | `{cache_path.name}` — {how} |"]
    if error_message:
        out.append(f"| **Run error** | {clip(error_message, 300)} |")
    out += ["", "See `notes/population-grain-entity-key.md` for how this task was diagnosed.", ""]

    if requirements:
        out += ["## Requirements the protocol extracted", "",
                "These were generated before any SQL ran. The agent later validated its answer against them.", ""]
        for req in requirements:
            out.append(f"- **{req.get('id')}** ({req.get('kind')}) — {req.get('description')}")
        out.append("")

    out += ["## Timeline", ""]
    step = 0
    for item in items:
        if item[0] == "event":
            out += [item[1], ""]
            continue
        step += 1
        if item[0] == "message":
            text = messages[item[1]].strip()
            if not text:
                step -= 1
                continue
            quoted = "\n".join(f"> {line}" if line else ">" for line in clip(text, MESSAGE_CHARS).splitlines())
            out += [f"### {step}. Agent", "", quoted, ""]
        else:
            call = calls[item[1]]
            out += [f"### {step}. `{call['name']}`", ""]
            args = render_args(call["args"])
            if args:
                out += [args, ""]
            if call["name"] == "skill" and call["result"] is not None and not FULL:
                out += [f"*(skill instructions loaded, {len(str(call['result'])):,} characters)*", ""]
            elif call["result"] is not None:
                out += ["**Result:**", "", render_result(call["result"]), ""]
            else:
                out += ["*(no result recorded)*", ""]

    out += ["## SQL audit log", ""]
    if audit:
        out += ["| # | time (UTC) | status | rows | ms | error |", "|---|---|---|---|---|---|"]
        for index, (created, st, rows, ms, blocked) in enumerate(audit, 1):
            err = norm(blocked or "").replace("|", "\\|")
            err = err if FULL else err[:110]
            out.append(f"| {index} | {created[11:19]} | {st} | {rows if rows is not None else ''} | "
                       f"{ms if ms is not None else ''} | {err} |")
    else:
        out.append("*(no audited SQL)*")
    out.append("")

    summary = {"task": task["id"], "reason": reason.get("reason", ""), "score": reason.get("score", ""),
               "evidence": reason.get("evidence", ""), "run": run_id, "calls": len(calls),
               "sql": n_sql, "status": status, "how": how}
    return "\n".join(out), summary


def embed_trace(trace_md: str, target: pathlib.Path, run_id: str, marks: dict[str, str]) -> None:
    """Write the full trace as the "Full trace" section of target, replacing any previous one."""
    marked, fence = [], None
    for line in trace_md.splitlines()[1:]:  # the example file already has a title
        opener = re.match(r"^(`{3,})", line)
        if fence is None and opener:
            fence = opener.group(1)
        elif fence is not None and line.strip() == fence:
            fence = None
        elif fence is None and line.startswith("#"):
            line = "#" + line  # demote one level under "## Full trace"
        marked.append(line)
        if fence is not None:
            continue
        step = re.match(r"^#### (\d+)\. ", line)
        key = step.group(1) if step else ("R" if line.startswith("### Requirements") else None)
        if key in marks:
            marked += ["", f"> **▶ {marks[key]}**"]
    intro = [
        "## Full trace", "",
        f"Every step of `{run_id}`, exported from the DataFoundry metadata database by "
        "`eval/kramabench/export_traces.py --embed-into`. Nothing is truncated: every agent message, "
        "every tool call's complete arguments and result, and every event in the stream, in order. "
        "Protocol and activity events are one line each; expand **raw event** for the full JSON. "
        "Step numbers match the walkthrough above, and the steps it discusses are flagged with ▶.", "",
        "DataFoundry does not record the model's hidden reasoning. What the agent was thinking is only "
        "what it wrote in its messages, which appear here in full.", ""]
    text = target.read_text(encoding="utf-8")
    head = text.split("\n## Full trace\n")[0].rstrip()
    if head.endswith("---"):
        head = head[:-3].rstrip()
    head = re.sub(r"^\| Full trace \|.*$", "| Full trace | [below](#full-trace): every step, untruncated |",
                  head, flags=re.M)
    target.write_text(head + "\n\n---\n\n" + "\n".join(intro + marked) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tasks", nargs="*", help="task ids, e.g. legal-easy-19")
    parser.add_argument("--reason", help="export every task filed under this reason in the reasons CSV")
    parser.add_argument("--kb-root", default=os.environ.get("KB_ROOT", str(pathlib.Path.home() / "KramaBench")))
    parser.add_argument("--out", default=str(OUT_DIR))
    parser.add_argument("--full", action="store_true", help="no clipping; keep every event")
    parser.add_argument("--embed-into", help="write the full trace into this markdown file (one task only)")
    parser.add_argument("--mark", action="append", default=[], metavar="STEP=TEXT",
                        help="flag a step (or R for the requirements) in an embedded trace")
    args = parser.parse_args()

    global FULL
    FULL = args.full or bool(args.embed_into)
    marks = dict(item.split("=", 1) for item in args.mark)

    reasons = {}
    if REASONS_CSV.exists():
        with REASONS_CSV.open(encoding="utf-8") as handle:
            reasons = {row["task_id"]: row for row in csv.DictReader(handle)}
    task_ids = list(args.tasks)
    if args.reason:
        task_ids += [tid for tid, row in reasons.items() if row["reason"] == args.reason and tid not in task_ids]
    if not task_ids:
        parser.error("give task ids or --reason")
    if args.embed_into and len(task_ids) != 1:
        parser.error("--embed-into takes exactly one task")

    kb_root, out_dir = pathlib.Path(args.kb_root), pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)

    summaries = []
    for task_id in task_ids:
        task = load_task(kb_root, task_id)
        cache_path = graded_cache_file(kb_root, task_id)
        if cache_path is None:
            print(f"  {task_id}: no cached answer, skipped")
            continue
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        run, events, how = match_run(db, task, cached, cache_path)
        if run is None:
            print(f"  {task_id}: {how}, skipped")
            continue
        text, summary = render_trace(db, task, reasons.get(task_id, {}), cache_path, cached, run, events, how)
        if args.embed_into:
            embed_trace(text, pathlib.Path(args.embed_into), summary["run"], marks)
            print(f"  {task_id}: full trace of {summary['run']} embedded in {args.embed_into} "
                  f"({len(text):,} chars, {len(marks)} marked)")
            return
        (out_dir / f"{task_id}.md").write_text(text, encoding="utf-8")
        summaries.append(summary)
        print(f"  {task_id:22} {summary['run']}  {summary['calls']:3} calls  {summary['sql']:3} SQL  ({how})")

    index = ["# KramaBench run traces", "",
             "Generated by `eval/kramabench/export_traces.py` from the DataFoundry metadata database.", "",
             "| task | filed under | evidence | score | run | tool calls | SQL |",
             "|---|---|---|---|---|---|---|"]
    for s in summaries:
        index.append(f"| [{s['task']}]({s['task']}.md) | {s['reason']} | {s['evidence']} | {s['score']} | "
                     f"`{s['run']}` | {s['calls']} | {s['sql']} |")
    (out_dir / "README.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    print(f"wrote {len(summaries)} trace(s) to {out_dir}")


if __name__ == "__main__":
    main()
