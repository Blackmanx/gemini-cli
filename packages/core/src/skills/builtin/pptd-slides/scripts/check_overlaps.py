#!/usr/bin/env python3
"""Report where a .pptx prints text over text, over a shape, or off the slide.

This is the check that stands between a filled deck and the screenshot the
customer sees. Every shape in a real template is sized for the label it
shipped with, so writing a real sentence into a card title grows the text out
of the box and straight over the paragraph underneath it. Nothing errors; the
deck only looks wrong when it is rendered.

Two defects are reported, and the second is the one that actually bites:

* **texto que se sale** - the text needs more lines than the shape is tall and
  the shape has no autofit, so it prints outside the shape.
* **texto sobre texto** - two runs of text land on the same pixels.

Both compare where the glyphs land, not where the boxes are, and that is the
whole trick. Comparing boxes is not enough, and neither is enough on its own:
a shape with `<a:spAutoFit/>` carries a `cy` frozen at the height of its
*original* one-line label, so the rectangle looks fine and the text still grows
over its neighbour. Comparing rendered text against a box whose rectangle is
honest catches it.

Geometry comes from a single `officecli query <deck> slide --json`, which
returns the whole tree in one call, and text is measured with Pillow against
whatever fontconfig resolves the deck's typeface to. Shape coordinates inside
a group are in the group's *child* coordinate space, so they are mapped
through the group's `childOffset`/`childExtent` before anything is compared -
skipping that step invents dozens of overlaps between shapes that are in fact
centimetres apart.

Usage:
    python3 check_overlaps.py deck.pptx [officecli-binary]
    python3 check_overlaps.py deck.pptx --capacity [/slide[N]]

`--capacity` is the other half: it prints what each shape can hold, so the text
is written to fit rather than measured after the fact.

Exit status is 0 when nothing is wrong and 1 when something is, so it can gate
a delivery.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from functools import lru_cache

EMU_PER_CM = 360_000
EMU_PER_PT = 12_700
EMU_PER_IN = 914_400
EMU_PER_MM = 36_000

UNIT = re.compile(r"^(-?[\d.]+)(emu|cm|mm|in|pt|px)?$")
SIZE = re.compile(r"^([\d.]+)pt$")
SPACING = re.compile(r"^([\d.]+)x$")


# Two text runs that share less than this on either axis are touching line
# boxes, not glyphs. Measured against the template, whose untouched slides
# graze constantly, this separates every real collision from every graze.
MIN_OVERLAP_EMU = 200_000

# A run of text is laid out in N lines; N = ceil(width of the string / width of
# the line) once broken into words. Wrapping is greedy on spaces, which is what
# PowerPoint does, so the line count is the same one the renderer will produce.
# Trailing safety keeps borderline strings from flipping between runs.
LINE_SAFETY = 1.02


def binary(argument: str | None) -> str:
    if argument:
        return argument
    bundled = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "..",
        "..",
        "vendor",
        "officecli",
        "officecli-linux-x64",
    )
    if os.path.exists(bundled):
        return os.path.normpath(bundled)
    return "officecli"


def emu(value: object) -> float | None:
    """officecli reports a length in whatever unit reads best: `1418700emu`,
    `1.16cm`, `202.5pt`, `0cm`. Every one of them is a length and has to be
    reduced to EMU before anything is compared with anything else."""
    if value is None:
        return None
    match = UNIT.match(str(value).strip())
    if not match:
        return None
    number = float(match.group(1))
    scale = {
        None: 1.0,
        "emu": 1.0,
        "cm": EMU_PER_CM,
        "mm": EMU_PER_MM,
        "in": EMU_PER_IN,
        "pt": EMU_PER_PT,
        "px": EMU_PER_PT,
    }[match.group(2)]
    return number * scale


@lru_cache(maxsize=256)
def _font(path: str, size_pt: int):
    from PIL import ImageFont

    return ImageFont.truetype(path, size_pt * 8)


@lru_cache(maxsize=128)
def _resolve(family: str) -> str | None:
    """fc-match never fails: an absent brand face falls back to whatever is
    installed, which is close enough in width to tell one line from two."""
    try:
        found = subprocess.run(
            ["fc-match", "-f", "%{file}", family],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    path = found.stdout.strip()
    return path or None


def layout(text: str, family: str, size_pt: float, width_pt: float) -> list[tuple[str, float]]:
    """Break `text` into the lines it wraps to inside `width_pt`, each with its
    own width in points. Greedy on spaces, which is what PowerPoint does, so
    the line count is the one the renderer will produce."""
    if width_pt <= 0:
        return []
    path = _resolve(family)
    if path is None:
        # No fontconfig: fall back to an average advance of 0.5em, close for a
        # humanist sans and erring towards reporting the wrap.
        return [
            (line, len(line) * size_pt * 0.5)
            for line in text.split("\n")
            for line in [line[: max(1, int(width_pt / (size_pt * 0.5)))]]
        ] or [("", 0.0)]

    font = _font(path, max(1, round(size_pt)))
    lines: list[tuple[str, float]] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append(("", 0.0))
            continue
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if font.getlength(candidate) / 8 <= width_pt * LINE_SAFETY:
                current = candidate
            else:
                if current:
                    lines.append((current, font.getlength(current) / 8))
                current = word
                while (
                    font.getlength(current) / 8 > width_pt * LINE_SAFETY
                    and len(current) > 1
                ):
                    # A single word wider than the line breaks mid-word.
                    cut = len(current) - 1
                    while cut > 1 and font.getlength(current[:cut]) / 8 > width_pt * LINE_SAFETY:
                        cut -= 1
                    lines.append((current[:cut], font.getlength(current[:cut]) / 8))
                    current = current[cut:]
        lines.append((current, font.getlength(current) / 8))
    return lines


PROBE = "abcdefghijklmnopqrstuvwxyz .,;:"


def chars_per_line(width_pt: float, size_pt: float, family: str) -> float:
    """How many characters of this font fit on a line `width_pt` wide.

    Measured on a representative lowercase run rather than a hardcoded ratio,
    because the ratio moves with the typeface and a wrong one puts the whole
    budget in the wrong place."""
    if width_pt <= 0:
        return 1.0
    path = _resolve(family)
    if path is None:
        return width_pt / (size_pt * 0.5)
    font = _font(path, max(1, round(size_pt)))
    return width_pt / max(1.0, font.getlength(PROBE) / 8 / len(PROBE))


def measure(node: dict, transform: tuple[float, float, float, float]) -> dict | None:
    """Reduce one shape to the rectangle its text is actually *drawn* in.

    The shape's own rectangle is not that rectangle, and comparing boxes is
    what makes a checker cry wolf: the templates size every label box far wider
    than its label, so "01" and the section name beside it overlap as boxes and
    render perfectly. What collides is ink, so this measures the wrapped lines
    and places them inside the box according to the shape's own alignment.

    `transform` is (scaleX, scaleY, offsetX, offsetY) from the enclosing groups.
    """
    fmt = node.get("format", {})
    text = (node.get("text") or "").strip()
    if not text:
        return None  # a decorative shape overlapping its neighbour is the design

    x, y = emu(fmt.get("x")), emu(fmt.get("y"))
    width, height = emu(fmt.get("width")), emu(fmt.get("height"))
    if None in (x, y, width, height):
        return None

    scale_x, scale_y, offset_x, offset_y = transform
    left = offset_x + x * scale_x
    top = offset_y + y * scale_y
    right = left + width * scale_x
    bottom = top + height * scale_y

    size = SIZE.match(str(fmt.get("size") or fmt.get("effective.size") or ""))
    if not size:
        return None
    size_pt = float(size.group(1))

    # A group scales the shape's box but not the font inside it, so the text
    # wraps against the *scaled* width. Reading the child width instead is what
    # makes a checker report a wrap where the slide shows a single line.
    margin = emu(fmt.get("margin")) or 0.0
    usable_w = (width * scale_x - 2 * margin) / EMU_PER_PT
    usable_h = (height * scale_y - 2 * margin) / EMU_PER_PT

    spacing = SPACING.match(str(fmt.get("lineSpacing") or ""))
    factor = float(spacing.group(1)) if spacing else 1.0
    # PowerPoint's single line box is about 1.2x the point size.
    line_pt = size_pt * 1.2 * factor
    family = str(
        fmt.get("font.latin")
        or fmt.get("effective.font.latin")
        or fmt.get("font")
        or "sans"
    )

    lines = layout(text, family, size_pt, usable_w)
    ink_h = len(lines) * line_pt
    ink_w = max((w for _, w in lines), default=0.0)
    box_h = height * scale_y / EMU_PER_PT

    # `normAutofit` shrinks the text until it fits and `spAutoFit` grows the
    # shape, so in both the renderer resolves an overflow by itself; a shape
    # that grows is caught by the collision pass instead, which is where it
    # actually shows up.
    autofit = str(fmt.get("autoFit") or "none")
    if autofit == "normal":
        ink_h = min(ink_h, max(0.0, usable_h))

    align = str(fmt.get("align") or "left")
    if align == "ctr":
        ink_left = left + (width - ink_w * EMU_PER_PT) / 2
    elif align == "r":
        ink_left = right - margin - ink_w * EMU_PER_PT
    else:
        ink_left = left + margin

    valign = str(fmt.get("valign") or "top")
    if valign in ("middle", "ctr"):
        ink_top = top + (height - ink_h * EMU_PER_PT) / 2
    elif valign in ("bottom", "b"):
        ink_top = bottom - margin - ink_h * EMU_PER_PT
    else:
        ink_top = top + margin

    return {
        "path": node.get("path", "?"),
        "text": text,
        "ink": (
            ink_left,
            ink_top,
            ink_left + ink_w * EMU_PER_PT,
            ink_top + ink_h * EMU_PER_PT,
        ),
        "box": (left, top, right, bottom),
        "lines": len(lines),
        "fits": ink_h,
        "usable_h": usable_h,
        "size_pt": size_pt,
        "box_h": box_h,
        "autofit": autofit,
        "line_pt": line_pt,
        "chars_per_line": chars_per_line(usable_w, size_pt, family),
    }


def slide_shapes(node: dict, transform: tuple[float, float, float, float]):
    """Yield every shape under a slide as `(node, transform)` where
    `transform` is (scaleX, scaleY, offsetX, offsetY) mapping that shape's own
    child coordinate space into slide space.

    A group's children live in the child space declared by its
    `childOffset`/`childExtent`, not in slide space, and the group is
    commonly scaled - so a child's own x/y are unusable until mapped:
        slideX = offsetX + (childX - childOffsetX) * groupExtX / childExtX
    Skipping this invents dozens of overlaps between shapes that are in fact
    centimetres apart."""
    scale_x, scale_y, offset_x, offset_y = transform
    for child in node.get("children", []):
        fmt = child.get("format", {})
        if child.get("type") != "group":
            yield child, transform
            continue

        gx, gy = emu(fmt.get("x")), emu(fmt.get("y"))
        gw, gh = emu(fmt.get("width")), emu(fmt.get("height"))
        try:
            origin_x, origin_y = (float(v) for v in str(fmt["childOffset"]).split(","))
            extent_x, extent_y = (float(v) for v in str(fmt["childExtent"]).split(","))
        except (KeyError, ValueError):
            continue
        if None in (gx, gy, gw, gh) or not extent_x or not extent_y:
            continue

        ratio_x = gw / extent_x
        ratio_y = gh / extent_y
        inner = (
            scale_x * ratio_x,
            scale_y * ratio_y,
            offset_x + scale_x * (gx - origin_x * ratio_x),
            offset_y + scale_y * (gy - origin_y * ratio_y),
        )
        yield from slide_shapes(child, inner)


def check(deck: str, officecli: str) -> list[str]:
    tree = subprocess.run(
        [officecli, "query", deck, "slide", "--json"],
        capture_output=True,
        text=True,
    )
    payload = json.loads(tree.stdout)
    if not payload.get("success"):
        raise SystemExit(f"officecli no pudo leer {deck}: {tree.stdout[:400]}")

    findings: list[str] = []
    for slide in payload["data"]["results"]:
        index = slide["path"]
        shapes = []
        for node, transform in slide_shapes(slide, (1.0, 1.0, 0.0, 0.0)):
            shape = measure(node, transform)
            if shape:
                shapes.append(shape)

        for shape in shapes:
            label = shape["text"][:40].replace("\n", " ")
            # Only `noAutofit` spills visibly. The threshold is the shape's own
            # height, not the usable height: text sitting in the shape's own
            # margins is still inside the shape and nobody sees a problem, so
            # a check against the usable area reports the template's own
            # design back as broken. Half a line of slack absorbs the gap
            # between PowerPoint's line box and this measurement.
            if shape["autofit"] != "none":
                continue
            if shape["fits"] > shape["box_h"] + shape["size_pt"] * 0.6:
                findings.append(
                    f"{index} {shape['path']}: {shape['lines']} lineas de "
                    f"{shape['size_pt']:g}pt necesitan {shape['fits']:.0f}pt, "
                    f"la caja tiene {shape['box_h']:.0f}pt y no tiene autofit, "
                    f"asi que el texto se sale de la forma. "
                    f"Acorta el texto o baja el tamano. ({label!r})"
                )

        for a in range(len(shapes)):
            for b in range(a + 1, len(shapes)):
                one, other = shapes[a], shapes[b]
                ax0, ay0, ax1, ay1 = one["ink"]
                bx0, by0, bx1, by1 = other["ink"]
                shared_x = min(ax1, bx1) - max(ax0, bx0)
                shared_y = min(ay1, by1) - max(ay0, by0)
                # Both extents must be substantial. Text boxes in these
                # templates are sized to the label they shipped with, so two
                # of them graze each other by a hair - the line boxes touch but
                # no glyph ever does, and the slide reads clean. Reporting that
                # is what makes a checker useless: 79 findings on the untouched
                # template drowns the 4 that matter on a real deck.
                if shared_x > MIN_OVERLAP_EMU and shared_y > MIN_OVERLAP_EMU:
                    findings.append(
                        f"{index} {one['path']} se solapa con {other['path']}: "
                        f"{one['text'][:30]!r} / {other['text'][:30]!r}"
                    )
    return findings


def capacity(deck: str, officecli: str, only: str | None) -> None:
    """Print what each text shape in the deck can actually hold.

    The recurring mistake is guessing whether a sentence fits. This turns it
    into a lookup, taken before a single word is written: for every shape, how
    many characters go on a line and how many lines the shape is tall enough to
    show. Both come from the shape's own geometry and font, so they need no
    estimating.

    Pass a slide path (`/slide[5]`) to print just that one.
    """
    tree = subprocess.run(
        [officecli, "query", deck, "slide", "--json"],
        capture_output=True,
        text=True,
    )
    payload = json.loads(tree.stdout)
    if not payload.get("success"):
        raise SystemExit(f"officecli no pudo leer {deck}: {tree.stdout[:400]}")

    for slide in payload["data"]["results"]:
        if only and slide["path"] != only:
            continue
        rows = []
        for node, transform in slide_shapes(slide, (1.0, 1.0, 0.0, 0.0)):
            shape = measure(node, transform)
            if not shape:
                continue
            per_line = max(1, int(shape["chars_per_line"]))
            max_lines = max(1, int((shape["box_h"] / shape["line_pt"]) + 0.34))
            rows.append(
                f"  {shape['path']:<52} {shape['size_pt']:>4.1f}pt "
                f"{per_line:>4} car/linea x {max_lines} linea(s) "
                f"= {per_line * max_lines:>4} car  ahora {len(shape['text']):>4} "
                f"{shape['text'][:28]!r}"
            )
        if rows:
            print(slide["path"])
            for row in rows:
                print(row)


def main() -> None:
    only = next((a for a in sys.argv[1:] if a.startswith("/slide[")), None)
    # The slide filter is an argument, not a positional: taking it as one makes
    # it the officecli path.
    positional = [
        a
        for a in sys.argv[1:]
        if not a.startswith("--") and not a.startswith("/slide[")
    ]
    if not positional:
        raise SystemExit(__doc__)
    deck = positional[0]
    if not os.path.exists(deck):
        raise SystemExit(f"no existe: {deck}")
    officecli = binary(positional[1] if len(positional) > 1 else None)

    if "--capacity" in sys.argv:
        capacity(deck, officecli, only)
        return

    findings = check(deck, officecli)
    for line in findings:
        print(f"  {line}")

    if findings:
        print(
            f"\n{len(findings)} problema(s) de maquetacion. "
            "Corrige el texto o cambia de slide antes de entregar."
        )
        raise SystemExit(1)
    print(f"{deck}: sin solapes ni texto desbordado")


if __name__ == "__main__":
    sys.exit(main() or 0)