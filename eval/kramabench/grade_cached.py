"""Grade cached DataFoundrySUT answers with KramaBench's own metrics (no SUT calls).

Uses the latest cached answer per task, like evaluate.py ("domain:first" uses the earliest).
string_approximate tasks use KramaBench's LLM judge when OPENAI_API_KEY is set, otherwise a
normalized exact match. Writes results/DataFoundrySUT/graded_snapshot.csv.

Usage (from the KramaBench root, so `benchmark` is importable):
    $env:PYTHONPATH = (Get-Location).Path
    python <datafoundry>/eval/kramabench/grade_cached.py legal wildfire biomedical:first
"""
import csv
import glob
import json
import os
import re
import sys

from benchmark.metrics import F1, RAEScore, Success

PRIMARY = {"numeric_exact": Success, "string_exact": Success, "list_exact": F1,
           "numeric_approximate": RAEScore}
CACHE = "results/DataFoundrySUT/response_cache/tasks"


def latest_answers(domain, pick_first=False):
    by_task = {}
    for path in glob.glob(os.path.join(CACHE, f"{domain}_task_*.json")):
        m = re.match(rf"{domain}_task_(.+)_(\d{{8}}_\d{{6}})\.json$", os.path.basename(path))
        task_id, stamp = m.group(1), m.group(2)
        by_task.setdefault(task_id, []).append((stamp, path))
    out = {}
    for task_id, runs in by_task.items():
        runs.sort()
        chosen = runs[0] if pick_first else runs[-1]
        rec = json.load(open(chosen[1]))
        rec = rec[0] if isinstance(rec, list) else rec
        out[task_id] = {"answer": rec["model_output"]["answer"], "stamp": chosen[0],
                        "runs": len(runs), "runtime": float(rec.get("runtime") or 0)}
    return out


def _norm(v) -> str:
    return " ".join(re.sub(r"[^0-9a-z.]+", " ", str(v).lower()).split())


class NormalizedMatch:
    """No-key fallback for string_approximate: 1 only if texts match after normalizing
    case, punctuation and brackets. Stricter than the LLM judge (never credits paraphrases)."""
    def __call__(self, predicted, target):
        return (float(_norm(predicted) == _norm(target)), 0, 0, 0)


judge = NormalizedMatch
if os.environ.get("OPENAI_API_KEY"):
    from benchmark.metrics import LLMParaphrase
    judge = LLMParaphrase

rows, totals = [], []
for arg in sys.argv[1:]:  # "domain" = latest answer per task, "domain:first" = earliest
    domain, _, mode = arg.partition(":")
    tasks = {t["id"]: t for t in json.load(open(f"workload/{domain}.json"))}
    got = latest_answers(domain, pick_first=(mode == "first"))
    score, graded, pending = 0.0, 0, []
    print(f"\n=== {domain} ({'first' if mode == 'first' else 'latest'} run): {len(got)}/{len(tasks)} answered ===")
    for tid in sorted(tasks, key=lambda x: (x.split("-")[1], int(x.split("-")[2]))):
        t, g = tasks[tid], got.get(tid)
        ans = g["answer"] if g else None
        typ = t["answer_type"]
        if typ == "string_approximate" and judge is None:
            s = None
            pending.append(tid)
        else:
            metric = judge if typ == "string_approximate" else PRIMARY[typ]
            try:
                s = float(metric()(ans, t["answer"])[0]) if ans is not None else 0.0
            except Exception:  # metric failure counts as a miss, as in evaluate.py
                s = 0.0
            score += s
            graded += 1
        mark = "?" if s is None else ("✓" if s >= 0.999 else ("~" if s > 0 else "✗"))
        print(f"  {mark} {tid:20} {typ:19} expected {str(t['answer'])[:30]:32} got {str(ans)[:30]:32}"
              + ("" if s is None else f" {s:.2f}"))
        rows.append({"domain": domain, "task_id": tid, "answer_type": typ, "expected": t["answer"],
                     "got": ans, "score": "" if s is None else s,
                     "runs_cached": g["runs"] if g else 0, "runtime_s": round(g["runtime"]) if g else ""})
    print(f"  -> {domain}: {score:.2f} / {graded} = {100 * score / graded:.1f}%")
    totals.append((domain, score, graded))

s, n = sum(t[1] for t in totals), sum(t[2] for t in totals)
print(f"\nTOTAL: {s:.2f} / {n} = {100 * s / n:.1f}%   (string_approximate graded by {judge.__name__})")

out = "results/DataFoundrySUT/graded_snapshot.csv"
with open(out, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
print(f"\nwrote {out}")
