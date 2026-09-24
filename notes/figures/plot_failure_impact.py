"""Chart what each failure class actually costs, from kramabench_failure_reasons.csv.

    python notes/figures/plot_failure_impact.py

Writes kramabench-failure-impact.png next to the CSV. Where plot_failure_reasons.py
counts tasks, this counts points, which reorders the picture: partial credit means
"Measure definition" holds 2 tasks but costs 0.59 points, while "Grain & entity key"
holds 13 and costs 12.25.

The right panel is an upper bound, not a forecast: it shows the score if a whole
class were resolved perfectly, in the order the classes are cheapest to attack.
Colours are the validated owner palette; each ladder step tints only the increment
that step adds, so a colour always means the same owner.
"""

from __future__ import annotations

import csv
import pathlib
from collections import Counter, defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
TOTAL_TASKS = 104
SCORE = 61.60

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"
EARNED = "#c9c7c0"

# Validated: node scripts/validate_palette.js "#2a78d6,#f2913f,#0e7a57,#4a3aa7"
#            --mode light --pairs all  -> ALL CHECKS PASS
OWNER_COLOUR = {
    "Agent analysis": "#2a78d6",
    "Eval harness": "#f2913f",
    "Benchmark": "#0e7a57",
    "Infrastructure": "#4a3aa7",
    "Pending": "#a8a6a0",
}
OWNER_ORDER = ["Agent analysis", "Eval harness", "Benchmark", "Infrastructure", "Pending"]


def style_axes(axes) -> None:
    axes.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        axes.spines[side].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(colors=INK_MUTED, length=0, labelsize=9)


def main() -> None:
    with (HERE / "kramabench_failure_reasons.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    lost: dict[str, float] = defaultdict(float)
    counts: Counter = Counter()
    owner_of: dict[str, str] = {}
    for row in rows:
        lost[row["reason"]] += 1.0 - float(row["score"])
        counts[row["reason"]] += 1
        owner_of[row["reason"]] = row["owner"]

    reasons = sorted(lost, key=lambda r: lost[r])  # barh draws bottom-up
    present_owners = [o for o in OWNER_ORDER if any(r["owner"] == o for r in rows)]

    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(13.5, 7.4), facecolor=SURFACE)
    grid = figure.add_gridspec(1, 2, width_ratios=[1.5, 1], wspace=0.30,
                               left=0.205, right=0.975, top=0.705, bottom=0.075)

    # ---- left: points lost per reason --------------------------------------
    left = figure.add_subplot(grid[0, 0])
    style_axes(left)
    positions = list(range(len(reasons)))
    widths = [lost[r] for r in reasons]
    left.barh(positions, widths, height=0.6,
              color=[OWNER_COLOUR[owner_of[r]] for r in reasons], zorder=3)
    left.set_yticks(positions)
    left.set_yticklabels(reasons, fontsize=10, color=INK)
    left.set_xlim(0, max(widths) + 3.4)
    left.set_xticks([])
    for position, reason in zip(positions, reasons):
        value, n = lost[reason], counts[reason]
        left.text(value + 0.22, position, f"{value:.2f}", va="center", ha="left",
                  fontsize=10, color=INK, fontweight="semibold")
        left.text(value + 1.45, position, f"{n} task{'s' if n > 1 else ''}",
                  va="center", ha="left", fontsize=9, color=INK_MUTED)
    left.set_title(f"Points lost, of the {TOTAL_TASKS - SCORE:.1f} missing",
                   loc="left", fontsize=12, color=INK, pad=10)

    # ---- right: score ceiling if each class were resolved -------------------
    right = figure.add_subplot(grid[0, 1])
    style_axes(right)
    steps = [
        ("Today", None, 0.0),
        ("+ source data ingested", "Eval harness", lost["Source data unavailable"]),
        ("+ grain & entity key", "Agent analysis", lost["Grain & entity key"]),
        ("+ rest of agent analysis", "Agent analysis",
         sum(lost[r] for r, o in owner_of.items()
             if o == "Agent analysis" and r != "Grain & entity key")),
    ]
    running = SCORE
    labels, bases, adds, colours = [], [], [], []
    for label, owner, delta in steps:
        labels.append(label)
        bases.append(running)
        adds.append(delta)
        colours.append(OWNER_COLOUR[owner] if owner else EARNED)
        running += delta
    # Spread the 4 ladder rows across the left panel's y-range, so a bar is the
    # same thickness in both panels and the two read as one figure.
    span = len(reasons) - 1
    order = [span * (1 - index / (len(labels) - 1)) for index in range(len(labels))]

    right.barh(order, bases, height=0.6, color=EARNED, zorder=3)
    right.barh(order, adds, left=bases, height=0.6, color=colours, zorder=4,
               edgecolor=SURFACE, linewidth=2)
    right.set_yticks(order)
    right.set_yticklabels(labels, fontsize=10, color=INK)
    right.set_ylim(left.get_ylim())
    right.set_xlim(0, TOTAL_TASKS * 1.06)
    right.set_xticks([])
    right.axvline(TOTAL_TASKS, color=GRID, linewidth=1.5, zorder=2)
    right.text(TOTAL_TASKS + 0.8, span * 0.5, f"{TOTAL_TASKS} max", fontsize=9,
               color=INK_MUTED, va="center", ha="left", rotation=90)
    for slot, base, add in zip(order, bases, adds):
        total = base + add
        right.text(total + 1.4, slot, f"{total:.1f}   {100 * total / TOTAL_TASKS:.1f}%",
                   va="center", ha="left", fontsize=10, color=INK, fontweight="semibold")
    right.set_title("Score ceiling if that class were resolved",
                    loc="left", fontsize=12, color=INK, pad=10)

    # ---- titles and legend --------------------------------------------------
    figure.text(0.018, 0.950, f"What each KramaBench failure class costs",
                fontsize=17, color=INK, fontweight="semibold")
    figure.text(0.018, 0.903,
                f"DataFoundry with glm-5.3-flash, scoring {SCORE:.2f}/{TOTAL_TASKS} ({100 * SCORE / TOTAL_TASKS:.1f}%). "
                "All 47 shortfalls diagnosed from their traces. Counted in points, not tasks, because",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.018, 0.867,
                "partial credit means a near-miss costs a fraction of a point. Right panel is an upper bound, not a forecast.",
                fontsize=9.5, color=INK_SECOND)

    handles = [Patch(facecolor=OWNER_COLOUR[o], label=o) for o in present_owners]
    handles.append(Patch(facecolor=EARNED, label="Already earned"))
    figure.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.018, 0.815),
                  ncol=len(handles), frameon=False, fontsize=10,
                  handlelength=1.1, handleheight=1.1, columnspacing=1.5, labelcolor=INK)

    out = HERE / "kramabench-failure-impact.png"
    figure.savefig(out, dpi=200, facecolor=SURFACE)
    print(f"wrote {out}")
    for reason in reversed(reasons):
        print(f"  {reason:28} {counts[reason]:2} tasks  {lost[reason]:5.2f} pts")


if __name__ == "__main__":
    main()
