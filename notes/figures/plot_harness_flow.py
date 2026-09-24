"""Slide-ready flow chart of a KramaBench question running through DataFoundry.

    python notes/figures/plot_harness_flow.py

Writes two 16:9 figures (PNG at 300 dpi for PowerPoint, SVG for scaling) next to
this script:
  harness-flow.png/.svg                   the pipeline, stage by stage
  harness-flow-wildfire-easy-9.png/.svg   the same pipeline, annotated with what
                                          went wrong at each stage for wildfire-easy-9

The stage order is taken from run-6b350c16's event stream: route, requirement
extraction, schema inspection, contract grounding, the plan/validate/execute/
check/bind loop, the claims commit and the completion policy. LLM badges mark
the stages where a model call decides the outcome (route classifier, requirement
extractor, contract grounder, the agent writing SQL and claims).
"""

from __future__ import annotations

import pathlib
import textwrap

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Patch  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
W, H = 13.333, 7.5  # inches: a 16:9 slide

SURFACE = "#ffffff"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
ARROW = "#8a8883"
# Owner colours from the validated palette used by the failure charts.
HARNESS, HARNESS_FILL = "#f2913f", "#fdf0e4"
RUNTIME, RUNTIME_FILL = "#2a78d6", "#e8f1fc"
LLM = "#4a3aa7"
CRITICAL = "#c62828"  # status colour: only on failure call-outs, always with ✕ and text

MARGIN, GAP = 0.5, 0.3
BOX_W = (W - 2 * MARGIN - 5 * GAP) / 6
BOX_H = 1.15
ROW1_Y, ROW2_Y = 4.15, 1.45


def x_of(column: int) -> float:
    return MARGIN + column * (BOX_W + GAP)


# (row, column, owner, title, detail, uses_llm)
STAGES = [
    (1, 0, "harness", "KramaBench task", "Question, its data lake, and the answer type used for grading", False),
    (1, 1, "harness", "Ingest the lake", "SUT loads csv / xlsx / html / json files into one DuckDB datasource", False),
    (1, 2, "harness", "Send the question", "Question + FINAL_ANSWER format rule sent to the DataFoundry API", False),
    (1, 3, "runtime", "Route", "Classifier picks the data-analysis protocol", True),
    (1, 4, "runtime", "Extract requirements", "From the question text only, before any schema: R1, R2 … in prose", True),
    (1, 5, "runtime", "Inspect the data", "List sources, inspect schema, resolve semantic context", False),
    (2, 0, "runtime", "Ground the contract", "Turn each requirement into checkable assertions: tables, filters, grain", True),
    (2, 1, "runtime", "Query loop  ↻", "Plan → validate → run read-only SQL → check result → bind evidence", True),
    (2, 2, "runtime", "Commit claims", "One claim per requirement, bound to SQL evidence", True),
    (2, 3, "runtime", "Completion check", "All requirements evidenced? Completed or degraded", False),
    (2, 4, "harness", "Extract the answer", "SUT reads the FINAL_ANSWER line of the last message", False),
    (2, 5, "harness", "Grade", "Answer type picks the metric; score against the expected value", False),
]

# wildfire-easy-9, keyed by (row, column). Row-1 notes sit above, row-2 notes below.
CALLOUTS = {
    (1, 4): "R2 sets the formula: deaths − average baseline, a total minus a per-fire rate",
    (2, 0): "No checks attached: grounder returned empty output (87% of runs)",
    (2, 1): "SQL: SUM − AVG = 26 − 0.0182 = 25.98",
    (2, 2): "Checked only against R2's text (the wrong formula)",
    (2, 5): "+25.9818 vs −0.0059 expected: score 0",
}
EXTRA_DETAIL = {(2, 1): "7 queries in this run"}


def draw_box(ax, row: int, column: int, owner: str, title: str, detail: str, uses_llm: bool, extra: str | None):
    x, y = x_of(column), ROW1_Y if row == 1 else ROW2_Y
    edge, fill = (HARNESS, HARNESS_FILL) if owner == "harness" else (RUNTIME, RUNTIME_FILL)
    ax.add_patch(FancyBboxPatch((x, y), BOX_W, BOX_H, boxstyle="round,pad=0,rounding_size=0.09",
                                linewidth=1.6, edgecolor=edge, facecolor=fill, zorder=3))
    ax.text(x + 0.13, y + BOX_H - 0.17, title, ha="left", va="top", fontsize=11.5,
            fontweight="semibold", color=INK, zorder=4)
    lines = textwrap.wrap(detail, 29, break_on_hyphens=False)
    if extra:
        lines.append(extra)
    ax.text(x + 0.13, y + BOX_H - 0.47, "\n".join(lines), ha="left", va="top", fontsize=8.8,
            color=INK_SECOND, linespacing=1.3, zorder=4)
    if uses_llm:
        ax.add_patch(FancyBboxPatch((x + BOX_W - 0.55, y + BOX_H - 0.09), 0.4, 0.18,
                                    boxstyle="round,pad=0,rounding_size=0.09",
                                    linewidth=0, facecolor=LLM, zorder=5))
        ax.text(x + BOX_W - 0.35, y + BOX_H, "LLM", ha="center", va="center",
                fontsize=7.5, fontweight="bold", color="#ffffff", zorder=6)


