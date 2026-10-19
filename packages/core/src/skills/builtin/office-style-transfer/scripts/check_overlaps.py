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
whatever fontconfig resolves the deck's typeface to. Placeholders that carry no
geometry of their own inherit their box from the slide layout - a very common
construction - and officecli does not resolve that inheritance, so those boxes
are read straight out of the `.pptx` (see `inherited_boxes`) instead of being
skipped. Shape coordinates inside
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
import posixpath
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
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


# Namespaces of the parts that draw a placeholder's box.
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _part_rels(zf: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """Relationships of one package part: id -> (type, resolved target path)."""
    rels_part = posixpath.join(
        posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels"
    )
    out: dict[str, tuple[str, str]] = {}
    try:
        root = ET.fromstring(zf.read(rels_part))
    except KeyError:
        return out
    for rel in root:
        target = rel.get("Target", "")
        if rel.get("TargetMode") == "External" or not target:
            continue
        resolved = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(
                posixpath.join(posixpath.dirname(part), target)
            )
        )
        out[rel.get("Id", "")] = (rel.get("Type", ""), resolved)
    return out


def _related_part(
    zf: zipfile.ZipFile, part: str, suffix: str
) -> str | None:
    for kind, target in _part_rels(zf, part).values():
        if kind.endswith(suffix):
            return target
    return None


def _placeholder_boxes(
    zf: zipfile.ZipFile, part: str
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    """The boxes drawn for placeholders in one layout or master part.

    Returns `(by_idx, by_type)`, because that is exactly how a slide
    placeholder finds its box: OOXML matches it to the layout placeholder with
    the same `idx`, and only falls back to the `type` when neither carries an
    idx - a cover title has no idx at all.
    """
    by_idx: dict[str, dict[str, float]] = {}
    by_type: dict[str, dict[str, float]] = {}
    try:
        root = ET.fromstring(zf.read(part))
    except KeyError:
        return by_idx, by_type

    for shape in root.iter():
        if shape.tag not in (f"{{{P_NS}}}sp", f"{{{P_NS}}}pic"):
            continue
        ph = shape.find(f".//{{{P_NS}}}ph")
        xfrm = shape.find(f"{{{P_NS}}}spPr/{{{A_NS}}}xfrm")
        if ph is None or xfrm is None:
            continue
        off = xfrm.find(f"{{{A_NS}}}off")
        ext = xfrm.find(f"{{{A_NS}}}ext")
        if off is None or ext is None:
            continue
        box = {
            "x": float(off.get("x", "")),
            "y": float(off.get("y", "")),
            "width": float(ext.get("cx", "")),
            "height": float(ext.get("cy", "")),
        }
        # The box comes with the layout's text frame attached, and a
        # placeholder inherits both. Which of the two matters: a cover title
        # anchored to the *bottom* of a box that is shorter than its text
        # grows upward, so measuring from the top of the box puts the line a
        # full line below where it renders and the line under it reports a
        # collision that is not there.
        body = shape.find(f".//{{{A_NS}}}bodyPr")
        if body is not None:
            anchor = body.get("anchor")
            if anchor == "b":
                box["valign"] = "bottom"
            elif anchor == "ctr":
                box["valign"] = "middle"
            elif anchor == "t":
                box["valign"] = "top"
            insets = [body.get(key) for key in ("tIns", "rIns", "bIns", "lIns")]
            if all(value is not None for value in insets):
                box["margin"] = sum(float(value) for value in insets) / 4
        idx, ph_type = ph.get("idx"), ph.get("type")
        if idx is not None:
            by_idx.setdefault(idx, box)
        by_type.setdefault(ph_type or "body", box)
    return by_idx, by_type


def inherited_boxes(
    deck: str,
) -> dict[str, tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]]:
    """`{"/slide[1]": (boxes by idx, boxes by type)}` for every slide.

    A placeholder is usually just a reference: it declares no box of its own
    and takes the one drawn in the slide layout, and `officecli query --json`
    reports it without x/y/width/height. Left unresolved, `measure` skips those
    shapes one by one and the check passes on decks it has not actually read -
    which is what happens on a stock Office deck, where every text shape is a
    placeholder. The boxes therefore come straight out of the `.pptx`:
    master, then layout on top of it.
    """
    result: dict[
        str, tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]
    ] = {}
    try:
        zf = zipfile.ZipFile(deck)
    except (OSError, zipfile.BadZipFile):
        return result
    with zf:
        try:
            presentation = ET.fromstring(zf.read("ppt/presentation.xml"))
        except KeyError:
            return result
        rels = _part_rels(zf, "ppt/presentation.xml")
        slide_parts = []
        for slide_id in presentation.findall(
            f"{{{P_NS}}}sldIdLst/{{{P_NS}}}sldId"
        ):
            entry = rels.get(slide_id.get(f"{{{R_NS}}}id", ""))
            if entry:
                slide_parts.append(entry[1])

        for index, slide_part in enumerate(slide_parts, start=1):
            layout_part = _related_part(zf, slide_part, "/slideLayout")
            by_idx: dict[str, dict[str, float]] = {}
            by_type: dict[str, dict[str, float]] = {}
            if layout_part:
                master_part = _related_part(zf, layout_part, "/slideMaster")
                if master_part:
                    by_idx, by_type = _placeholder_boxes(zf, master_part)
                layout_idx, layout_type = _placeholder_boxes(zf, layout_part)
                by_idx.update(layout_idx)
                by_type.update(layout_type)
            result[f"/slide[{index}]"] = (by_idx, by_type)
    return result


