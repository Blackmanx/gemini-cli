#!/usr/bin/env python3
"""Report text boxes in a .pptx that overlap each other.

Overlap is the failure mode of these templates: every shape is sized for the
label the template shipped, so a longer sentence grows out of a circle, a card
or a title bar and prints over its neighbour. Nothing errors and the deck looks
fine until you render it.

The geometry comes from `officecli query`, so this only compares what that
already reports - it is a check, not a second way of editing the deck.

Usage:
    python3 check_overlaps.py deck.pptx [officecli-binary]
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

GEOMETRY = re.compile(
    r"x=(-?[\d.]+)emu y=(-?[\d.]+)emu width=([\d.]+)emu height=([\d.]+)emu"
)
LABEL = re.compile(r'\) "(.*?)"')


def binary(argument: str | None) -> str:
    if argument:
        return argument
    bundled = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "..", "vendor", "officecli", "officecli-linux-x64",
    )
    if os.path.exists(bundled):
        return os.path.normpath(bundled)
    return "officecli"


def boxes(officecli: str, deck: str, slide: int):
    out = subprocess.run(
        [officecli, "query", deck, f"/slide[{slide}]/*"],
        capture_output=True,
        text=True,
    ).stdout
    found = []
    for line in out.splitlines():
        geometry = GEOMETRY.search(line)
        label = LABEL.search(line)
        if not geometry or not label:
            continue
        text = label.group(1).strip()
        if not text:
            continue  # a decorative shape overlapping its neighbour is the design
        x, y, w, h = (float(v) for v in geometry.groups())
        found.append((text, x, y, x + w, y + h))
    return found


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    deck = sys.argv[1]
    if not os.path.exists(deck):
        raise SystemExit(f"no existe: {deck}")
    officecli = binary(sys.argv[2] if len(sys.argv) > 2 else None)

    total = 0
    slide = 1
    while True:
        found = boxes(officecli, deck, slide)
        if not found:
            break
        for a in range(len(found)):
            for b in range(a + 1, len(found)):
                t1, x1, y1, X1, Y1 = found[a]
                t2, x2, y2, X2, Y2 = found[b]
                if x1 < X2 and x2 < X1 and y1 < Y2 and y2 < Y1:
                    print(f"  slide {slide}: {t1!r} se solapa con {t2!r}")
                    total += 1
        slide += 1

    if total:
        print(f"\n{total} solape(s). Acorta el texto o baja el tamaño de la caja.")
        raise SystemExit(1)
    print(f"{deck}: sin solapes entre cajas con texto")


if __name__ == "__main__":
    sys.exit(main() or 0)