def draw_callout(ax, row: int, column: int, text: str):
    centre = x_of(column) + BOX_W / 2
    width, wrap = (BOX_W * 1.5, 42) if row == 1 else (BOX_W, 23)
    lines = textwrap.wrap(text, wrap, break_on_hyphens=False)
    height = 0.16 + 0.145 * len(lines)
    if row == 1:
        y = ROW1_Y + BOX_H + 0.44
        anchor_from, anchor_to = y, ROW1_Y + BOX_H + 0.1
    else:
        y = ROW2_Y - 0.28 - height
        anchor_from, anchor_to = ROW2_Y - 0.28, ROW2_Y
    ax.plot([centre] * 2, [anchor_from, anchor_to], color=CRITICAL, linewidth=1.2, zorder=2)
    x = centre - width / 2
    ax.add_patch(FancyBboxPatch((x, y), width, height, boxstyle="round,pad=0,rounding_size=0.07",
                                linewidth=1.2, edgecolor=CRITICAL, facecolor=SURFACE, zorder=3))
    ax.text(x + 0.1, y + height - 0.1, "✕", ha="left", va="top", fontsize=10,
            fontweight="bold", color=CRITICAL, zorder=4)
    ax.text(x + 0.3, y + height - 0.1, "\n".join(lines), ha="left", va="top",
            fontsize=8.3, color=INK, linespacing=1.25, zorder=4)


def arrow(ax, start, end, **kwargs):
    ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>", mutation_scale=13, linewidth=1.4,
                                 color=ARROW, shrinkA=0, shrinkB=0, zorder=2, **kwargs))


def group_label(ax, first: int, last: int, y: float, text: str, color: str):
    left, right = x_of(first), x_of(last) + BOX_W
    ax.plot([left, right], [y, y], color=color, linewidth=2.2, solid_capstyle="butt", zorder=2)
    ax.text(left, y + 0.06, text.upper(), ha="left", va="bottom", fontsize=8.5,
            fontweight="bold", color=color, zorder=2)


def render(annotated: bool) -> pathlib.Path:
    plt.rcParams["font.family"] = ["Segoe UI", "Segoe UI Symbol", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(W, H), facecolor=SURFACE)
    ax = figure.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")

    ax.text(MARGIN, H - 0.42, "How a KramaBench question runs through DataFoundry",
            ha="left", va="top", fontsize=20, fontweight="semibold", color=INK)
    subtitle = ("wildfire-easy-9: “How many more or less fatalities occurred due to wildfires on days with "
                "humidity less than 30% compared to the average?”   Expected −0.0059, answered +25.9818."
                if annotated else
                "From benchmark task to graded answer. Stage order taken from a real run's event stream.")
    ax.text(MARGIN, H - 0.95, subtitle, ha="left", va="top", fontsize=10.5, color=INK_SECOND)

    # Lane labels sit on thin rules above each group of boxes.
    rule_1 = ROW1_Y + BOX_H + 0.2
    rule_2 = ROW2_Y + BOX_H + 0.2
    group_label(ax, 0, 2, rule_1, "KramaBench harness", HARNESS)
    group_label(ax, 3, 5, rule_1, "DataFoundry run: set up", RUNTIME)
    group_label(ax, 0, 3, rule_2, "DataFoundry run: answer", RUNTIME)
    group_label(ax, 4, 5, rule_2, "KramaBench harness", HARNESS)

    for row, column, owner, title, detail, uses_llm in STAGES:
        extra = EXTRA_DETAIL.get((row, column)) if annotated else None
        draw_box(ax, row, column, owner, title, detail, uses_llm, extra)

    # Arrows within each row.
    for row_y in (ROW1_Y, ROW2_Y):
        for column in range(5):
            arrow(ax, (x_of(column) + BOX_W, row_y + BOX_H / 2), (x_of(column + 1), row_y + BOX_H / 2))
    # Wrap from the end of row 1 to the start of row 2, routed between the rows.
    mid = (ROW1_Y + rule_2 + 0.2) / 2
    end_x, lane_x, row2_mid = x_of(5) + BOX_W / 2, MARGIN - 0.25, ROW2_Y + BOX_H / 2
    ax.plot([end_x, end_x, lane_x, lane_x], [ROW1_Y, mid, mid, row2_mid],
            color=ARROW, linewidth=1.4, zorder=2)
    arrow(ax, (lane_x, row2_mid), (x_of(0), row2_mid))

    if annotated:
        for (row, column), text in CALLOUTS.items():
            draw_callout(ax, row, column, text)

    handles = [Patch(facecolor=HARNESS_FILL, edgecolor=HARNESS, linewidth=1.4, label="KramaBench harness"),
               Patch(facecolor=RUNTIME_FILL, edgecolor=RUNTIME, linewidth=1.4, label="DataFoundry run"),
               Patch(facecolor=LLM, edgecolor=LLM, label="LLM decides this step")]
    if annotated:
        handles.append(Patch(facecolor=SURFACE, edgecolor=CRITICAL, linewidth=1.2,
                             label="✕  what went wrong in this run"))
    figure.legend(handles=handles, loc="lower left", bbox_to_anchor=(MARGIN / W, 0.012), ncol=len(handles),
                  frameon=False, fontsize=9.5, handlelength=1.3, handleheight=1.0, columnspacing=1.8,
                  labelcolor=INK)

    stem = "harness-flow-wildfire-easy-9" if annotated else "harness-flow"
    for suffix, kwargs in ((".png", {"dpi": 300}), (".svg", {})):
        figure.savefig(HERE / f"{stem}{suffix}", facecolor=SURFACE, **kwargs)
    plt.close(figure)
    return HERE / f"{stem}.png"


if __name__ == "__main__":
    for annotated in (False, True):
        print(f"wrote {render(annotated)} (+ .svg)")
