"""Slide-ready diagram of the key agent steps in archeology-easy-8 (run-0eaf498b).

    python notes/figures/plot_archeology_easy_8_steps.py

Writes archeology-easy-8-agent-steps.png (300 dpi) and .svg next to this script.
Only the agent's own steps are drawn, grouped into six key moments, each with
what the agent said it meant to do (quoted from its messages in
notes/traces/archeology-easy-8.md) next to what it actually did and saw.
Failed calls and retries are folded into the rows around them.

Three markers separate cause from missed warning from decision:
  1  made the wrong count   (step 13: the matching rule TRIM(src, ' .'))
  2  showed the problem      (step 24: the list shows five non-sources)
  3  accepted it             (step 25: "distinct strings as recorded")
Marker colours were validated with the dataviz palette script; red and amber
sit in the CVD floor band, so every marker also carries its number and label.
"""

from __future__ import annotations

import pathlib
import textwrap

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, FancyBboxPatch, Rectangle  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
W, H = 13.333, 7.5

SURFACE = "#ffffff"
INK, INK_SECOND, INK_MUTED = "#0b0b0b", "#52514e", "#898781"
RULE, NEUTRAL_DOT = "#dedcd6", "#b9b7b0"
# number: (colour, row tint, label)
MARKERS = {
    1: ("#c62828", "#fdeeee", "MADE THE WRONG COUNT"),
    2: ("#b07400", "#fff6e0", "SHOWED THE PROBLEM"),
    3: ("#4a3aa7", "#f0eefb", "ACCEPTED IT"),
}

X_GUTTER, X_STEP, X_INTENT, X_DID, X_END = 0.62, 0.95, 3.55, 8.15, 12.88
LINE_H = 0.168

ROWS = [
    dict(steps="Steps 5–8", title="Look at the data", mark=None,
         intent="“The roman_cities table has a ‘Select Bibliography’ column which likely holds the "
                "source references. Let me preview the table to understand the data shape.”",
         did="Previewed 10 rows. Each city lists its sources in one text cell, e.g.  "
             "BNP; DGRG; PECS; Sear 2006."),
    dict(steps="Steps 9–13", title="Count the sources", mark=1,
         intent="“The column contains semicolon-separated source citations … I'll split these into "
                "individual sources and count distinct ones.”",
         did="Split every list on “;” (7,556 mentions). Matching rule: two mentions are the same source "
             "only if the text is identical after removing spaces and full stops, TRIM(src, ' .'). "
             "Result: 55 sources. Under this rule PECS, PECS? and PEC count as three different sources."),
    dict(steps="Steps 14–16", title="Check the rule", mark=None,
         intent="“The dedup count is sensitive to trailing periods … Let me audit the distinct source "
                "list to confirm the normalization is right.”",
         did="Looked at the first 20 entries, A–Z (output is capped at 20 rows). “1995” is already "
             "among them. Concluded: “The normalization looks correct.”"),
    dict(steps="Steps 20–24", title="Read the whole list", mark=2,
         intent="“Let me fetch the remaining low-frequency entries with a filter.” … "
                "“Almost there — 12 low-frequency entries remain.”",
         did="The last page shows DGRG? · PECS? · PEC · Sear 2006PECS · 1995. None is a new source: "
             "typos of sources already counted, two citations missing a “;”, and a year with no author."),
    dict(steps="Step 25", title="Settle the count", mark=3,
         intent="“Complete picture now. … Let me commit both requirements with this evidence.”",
         did="Kept all five as separate sources: “55 non-empty unique sources (including one malformed "
             "token '1995' and one 'Sear 2006PECS', which are distinct strings as recorded).”"),
    dict(steps="Steps 29–30", title="Answer", mark=None,
         intent="“The analysis is complete.”",
         did="FINAL_ANSWER: 55.  Expected 52: for example, merging DGRG?, PECS? and PEC into DGRG "
             "and PECS gives 52."),
]


def wrap(text: str, width: int) -> list[str]:
    return textwrap.wrap(text, width, break_on_hyphens=False)