def fill_box(fmt: dict, boxes: tuple[dict, dict] | None) -> None:
    """Give a placeholder the box - and the text frame - it inherits, if it
    has none of its own."""
    if boxes is None or (fmt.get("phIndex") is None and not fmt.get("phType")):
        return
    by_idx, by_type = boxes
    box = None
    if fmt.get("phIndex") is not None:
        box = by_idx.get(str(fmt["phIndex"]))
    if box is None and fmt.get("phType"):
        box = by_type.get(fmt["phType"])
    if box is None:
        return
    for key in ("x", "y", "width", "height"):
        if key not in fmt and key in box:
            fmt[key] = f"{box[key]:.0f}emu"
    if "valign" not in fmt and "valign" in box:
        fmt["valign"] = box["valign"]
    if "margin" not in fmt and "margin" in box:
        fmt["margin"] = f"{box['margin']:.0f}emu"


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

    # The layout writes the paragraph settings the placeholder inherits;
    # `effective.*` is officecli's resolved copy of them, and reading only the
    # shape's own values inflates a text block that the template set to 0.8x
    # line spacing by a third.
    spacing = SPACING.match(
        str(fmt.get("lineSpacing") or fmt.get("effective.lineSpacing") or "")
    )
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

    # `effective.align` is the layout's alignment resolved onto the shape;
    # officecli spells the values out ("center"), the raw attribute abbreviates
    # them ("ctr"), and a placeholder carries neither.
    align = str(
        fmt.get("align") or fmt.get("effective.align") or "left"
    ).lower()
    if align in ("ctr", "center"):
        align = "ctr"
    elif align in ("r", "right"):
        align = "r"
    else:
        align = "l"
    if align == "ctr":
        ink_left = left + (width - ink_w * EMU_PER_PT) / 2
    elif align == "r":
        ink_left = right - margin - ink_w * EMU_PER_PT
    else:
        ink_left = left + margin

    # valign reaches the checker from the slide, or - for a placeholder that
    # declares no text frame of its own - from the layout's anchor, which
    # fill_box copies in.
    valign = str(fmt.get("valign") or "top").lower()
    if valign in ("middle", "ctr", "center"):
        valign = "middle"
    elif valign in ("bottom", "b"):
        valign = "bottom"
    else:
        valign = "top"
    if valign == "middle":
        ink_top = top + (height - ink_h * EMU_PER_PT) / 2
    elif valign in ("bottom", "b"):
        ink_top = bottom - margin - ink_h * EMU_PER_PT
    else:
        ink_top = top + margin

    # One rectangle per rendered line. The block-wide box is the union of all
    # of them, and in a two-column template the union of a heading on the left
    # reaches across to the title on the right although no two glyphs are near
    # each other - the contact block and the logotype of a stock cover read as
    # one collision that way, on a deck that renders perfectly. Line by line is
    # what the renderer actually compares.
    line_boxes = []
    for number, (_, line_w) in enumerate(lines):
        y0 = ink_top + number * line_pt * EMU_PER_PT
        width_emu = line_w * EMU_PER_PT
        if align == "ctr":
            x0 = left + (width - width_emu) / 2
        elif align == "r":
            x0 = right - margin - width_emu
        else:
            x0 = left + margin
        line_boxes.append((x0, y0, x0 + width_emu, y0 + line_pt * EMU_PER_PT))

    return {
        "path": node.get("path", "?"),
        "text": text,
        "ink": (
            ink_left,
            ink_top,
            ink_left + ink_w * EMU_PER_PT,
            ink_top + ink_h * EMU_PER_PT,
        ),
        "line_boxes": line_boxes,
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
    boxes = inherited_boxes(deck)
    for slide in payload["data"]["results"]:
        index = slide["path"]
        slide_boxes = boxes.get(index)
        shapes = []
        for node, transform in slide_shapes(slide, (1.0, 1.0, 0.0, 0.0)):
            fill_box(node.get("format", {}), slide_boxes)
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
                # Line against line. Two adjacent labels have line boxes that
                # touch without sharing pixels - the templates size every box
                # far wider than its label, so comparing boxes reports 79
                # findings on an untouched template and drowns the few that
                # matter. What counts is a share of the *line*, and it is
                # taken relative to the smaller line so an 11pt caption is
                # judged as strictly as a 40pt title: a fixed floor would let
                # every small-text collision through untouched, since a whole
                # 11pt line is only 0.18cm tall.
                hit = False
                for ax0, ay0, ax1, ay1 in one["line_boxes"]:
                    for bx0, by0, bx1, by1 in other["line_boxes"]:
                        overlap_x = min(ax1, bx1) - max(ax0, bx0)
                        overlap_y = min(ay1, by1) - max(ay0, by0)
                        if overlap_x <= 0 or overlap_y <= 0:
                            continue
                        reach_y = min(ay1 - ay0, by1 - by0)
                        reach_x = min(ax1 - ax0, bx1 - bx0)
                        if overlap_y > min(MIN_OVERLAP_EMU, 0.5 * reach_y) and (
                            overlap_x
                            > min(MIN_OVERLAP_EMU, 0.25 * reach_x)
                        ):
                            hit = True
                            break
                    if hit:
                        break
                if hit:
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

    boxes = inherited_boxes(deck)
    for slide in payload["data"]["results"]:
        if only and slide["path"] != only:
            continue
        slide_boxes = boxes.get(slide["path"])
        rows = []
        for node, transform in slide_shapes(slide, (1.0, 1.0, 0.0, 0.0)):
            fill_box(node.get("format", {}), slide_boxes)
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