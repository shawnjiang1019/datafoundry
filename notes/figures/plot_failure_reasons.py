"""Chart the failure reasons recorded in kramabench_failure_reasons.csv.

    python notes/figures/plot_failure_reasons.py

Writes kramabench-failure-reasons.png next to the CSV. This is the post-rerun
taxonomy: it supersedes plot_failure_causes.py, which predates the infrastructure
fixes and so still attributes astronomy to a dead provider rather than to formats
the lake loader cannot read.

Colour encodes who owns the fix and was validated all-pairs for colour-vision
separation (blue/orange/green/violet). "Pending rerun" is deliberately neutral
grey: it is the absence of a diagnosis, not a category of one. Every bar carries
its count and its own axis label, so colour never has to be read alone; hatching
marks the six tasks this pass moved out of the category they were first filed under.
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
DOMAIN_ORDER = ["legal", "wildfire", "biomedical", "archeology", "environment", "astronomy"]
DOMAIN_TASKS = {"legal": 30, "wildfire": 21, "biomedical": 9,
                "archeology": 12, "environment": 20, "astronomy": 12}


def load_rows() -> list[dict]:
    with (HERE / "kramabench_failure_reasons.csv").open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def style_axes(axes) -> None:
    axes.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        axes.spines[side].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(colors=INK_MUTED, length=0, labelsize=9)


def main() -> None:
    rows = load_rows()
    owner_of = {row["reason"]: row["owner"] for row in rows}
    counts = Counter(row["reason"] for row in rows)
    moved = Counter(row["reason"] for row in rows if row["evidence"] == "reclassified")
    lost = defaultdict(float)
    for row in rows:
        lost[row["owner"]] += 1.0 - float(row["score"])

    present_owners = [o for o in OWNER_ORDER if any(r["owner"] == o for r in rows)]
    # Group reasons by owner, then by size, so same-coloured bars sit together.
    reasons = sorted(counts, key=lambda r: (present_owners.index(owner_of[r]), -counts[r]))
    reasons.reverse()  # barh draws bottom-up

    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(13.5, 7.8), facecolor=SURFACE)
    grid = figure.add_gridspec(1, 2, width_ratios=[1.62, 1], wspace=0.34,
                               left=0.215, right=0.975, top=0.695, bottom=0.055)

    # ---- left: reasons, split verified / carried forward -------------------
    left = figure.add_subplot(grid[0, 0])
    style_axes(left)
    positions = list(range(len(reasons)))
    total = [counts[r] for r in reasons]
    held = [counts[r] - moved[r] for r in reasons]
    changed = [moved[r] for r in reasons]
    colours = [OWNER_COLOUR[owner_of[r]] for r in reasons]

    left.barh(positions, held, height=0.62, color=colours, zorder=3)
    left.barh(positions, changed, left=held, height=0.62, color=colours, zorder=3,
              alpha=0.42, hatch="///", edgecolor=SURFACE, linewidth=2)
    left.set_yticks(positions)
    left.set_yticklabels(reasons, fontsize=10, color=INK)
    left.set_xlim(0, max(total) + 1.8)
    left.set_xticks([])
    for position, value in zip(positions, total):
        left.text(value + 0.18, position, str(value), va="center", ha="left",
                  fontsize=10, color=INK, fontweight="semibold")
    left.set_title(f"Reason the {len(rows)} shortfalls fell short",
                   loc="left", fontsize=12, color=INK, pad=10)

    # ---- right: points lost per owner --------------------------------------
    right = figure.add_subplot(grid[0, 1])
    style_axes(right)
    owners = [o for o in present_owners][::-1]
    widths = [lost[o] for o in owners]
    # Share the left panel's row pitch so both panels' bars read as the same mark,
    # top-aligned: 5 owners hung from the top of a 12-slot axis.
    slots = [len(reasons) - 1 - i for i in range(len(owners))][::-1]
    right.barh(slots, widths, height=0.62,
               color=[OWNER_COLOUR[o] for o in owners], zorder=3)
    right.set_yticks(slots)
    right.set_yticklabels(owners, fontsize=10, color=INK)
    right.set_ylim(left.get_ylim())
    right.set_xticks([])
    right.set_xlim(0, max(widths) + 2.4)
    for slot, width in zip(slots, widths):
        right.text(width + 0.3, slot, f"{width:.1f}", va="center", ha="left",
                   fontsize=10, color=INK, fontweight="semibold")
    right.set_title(f"Points lost, of {TOTAL_TASKS - SCORE:.1f} missing",
                    loc="left", fontsize=12, color=INK, pad=10)

    # ---- titles and legend --------------------------------------------------
    figure.text(0.018, 0.952, f"Why {len(rows)} of {TOTAL_TASKS} KramaBench answers fall short",
                fontsize=17, color=INK, fontweight="semibold")
    figure.text(0.018, 0.907,
                f"DataFoundry with glm-5.3-flash, scoring {SCORE:.2f}/{TOTAL_TASKS} ({100 * SCORE / TOTAL_TASKS:.1f}%). "
                "Each task is counted once, under the earliest decision that, if corrected,",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.018, 0.871,
                "would have produced the right answer. Partial credit means a task can cost less than a whole point.",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.018, 0.835,
                "All 47 diagnosed from their traces. Hatched = reclassified this pass; the earlier taxonomy had it elsewhere.",
                fontsize=9.5, color=INK_MUTED)

    handles = [Patch(facecolor=OWNER_COLOUR[o], label=o) for o in present_owners]
    figure.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.018, 0.793),
                  ncol=len(present_owners), frameon=False, fontsize=10,
                  handlelength=1.1, handleheight=1.1, columnspacing=1.5,
                  labelcolor=INK)

    out = HERE / "kramabench-failure-reasons.png"
    figure.savefig(out, dpi=200, facecolor=SURFACE)
    print(f"wrote {out}")
    print(f"  {len(rows)} shortfalls, {sum(moved.values())} reclassified this pass")
    for owner in present_owners:
        n = sum(1 for r in rows if r["owner"] == owner)
        print(f"  {owner:18} {n:2} tasks  {lost[owner]:5.2f} points")


if __name__ == "__main__":
    main()
