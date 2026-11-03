"""One chart per KramaBench domain: what happened to every task in it.

    python notes/figures/plot_domain_breakdown.py [domain ...]   # default: biomedical archeology astronomy

Writes kramabench-domain-<domain>.png. Task ids come from the KramaBench workload
(KB_ROOT, default ~/KramaBench); failures and their reasons from
kramabench_failure_reasons.csv, where "Grain & entity key" is shown by its
population / grain / entity key sub-type. Any task not in the CSV is correct.
Colours are the validated owner palette; bars are solid, hypotheses are marked *
on the task name, and every bar names its tasks so colour is never read alone.
"""

from __future__ import annotations

import csv
import json
import os
import pathlib
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
KB_ROOT = pathlib.Path(os.environ.get("KB_ROOT", pathlib.Path.home() / "KramaBench"))
DEFAULT_DOMAINS = ["biomedical", "archeology", "astronomy"]

# LLM-judge answers the local scorer gives 0 without an OpenAI key, graded correct by hand.
HAND_GRADED = {"astronomy-easy-4", "astronomy-easy-6", "astronomy-hard-8"}

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"
CORRECT = "#c9c7c0"

# Validated: node scripts/validate_palette.js "#2a78d6,#f2913f,#0e7a57,#4a3aa7"
#            --mode light --pairs all  -> ALL CHECKS PASS
OWNER_COLOUR = {
    "Agent analysis": "#2a78d6",
    "Eval harness": "#f2913f",
    "Benchmark": "#0e7a57",
    "Platform & infrastructure": "#4a3aa7",
    "Pending": "#a8a6a0",
}
OWNER_ORDER = list(OWNER_COLOUR)


def short(task_id: str) -> str:
    return task_id.split("-", 1)[1]


def plot(domain: str, failures: dict[str, dict]) -> pathlib.Path:
    tasks = [t["id"] for t in json.loads((KB_ROOT / "workload" / f"{domain}.json").read_text(encoding="utf-8"))]
    correct = [t for t in tasks if t not in failures]

    groups: dict[str, dict] = {}
    for task in tasks:
        if task not in failures:
            continue
        row = failures[task]
        label = row.get("subtype") or row["reason"]
        group = groups.setdefault(label, {"owner": row["owner"], "tasks": []})
        group["tasks"].append(row)

    # Failure bars grouped by owner, then size; "Correct" sits on top as the baseline.
    labels = sorted(groups, key=lambda g: (OWNER_ORDER.index(groups[g]["owner"]), -len(groups[g]["tasks"]), g))
    bars = [("Correct", CORRECT, [{"task_id": t, "subtype_evidence": "confirmed"} for t in correct])]
    bars += [(g, OWNER_COLOUR[groups[g]["owner"]], groups[g]["tasks"]) for g in labels]
    bars.reverse()  # barh draws bottom-up

    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    height = 2.6 + 0.62 * len(bars)
    figure = plt.figure(figsize=(12.5, height), facecolor=SURFACE)
    top = 1 - 2.05 / height
    axes = figure.add_axes([0.21, 0.35 / height, 0.36, top - 0.35 / height])
    axes.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        axes.spines[side].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(colors=INK_MUTED, length=0)
    axes.set_xticks([])

    most = max(len(members) for _, _, members in bars)
    for slot, (label, colour, members) in enumerate(bars):
        members = sorted(members, key=lambda r: (r.get("subtype_evidence") == "hypothesis",
                                                 "hard" in r["task_id"], int(r["task_id"].rsplit("-", 1)[1])))
        axes.barh(slot, len(members), height=0.6, color=colour, zorder=3)
        axes.text(len(members) + 0.12, slot, str(len(members)), va="center", ha="left",
                  fontsize=11, color=INK, fontweight="semibold")
        names = []
        for m in members:
            name = short(m["task_id"])
            if m.get("subtype_evidence") == "hypothesis":
                name += "*"
            if m["task_id"] in HAND_GRADED:
                name += "†"
            names.append(name)
        lines = [", ".join(names[i:i + 4]) for i in range(0, len(names), 4)]
        axes.annotate("\n".join(lines), xy=(most + 1.4, slot), va="center", ha="left",
                      fontsize=9.5, color=INK_SECOND, annotation_clip=False)

    axes.set_yticks(range(len(bars)))
    axes.set_yticklabels([label for label, _, _ in bars], fontsize=10.5, color=INK)
    axes.set_xlim(0, most + 1.2)
    axes.set_ylim(-0.6, len(bars) - 0.4)

    lost = sum(1.0 - float(failures[t]["score"]) for t in tasks if t in failures)
    score = len(tasks) - lost
    figure.text(0.018, 1 - 0.55 / height,
                f"{domain.capitalize()}: {score:g} of {len(tasks)} points",
                fontsize=17, color=INK, fontweight="semibold")
    notes = [f"{len(correct)} tasks correct, {len(tasks) - len(correct)} short, grouped by the earliest decision "
             "that, if corrected, would have produced the right answer."]
    marks = []
    if any(m.get("subtype_evidence") == "hypothesis" for _, _, ms in bars for m in ms):
        marks.append("* hypothesis, not yet confirmed")
    if any(t in HAND_GRADED for t in correct):
        marks.append("† correct, graded by hand (the local scorer needs an LLM judge)")
    if marks:
        notes.append("   ".join(marks))
    for i, line in enumerate(notes):
        figure.text(0.018, 1 - (1.0 + 0.36 * i) / height, line, fontsize=9.5,
                    color=INK_SECOND if i == 0 else INK_MUTED)

    owners = [o for o in OWNER_ORDER if any(g["owner"] == o for g in groups.values())]
    handles = [Patch(facecolor=CORRECT, label="Correct")] + \
              [Patch(facecolor=OWNER_COLOUR[o], label=o) for o in owners]
    figure.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.018, 1 - 1.62 / height),
                  ncol=len(handles), frameon=False, fontsize=10, handlelength=1.1,
                  handleheight=1.1, columnspacing=1.4, labelcolor=INK)

    out = HERE / f"kramabench-domain-{domain}.png"
    figure.savefig(out, dpi=200, facecolor=SURFACE)
    plt.close(figure)
    return out


def main() -> None:
    domains = sys.argv[1:] or DEFAULT_DOMAINS
    with (HERE / "kramabench_failure_reasons.csv").open(encoding="utf-8-sig") as handle:
        failures = {row["task_id"]: row for row in csv.DictReader(handle)}
    for domain in domains:
        print(f"wrote {plot(domain, failures)}")


if __name__ == "__main__":
    main()
