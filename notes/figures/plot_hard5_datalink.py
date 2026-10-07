"""biomedical-hard-5 with and without DataLink: one tile per run.

    python notes/figures/plot_hard5_datalink.py

Writes kramabench-hard5-datalink.png. Data is every completed hard-5 run on
2026-10-01 (current platform), read from the DataFoundry trace: the semantic
provider, and which table the final MEDIAN query read Log2_variant_per_Mbp from
(mmc7 = gold source, 2.6563; mmc1 = 2.4241). In all eight runs the contract
grounder produced only manual requirements, so DataLink's output never reached
the agent; the split is the agent's own run-to-run variation.
"""

from __future__ import annotations

import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyBboxPatch  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent

# (run id, UTC start, final source table)
RUNS = {
    "DataLink on": [
        ("run-4d4928f2", "17:11", "mmc7"),
        ("run-c4fd11b4", "19:07", "mmc7"),
        ("run-46c7fa5c", "19:21", "mmc1"),
        ("run-dbc1a99f", "19:33", "mmc7"),
        ("run-7d0cc462", "19:40", "mmc1"),
    ],
    "DataLink off": [
        ("run-8d75740c", "18:03", "mmc7"),
        ("run-f4c52806", "18:04", "mmc7"),
        ("run-7ed0ce78", "18:49", "mmc1"),
    ],
}

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECOND = "#52514e"
INK_MUTED = "#898781"
# Validated pair from the owner palette (validate_palette.js --pairs all: PASS).
CORRECT = "#2a78d6"
WRONG = "#f2913f"


def main() -> None:
    plt.rcParams["font.family"] = ["Segoe UI", "DejaVu Sans", "sans-serif"]
    figure = plt.figure(figsize=(10, 4.2), facecolor=SURFACE)
    axes = figure.add_axes([0.03, 0.06, 0.94, 0.62])
    axes.set_xlim(0, 10)
    axes.set_ylim(0, 2.2)
    axes.axis("off")

    tile_w, tile_h, gap, x0 = 0.95, 0.72, 0.15, 2.0
    for row, (label, runs) in enumerate(RUNS.items()):
        y = 1.3 - row * 1.05
        axes.text(0.0, y + tile_h / 2, label, va="center", ha="left", fontsize=12.5,
                  color=INK, fontweight="semibold")
        for i, (_run_id, start, source) in enumerate(runs):
            x = x0 + i * (tile_w + gap)
            ok = source == "mmc7"
            axes.add_patch(FancyBboxPatch((x, y), tile_w, tile_h, boxstyle="round,pad=0,rounding_size=0.06",
                                          facecolor=CORRECT if ok else WRONG, edgecolor="none"))
            axes.text(x + tile_w / 2, y + tile_h * 0.62, "✓" if ok else "✗", ha="center", va="center",
                      fontsize=15, color="white", fontweight="bold")
            axes.text(x + tile_w / 2, y + tile_h * 0.25, source, ha="center", va="center",
                      fontsize=9.5, color="white")
            axes.text(x + tile_w / 2, y - 0.11, start, ha="center", va="center", fontsize=8, color=INK_MUTED)
        right = sum(1 for *_, s in runs if s == "mmc7")
        axes.text(x0 + 5 * (tile_w + gap) + 0.25, y + tile_h / 2,
                  f"{right} of {len(runs)} correct  ({100 * right / len(runs):.0f}%)",
                  va="center", ha="left", fontsize=12, color=INK, fontweight="semibold")

    figure.text(0.03, 0.9, "DataLink gave no advantage on biomedical-hard-5",
                fontsize=16, color=INK, fontweight="semibold")
    figure.text(0.03, 0.825,
                "Each tile is one run. Two tables share the column Log2_variant_per_Mbp; the agent picked "
                "mmc7 (gold, 2.6563) or mmc1 (2.4241)",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.03, 0.775,
                "about two times in three either way. DataLink's output only feeds the contract grounder, "
                "which produced no structured checks in any run.",
                fontsize=9.5, color=INK_SECOND)
    figure.text(0.03, 0.02, "Runs on 2026-10-01, times in UTC. The 18:03 run completed but was not graded "
                "(it overlapped the 18:04 run).", fontsize=8, color=INK_MUTED)

    out = HERE / "kramabench-hard5-datalink.png"
    figure.savefig(out, dpi=200, facecolor=SURFACE)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