def main():
    plt.rcParams["font.family"] = ["Segoe UI", "Segoe UI Symbol", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(W, H), facecolor=SURFACE)
    ax = figure.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")

    ax.text(X_STEP - 0.45, H - 0.4, "archeology-easy-8: how the agent arrived at the wrong count",
            ha="left", va="top", fontsize=19, fontweight="semibold", color=INK)
    ax.text(X_STEP - 0.45, H - 0.9,
            "“How many unique sources were used in the Roman cities dataset?”   Expected 52, answered 55.   "
            "Key steps only, with the agent's stated intention at each one.",
            ha="left", va="top", fontsize=10.2, color=INK_SECOND)

    header_y = 6.02
    for x, label in ((X_STEP, "STEP"), (X_INTENT, "WHAT IT MEANT TO DO  ·  in its own words"),
                     (X_DID, "WHAT IT DID AND SAW")):
        ax.text(x, header_y, label, ha="left", va="bottom", fontsize=8.5, fontweight="bold", color=INK_SECOND)
    ax.plot([X_STEP - 0.1, X_END], [header_y - 0.06] * 2, color=INK_MUTED, linewidth=1.2)

    y = header_y - 0.18
    centres = []
    for row in ROWS:
        intent_lines = wrap(row["intent"], 66)
        did_lines = wrap(row["did"], 72)
        step_block = 0.84 if row["mark"] else 0.44
        height = max(step_block, LINE_H * max(len(intent_lines), len(did_lines)) + 0.12) + 0.14
        top, bottom = y, y - height
        mark = MARKERS.get(row["mark"]) if row["mark"] else None
        if mark:
            ax.add_patch(Rectangle((X_STEP - 0.1, bottom + 0.03), X_END - X_STEP + 0.1, height - 0.06,
                                   facecolor=mark[1], edgecolor="none", zorder=1))
            ax.add_patch(Rectangle((X_STEP - 0.1, bottom + 0.03), 0.06, height - 0.06,
                                   facecolor=mark[0], edgecolor="none", zorder=2))
        # step cell
        ax.text(X_STEP + 0.05, top - 0.1, row["steps"].upper(), ha="left", va="top", fontsize=7.8,
                fontweight="bold", color=INK_MUTED, zorder=3)
        ax.text(X_STEP + 0.05, top - 0.28, row["title"], ha="left", va="top", fontsize=11.5,
                fontweight="semibold", color=INK, zorder=3)
        if mark:
            label = f"{row['mark']}  {mark[2]}"
            # The pill is the text's own bbox, so it always fits the label.
            ax.text(X_STEP + 0.12, top - 0.7, label, ha="left", va="center", fontsize=7.8,
                    fontweight="bold", color="#ffffff", zorder=4,
                    bbox=dict(boxstyle="round,pad=0.35,rounding_size=0.8", facecolor=mark[0],
                              edgecolor="none"))
        # intent and did cells
        ax.text(X_INTENT, top - 0.12, "\n".join(intent_lines), ha="left", va="top", fontsize=9.5,
                style="italic", color=INK_SECOND, linespacing=1.32, zorder=3)
        ax.text(X_DID, top - 0.12, "\n".join(did_lines), ha="left", va="top", fontsize=9.5,
                color=INK, linespacing=1.32, zorder=3)
        ax.plot([X_STEP - 0.1, X_END], [bottom, bottom], color=RULE, linewidth=0.8, zorder=0)
        centres.append((top - 0.2, row["mark"]))
        y = bottom

    # timeline gutter: one dot per key moment, numbered where it matters
    ax.plot([X_GUTTER, X_GUTTER], [centres[0][0], centres[-1][0]], color=RULE, linewidth=2, zorder=1)
    for cy, number in centres:
        if number:
            colour = MARKERS[number][0]
            ax.add_patch(Circle((X_GUTTER, cy), 0.13, facecolor=colour, edgecolor=SURFACE, linewidth=2, zorder=4))
            ax.text(X_GUTTER, cy, str(number), ha="center", va="center", fontsize=8.5, fontweight="bold",
                    color="#ffffff", zorder=5)
        else:
            ax.add_patch(Circle((X_GUTTER, cy), 0.07, facecolor=NEUTRAL_DOT, edgecolor=SURFACE,
                                linewidth=1.5, zorder=4))

    ax.text(X_STEP - 0.45, 0.42,
            "Folded into the rows: setup (steps 1–4) and failed or rejected calls with their retries "
            "(6–7, 10–12, 17–19, 26–28).   Full trace: notes/traces/archeology-easy-8.md",
            ha="left", va="center", fontsize=8.5, color=INK_MUTED)

    for suffix, kwargs in ((".png", {"dpi": 300}), (".svg", {})):
        figure.savefig(HERE / f"archeology-easy-8-agent-steps{suffix}", facecolor=SURFACE, **kwargs)
    print(f"wrote {HERE / 'archeology-easy-8-agent-steps.png'} (+ .svg); bottom of last row at y={y:.2f}")


if __name__ == "__main__":
    main()
