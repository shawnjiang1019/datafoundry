"""Chart the KramaBench failure causes recorded in kramabench_failure_causes.csv.

    python notes/figures/plot_failure_causes.py

Writes kramabench-failure-causes.png next to the CSV. Colours encode who owns the fix
and were validated for colour-vision separation (blue/orange/aqua/violet, all-pairs).
Every bar carries its count, so colour never has to be read alone.
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

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"
OWNER_COLOUR = {
    "Agent analysis": "#2a78d6",
    "DataFoundry platform": "#eb6834",
    "Eval harness": "#1baf7a",
    "Benchmark or infrastructure": "#4a3aa7",
    "Unclassified": "#898781",
}
DOMAIN_ORDER = ["legal", "wildfire", "biomedical", "archeology", "environment", "astronomy"]
DOMAIN_TASKS = {"legal": 30, "wildfire": 21, "biomedical": 9,
                "archeology": 12, "environment": 20, "astronomy": 12}


def load_rows() -> list[dict]:
    with (HERE / "kramabench_failure_causes.csv").open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def style_axes(axes) -> None:
    axes.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        axes.spines[side].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(colors=INK_MUTED, length=0, labelsize=9)


def main() -> None:
    rows = load_rows()
    owner_of = {row["cause"]: row["owner"] for row in rows}
    cause_counts = Counter(row["cause"] for row in rows)
    # Group causes by owner, then by size, so same-coloured bars sit together.
    owner_totals = Counter(row["owner"] for row in rows)
    ordered_owners = [owner for owner, _ in owner_totals.most_common()]
    causes = sorted(cause_counts,
                    key=lambda cause: (ordered_owners.index(owner_of[cause]), -cause_counts[cause]))
    causes.reverse()  # barh draws bottom-up

    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(13.5, 7.4), facecolor=SURFACE)
    grid = figure.add_gridspec(1, 2, width_ratios=[1.55, 1], wspace=0.32,
                               left=0.255, right=0.975, top=0.735, bottom=0.10)

    # ---- left: causes ------------------------------------------------------
    left = figure.add_subplot(grid[0, 0])
    style_axes(left)
    positions = range(len(causes))
    values = [cause_counts[cause] for cause in causes]
    left.barh(list(positions), values, height=0.62,
              color=[OWNER_COLOUR[owner_of[cause]] for cause in causes], zorder=3)
    left.set_yticks(list(positions))
    left.set_yticklabels(causes, fontsize=10, color=INK)
    left.set_xlim(0, max(values) + 1.6)
    left.set_xticks([])
    left.xaxis.grid(False)
    for position, value in zip(positions, values):
        left.text(value + 0.16, position, str(value), va="center", ha="left",
                  fontsize=10, color=INK, fontweight="semibold")
    left.set_title("Cause of the 48 answers that fell short",
                   loc="left", fontsize=12, color=INK, pad=10)

    # ---- right: per-domain composition -------------------------------------
    right = figure.add_subplot(grid[0, 1])
    style_axes(right)
    by_domain: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        by_domain[row["domain"]][row["owner"]] += 1
    domains = [d for d in DOMAIN_ORDER if d in by_domain][::-1]
    offsets = [0.0] * len(domains)
    for owner in ordered_owners:
        widths = [by_domain[domain][owner] for domain in domains]
        right.barh(range(len(domains)), widths, left=offsets, height=0.62,
                   color=OWNER_COLOUR[owner], zorder=3, edgecolor=SURFACE, linewidth=2)
        for index, (width, offset) in enumerate(zip(widths, offsets)):
            if width >= 2:  # label only segments with room
                right.text(offset + width / 2, index, str(width), va="center", ha="center",
                           fontsize=9, color="#ffffff", fontweight="semibold")
        offsets = [offset + width for offset, width in zip(offsets, widths)]
    right.set_yticks(range(len(domains)))
    right.set_yticklabels([f"{domain}\n{int(offsets[i])} of {DOMAIN_TASKS[domain]} tasks"
                           for i, domain in enumerate(domains)], fontsize=9.5, color=INK)
    right.set_xticks([])
    right.set_xlim(0, max(offsets) + 0.6)
    right.set_title("Where they came from", loc="left", fontsize=12, color=INK, pad=10)

    # ---- titles and legend --------------------------------------------------
    figure.text(0.018, 0.950, "Why 48 of 104 KramaBench answers fell short",
                fontsize=17, color=INK, fontweight="semibold")
    figure.text(0.018, 0.905,
                "DataFoundry with glm-5.3-flash. 56 answers were fully correct; the 48 below scored 0 or partial credit. "
                "Each task is counted once, under the earliest decision that, if corrected, would have produced the right answer.",
                fontsize=9.5, color=INK_SECOND)
    figure.legend(handles=[Patch(facecolor=OWNER_COLOUR[owner], label=owner) for owner in ordered_owners],
                  loc="upper left", bbox_to_anchor=(0.018, 0.860), ncol=len(ordered_owners),
                  frameon=False, fontsize=10, handlelength=1.1, handleheight=1.1,
                  columnspacing=1.6, labelcolor=INK_SECOND)
    figure.text(0.018, 0.028,
                "legal, wildfire and biomedical ran before the DuckDB, SQL-guard and schema-cap fixes; "
                "archeology, environment and astronomy after. Source: notes/kramabench-failure-analysis.md",
                fontsize=8.5, color=INK_MUTED)

    output = HERE / "kramabench-failure-causes.png"
    figure.savefig(output, dpi=200, facecolor=SURFACE)
    print(f"wrote {output}")
    print(f"{len(rows)} tasks, {len(causes)} causes")
    for owner in ordered_owners:
        print(f"  {owner_totals[owner]:3}  {owner}")


if __name__ == "__main__":
    main()
