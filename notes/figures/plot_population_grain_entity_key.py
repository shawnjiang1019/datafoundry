"""Break the "Grain & entity key" failure class into its three sub-types.

    python notes/figures/plot_population_grain_entity_key.py

Reads the subtype / subtype_evidence columns of kramabench_failure_reasons.csv and
writes kramabench-population-grain-entity-key.png. Bars are solid; hypotheses (not
yet reproduced, matched against the gold solution, or pinpointed in the trace) are
marked * on the task name. Every task is named beside its bar, so colour is never
read alone.
"""

from __future__ import annotations

import csv
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"

# First three slots of the validated owner palette (validate_palette.js, --pairs all: PASS).
SUBTYPE_COLOUR = {"Population": "#2a78d6", "Grain": "#f2913f", "Entity key": "#0e7a57"}
SUBTYPE_ORDER = ["Population", "Grain", "Entity key"]
MEANING = {
    "Population": "wrong set of rows included",
    "Grain": "wrong unit a row stands for",
    "Entity key": "one thing split or merged",
}


def main() -> None:
    with (HERE / "kramabench_failure_reasons.csv").open(encoding="utf-8-sig") as handle:
        all_rows = list(csv.DictReader(handle))
    rows = [r for r in all_rows if r.get("subtype")]
    missing = sum(1.0 - float(r["score"]) for r in all_rows)

    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(13.5, 5.6), facecolor=SURFACE)
    axes = figure.add_axes([0.2, 0.1, 0.34, 0.62])
    axes.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        axes.spines[side].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(colors=INK_MUTED, length=0)
    axes.set_xticks([])

    order = SUBTYPE_ORDER[::-1]  # barh draws bottom-up
    most = max(sum(1 for r in rows if r["subtype"] == s) for s in order)
    for slot, subtype in enumerate(order):
        tasks = sorted((r for r in rows if r["subtype"] == subtype),
                       key=lambda r: (r["subtype_evidence"] != "confirmed", r["task_id"]))
        confirmed = [r for r in tasks if r["subtype_evidence"] == "confirmed"]
        guessed = [r for r in tasks if r["subtype_evidence"] != "confirmed"]
        colour = SUBTYPE_COLOUR[subtype]
        axes.barh(slot, len(tasks), height=0.58, color=colour, zorder=3)
        lost = sum(1.0 - float(r["score"]) for r in tasks)
        axes.text(len(tasks) + 0.15, slot, f"{len(tasks)}", va="center", ha="left",
                  fontsize=11, color=INK, fontweight="semibold")
        axes.text(len(tasks) + 0.55, slot, f"{lost:.2f} pts", va="center", ha="left",
                  fontsize=9, color=INK_MUTED)
        # Task list, confirmed first; hypotheses marked with an asterisk.
        names = [r["task_id"] for r in confirmed] + [f"{r['task_id']}*" for r in guessed]
        lines = [", ".join(names[i:i + 3]) for i in range(0, len(names), 3)]
        axes.annotate("\n".join(lines), xy=(most + 2.6, slot), xycoords="data",
                      va="center", ha="left", fontsize=9, color=INK_SECOND, annotation_clip=False)

    axes.set_yticks(range(len(order)))
    axes.set_yticklabels([f"{s}\n{MEANING[s]}" for s in order], fontsize=10, color=INK)
    for label in axes.get_yticklabels():
        label.set_linespacing(1.5)
    axes.set_xlim(0, most + 2.3)
    axes.set_ylim(-0.6, len(order) - 0.4)

    total = len(rows)
    points = sum(1.0 - float(r["score"]) for r in rows)
    confirmed_n = sum(1 for r in rows if r["subtype_evidence"] == "confirmed")
    figure.text(0.018, 0.9, "Population, grain and entity key errors in KramaBench",
                fontsize=17, color=INK, fontweight="semibold")
    figure.text(0.018, 0.835,
                f"{total} tasks, {points:.2f} of the {missing:.1f} points DataFoundry misses. In each, the SQL ran and the "
                "arithmetic was right, but the rows were defined wrong before the query.",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.018, 0.79,
                f"{confirmed_n} confirmed (reproduced, matched to the gold solution, or pinpointed in the trace); "
                f"{total - confirmed_n} hypotheses, marked *.",
                fontsize=9.5, color=INK_MUTED)

    out = HERE / "kramabench-population-grain-entity-key.png"
    figure.savefig(out, dpi=200, facecolor=SURFACE)
    print(f"wrote {out}")
    for subtype in SUBTYPE_ORDER:
        tasks = [r for r in rows if r["subtype"] == subtype]
        print(f"  {subtype:10} {len(tasks)} tasks  "
              f"{sum(1 for r in tasks if r['subtype_evidence'] == 'confirmed')} confirmed")


if __name__ == "__main__":
    main()
