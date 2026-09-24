"""Slide-ready "key agent steps" diagrams for individual KramaBench failures.

    python notes/figures/plot_agent_steps.py              # every task below
    python notes/figures/plot_agent_steps.py wildfire-easy-9

Writes <task>-agent-steps.png (300 dpi) and .svg next to this script. Each
diagram shows only the agent's own steps, grouped into a few key moments, with
what the agent said it meant to do (quoted from its messages or tool arguments in
notes/traces/<task>.md) next to what it actually did and saw. Failed calls and
retries are folded into neighbouring rows and listed in the footnote.

Marker colour encodes the role a step played, the same in every diagram:
  made      red     the step that produced the wrong value
  evidence  amber   the agent had what it needed to catch or avoid it
  accepted  purple  the agent confirmed the wrong value
Colours were validated with the dataviz palette script; red and amber sit in the
CVD floor band, so every marker also carries its number and a text label.
"""

from __future__ import annotations

import pathlib
import sys
import textwrap

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, Rectangle  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
W, H = 13.333, 7.5

SURFACE = "#ffffff"
INK, INK_SECOND, INK_MUTED = "#0b0b0b", "#52514e", "#898781"
RULE, NEUTRAL_DOT = "#dedcd6", "#b9b7b0"
ROLES = {  # role: (colour, row tint)
    "made": ("#c62828", "#fdeeee"),
    "evidence": ("#b07400", "#fff6e0"),
    "accepted": ("#4a3aa7", "#f0eefb"),
}

X_GUTTER, X_STEP, X_INTENT, X_DID, X_END = 0.62, 0.95, 3.55, 8.15, 12.88
LINE_H = 0.168

TASKS = {
    "archeology-easy-8": dict(
        title="archeology-easy-8: how the agent arrived at the wrong count",
        subtitle=["“How many unique sources were used in the Roman cities dataset?”   Expected 52, answered 55.   "
                  "Key steps only, with the agent's stated intention at each one."],
        rows=[
            dict(steps="Steps 5–8", title="Look at the data", mark=None,
                 intent="“The roman_cities table has a ‘Select Bibliography’ column which likely holds the "
                        "source references. Let me preview the table to understand the data shape.”",
                 did="Previewed 10 rows. Each city lists its sources in one text cell, e.g.  "
                     "BNP; DGRG; PECS; Sear 2006."),
            dict(steps="Steps 9–13", title="Count the sources", mark=(1, "made", "MADE THE WRONG COUNT"),
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
            dict(steps="Steps 20–24", title="Read the whole list", mark=(2, "evidence", "SHOWED THE PROBLEM"),
                 intent="“Let me fetch the remaining low-frequency entries with a filter.” … "
                        "“Almost there — 12 low-frequency entries remain.”",
                 did="The last page shows DGRG? · PECS? · PEC · Sear 2006PECS · 1995. None is a new source: "
                     "typos of sources already counted, two citations missing a “;”, and a year with no author."),
            dict(steps="Step 25", title="Settle the count", mark=(3, "accepted", "ACCEPTED IT"),
                 intent="“Complete picture now. … Let me commit both requirements with this evidence.”",
                 did="Kept all five as separate sources: “55 non-empty unique sources (including one malformed "
                     "token '1995' and one 'Sear 2006PECS', which are distinct strings as recorded).”"),
            dict(steps="Steps 29–30", title="Answer", mark=None,
                 intent="“The analysis is complete.”",
                 did="FINAL_ANSWER: 55.  Expected 52: for example, merging DGRG?, PECS? and PEC into DGRG "
                     "and PECS gives 52."),
        ],
        footnote="Folded into the rows: setup (steps 1–4) and failed or rejected calls with their retries "
                 "(6–7, 10–12, 17–19, 26–28).   Full trace: notes/traces/archeology-easy-8.md",
    ),
    "wildfire-easy-9": dict(
        title="wildfire-easy-9: how the agent arrived at the wrong number",
        subtitle=["“How many more or less fatalities occurred due to wildfires on days with humidity less than 30% "
                  "compared to the average?”",
                  "Expected −0.0059, answered +25.9818.   Grain error: a total over many fires was compared "
                  "with an average per fire.   Key steps only, with the agent's stated intention at each one."],
        rows=[
            dict(steps="Steps 1–8", title="Explore the fires table", mark=None,
                 intent="No message before these calls. Its own search query (step 7): "
                        "“wildfire fatalities humidity avrh_mean dataset definition”",
                 did="6,658 rows, one per fire, each with its average humidity (3–86%) and its deaths. "
                     "121 deaths in total."),
            dict(steps="Steps 9–15", title="Gather the numbers", mark=(1, "evidence", "HAD WHAT IT NEEDED"),
                 intent="“The connection dropped. Let me re-establish it.”  (Steps 9–12 failed on a "
                        "closed database connection.)",
                 did="One query returns 2,018 low-humidity fires, 26 deaths among them, and 0.0182 deaths per "
                     "fire overall. Deaths per low-humidity fire, 26 ÷ 2,018 = 0.0129, is one division away."),
            dict(steps="Steps 16–17", title="Compute the difference", mark=(2, "made", "MADE THE WRONG NUMBER"),
                 intent="“Now let me compute the difference per the requirement definition (low-humidity "
                        "fatalities − average baseline) in one query.”",
                 did="SQL: low_fatal − avg_fatal, a total over 2,018 fires minus an average per fire: "
                     "26 − 0.0182 = 25.98. The same query returns low_rows = 2,018 and never divides by it."),
            dict(steps="Steps 18–21", title="Report", mark=(3, "accepted", "ACCEPTED IT"),
                 intent="“The calculation is complete and validated. Let me commit the evidenced requirements.”",
                 did="FINAL_ANSWER: 25.9818, concluding “low-humidity days saw far more wildfire fatalities.” "
                     "Per fire it is 0.0129 vs 0.0182, i.e. fewer. Expected −0.0059."),
        ],
        footnote="Folded into the rows: failed calls and retries (4–5, 7, 9–12, 14, 19). The formula at step 16 "
                 "comes from requirement R2, written before the agent saw any data.   "
                 "Full trace: notes/traces/wildfire-easy-9.md",
    ),
}


def wrap(text: str, width: int) -> list[str]:
    return textwrap.wrap(text, width, break_on_hyphens=False)


def render(task_id: str, spec: dict) -> pathlib.Path:
    plt.rcParams["font.family"] = ["Segoe UI", "Segoe UI Symbol", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(W, H), facecolor=SURFACE)
    ax = figure.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")

    left = X_STEP - 0.45
    ax.text(left, H - 0.4, spec["title"], ha="left", va="top", fontsize=19, fontweight="semibold", color=INK)
    for index, line in enumerate(spec["subtitle"]):
        ax.text(left, H - 0.9 - index * 0.25, line, ha="left", va="top", fontsize=10.2, color=INK_SECOND)

    header_y = 6.02 - 0.2 * (len(spec["subtitle"]) - 1)
    for x, label in ((X_STEP, "STEP"), (X_INTENT, "WHAT IT MEANT TO DO  ·  in its own words"),
                     (X_DID, "WHAT IT DID AND SAW")):
        ax.text(x, header_y, label, ha="left", va="bottom", fontsize=8.5, fontweight="bold", color=INK_SECOND)
    ax.plot([X_STEP - 0.1, X_END], [header_y - 0.06] * 2, color=INK_MUTED, linewidth=1.2)

    y = header_y - 0.18
    centres = []
    for row in spec["rows"]:
        intent_lines = wrap(row["intent"], 66)
        did_lines = wrap(row["did"], 72)
        mark = row["mark"]
        step_block = 0.84 if mark else 0.44
        height = max(step_block, LINE_H * max(len(intent_lines), len(did_lines)) + 0.12) + 0.14
        top, bottom = y, y - height
        if mark:
            colour, tint = ROLES[mark[1]]
            ax.add_patch(Rectangle((X_STEP - 0.1, bottom + 0.03), X_END - X_STEP + 0.1, height - 0.06,
                                   facecolor=tint, edgecolor="none", zorder=1))
            ax.add_patch(Rectangle((X_STEP - 0.1, bottom + 0.03), 0.06, height - 0.06,
                                   facecolor=colour, edgecolor="none", zorder=2))
        ax.text(X_STEP + 0.05, top - 0.1, row["steps"].upper(), ha="left", va="top", fontsize=7.8,
                fontweight="bold", color=INK_MUTED, zorder=3)
        ax.text(X_STEP + 0.05, top - 0.28, row["title"], ha="left", va="top", fontsize=11.5,
                fontweight="semibold", color=INK, zorder=3)
        if mark:
            # The pill is the text's own bbox, so it always fits the label.
            ax.text(X_STEP + 0.12, top - 0.7, f"{mark[0]}  {mark[2]}", ha="left", va="center", fontsize=7.8,
                    fontweight="bold", color="#ffffff", zorder=4,
                    bbox=dict(boxstyle="round,pad=0.35,rounding_size=0.8", facecolor=ROLES[mark[1]][0],
                              edgecolor="none"))
        ax.text(X_INTENT, top - 0.12, "\n".join(intent_lines), ha="left", va="top", fontsize=9.5,
                style="italic", color=INK_SECOND, linespacing=1.32, zorder=3)
        ax.text(X_DID, top - 0.12, "\n".join(did_lines), ha="left", va="top", fontsize=9.5,
                color=INK, linespacing=1.32, zorder=3)
        ax.plot([X_STEP - 0.1, X_END], [bottom, bottom], color=RULE, linewidth=0.8, zorder=0)
        centres.append((top - 0.2, mark))
        y = bottom

    ax.plot([X_GUTTER, X_GUTTER], [centres[0][0], centres[-1][0]], color=RULE, linewidth=2, zorder=1)
    for cy, mark in centres:
        if mark:
            ax.add_patch(Circle((X_GUTTER, cy), 0.13, facecolor=ROLES[mark[1]][0], edgecolor=SURFACE,
                                linewidth=2, zorder=4))
            ax.text(X_GUTTER, cy, str(mark[0]), ha="center", va="center", fontsize=8.5, fontweight="bold",
                    color="#ffffff", zorder=5)
        else:
            ax.add_patch(Circle((X_GUTTER, cy), 0.07, facecolor=NEUTRAL_DOT, edgecolor=SURFACE,
                                linewidth=1.5, zorder=4))

    ax.text(left, 0.42, spec["footnote"], ha="left", va="center", fontsize=8.5, color=INK_MUTED)

    stem = HERE / f"{task_id}-agent-steps"
    for suffix, kwargs in ((".png", {"dpi": 300}), (".svg", {})):
        figure.savefig(f"{stem}{suffix}", facecolor=SURFACE, **kwargs)
    plt.close(figure)
    print(f"wrote {stem}.png (+ .svg); last row ends at y={y:.2f}")
    return pathlib.Path(f"{stem}.png")


if __name__ == "__main__":
    for task_id in sys.argv[1:] or TASKS:
        render(task_id, TASKS[task_id])
