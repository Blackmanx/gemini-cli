#!/usr/bin/env python3
"""
Extract a style blueprint from an Office file, in one pass.

    python3 extract_style.py <file.pptx|.docx|.xlsx> [-o blueprint.json]

The file the user gives you as a style reference is also the file you build
into, and the expensive mistake is writing text before knowing what the boxes
can hold or which styles carry the look. This reads the file once and writes a
pruned JSON blueprint: for pptx every text shape with its measured capacity,
for docx the styles actually used plus the body skeleton, for xlsx the sheets
with their formats. Everything decorative that must stay untouched is listed
too.

With `-o` the JSON is written to that path and a short summary is printed;
without it the JSON goes to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

EMU_PER_IN = 914400.0
EMU_PER_PT = 12700.0
TWIPS_PER_CM = 566.929

# Style properties worth keeping. The rest (uiPriority, qFormat, semiHidden,
# basedOn.path ...) describe the style to Word, not the look of the document.
KEEP_STYLE = {
    "id",
    "name",
    "type",
    "basedOn",
    "size",
    "bold",
    "italic",
    "underline",
    "strike",
    "color",
    "caps",
    "smallCaps",
    "charSpacing",
    "spaceBefore",
    "spaceAfter",
    "lineSpacing",
    "align",
    "indent",
    "leftIndent",
    "rightIndent",
    "firstLine",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "outlineLevel",
    "shading",
    "font.name",
    "font.asciiTheme",
    "font.hAnsiTheme",
    "font.cs",
    "font.ea",
    "border.bottom.style",
    "border.bottom.color",
}

# Paragraph format keys that describe structure rather than direct formatting.
STRUCTURAL = {
    "paraId",
    "style",
    "styleId",
    "styleName",
    "numId",
    "numLevel",
    "numInherited",
    "numFmt",
    "listStyle",
    "start",
}


def officecli(binary: str, *args: str) -> dict:
    """One officecli call, parsed. `--json` is appended by the caller's args."""
    done = subprocess.run(
        [binary, *args, "--json"], capture_output=True, text=True
    )
    if not done.stdout.strip():
        raise SystemExit(
            f"officecli {args[0] if args else ''} produced no output: "
            f"{done.stderr[:300]}"
        )
    try:
        payload = json.loads(done.stdout)
    except json.JSONDecodeError:
        raise SystemExit(
            f"officecli {' '.join(args)} answered something unreadable: "
            f"{(done.stdout or done.stderr)[:300]}"
        ) from None
    if not payload.get("success"):
        raise SystemExit(f"officecli failed on {args}: {done.stdout[:400]}")
    return payload


def results(payload: dict) -> list[dict]:
    return payload.get("data", {}).get("results", []) or []


def zip_read(path: str, part: str) -> str | None:
    try:
        with zipfile.ZipFile(path) as zf:
            return zf.read(part).decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return None


def zip_parts(path: str, prefix: str) -> list[str]:
    try:
        with zipfile.ZipFile(path) as zf:
            return [
                name
                for name in zf.namelist()
                if posixpath.normpath(name).startswith(prefix)
            ]
    except (OSError, zipfile.BadZipFile):
        return []


def rels_of(path: str, part: str) -> dict[str, tuple[str, str]]:
    """id -> (type, resolved target) for one package part."""
    rels_part = posixpath.join(
        posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels"
    )
    raw = zip_read(path, rels_part)
    out: dict[str, tuple[str, str]] = {}
    if not raw:
        return out
    for rel in ET.fromstring(raw):
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


def inches(emu: float) -> float:
    return round(emu / EMU_PER_IN, 2)


def theme(binary: str, path: str) -> dict:
    try:
        found = results(officecli(binary, "get", path, "/theme"))
        if found:
            return found[0].get("format", {})
    except SystemExit:
        pass
    # A .docx has no /theme node; its colours and fonts live in the package.
    return zip_theme(path)


def zip_theme(path: str) -> dict:
    """Theme of a docx/xlsx read from its `theme*.xml` package part.

    Colours come out as `#RRGGBB` and the two font schemes as
    `headingFont`/`bodyFont`, the same keys officecli reports for pptx, so the
    caller does not care which of the two read the file.
    """
    raw = None
    for folder in ("word", "xl"):
        parts = [
            name
            for name in zip_parts(path, folder + "/theme/")
            if re.fullmatch(re.escape(folder) + r"/theme/theme\d*\.xml", name)
        ]
        if parts:
            raw = zip_read(path, parts[0])
            break
    if not raw:
        return {}
    out: dict = {}
    scheme = re.search(r"<a:clrScheme[^>]*>(.*?)</a:clrScheme>", raw, re.S)
    if scheme:
        for name, block in re.findall(
            r"<a:(\w+)>(.*?)</a:\1>", scheme.group(1), re.S
        ):
            colour = re.search(r'<a:srgbClr val="([0-9A-Fa-f]{6})"', block)
            if not colour:
                colour = re.search(r'<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"', block)
            if not colour:
                continue
            key = {
                "dk1": "dk1",
                "lt1": "lt1",
                "dk2": "dk2",
                "lt2": "lt2",
                "accent1": "accent1",
                "accent2": "accent2",
                "accent3": "accent3",
                "accent4": "accent4",
                "accent5": "accent5",
                "accent6": "accent6",
                "hlink": "hyperlink",
                "folHlink": "followedhyperlink",
            }.get(name)
            if key:
                out[key] = "#" + colour.group(1)
    fonts = re.search(r"<a:fontScheme[^>]*>(.*?)</a:fontScheme>", raw, re.S)
    if fonts:
        major = re.search(
            r"<a:majorFont>(.*?)</a:majorFont>", fonts.group(1), re.S
        )
        minor = re.search(
            r"<a:minorFont>(.*?)</a:minorFont>", fonts.group(1), re.S
        )
        for tag, key in ((major, "headingFont"), (minor, "bodyFont")):
            if tag:
                latin = re.search(r'<a:latin typeface="([^"]*)"', tag.group(1))
                if latin and latin.group(1):
                    out[key] = latin.group(1)
    name = re.search(r"<a:theme[^>]*name=\"([^\"]*)\"", raw)
    if name:
        out["name"] = name.group(1)
    return out


# --------------------------------------------------------------------------
# pptx
# --------------------------------------------------------------------------

ROLE = {
    "ctrTitle": "title",
    "title": "title",
    "subTitle": "subtitle",
    "body": "body",
    "pic": "picture",
    "sldNum": "slide-number",
    "dt": "date",
}


def pptx_blueprint(binary: str, path: str) -> dict:
    # Geometry, wrapping and capacity come from the same measurement the
    # overlap gate uses, so the numbers the agent plans with are the numbers
    # the gate will later judge the deck by.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import check_overlaps as gate  # noqa: E402  (path set up above)

    slide_xml = zip_read(path, "ppt/presentation.xml") or ""
    size = re.search(r'<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"', slide_xml)
    width, height = (int(size.group(1)), int(size.group(2))) if size else (0, 0)

    boxes = gate.inherited_boxes(path)
    payload = officecli(binary, "query", path, "slide", "--json")
    ph_by_slide = slide_placeholders(path)

    # Layout names come from the package: officecli reports the effective
    # style of a placeholder but not which layout the slide was built on, and
    # the layout is what the agent clones when it needs another slide of the
    # same kind.
    layout_names = slide_layout_names(path)

    blueprint: dict = {
        "kind": "pptx",
        "slides": len(results(payload)),
        "size_in": [inches(width), inches(height)],
        "theme": theme(binary, path),
        "slide_list": [],
    }

    for position, slide in enumerate(results(payload), start=1):
        slide_boxes = boxes.get(slide["path"])
        shapes = []
        for node, transform in gate.slide_shapes(
            slide, (1.0, 1.0, 0.0, 0.0)
        ):
            fmt = node.get("format", {})
            inherited = ph_by_slide.get(position, {}).get(
                str(fmt.get("id", ""))
            )
            if inherited:
                for key, value in inherited.items():
                    fmt.setdefault(key, value)
            gate.fill_box(fmt, slide_boxes)
            text = node.get("text") or ""
            role = ROLE.get(str(fmt.get("phType") or ""), "textbox")
            entry: dict = {"path": node.get("path"), "role": role}

            measured = gate.measure(node, transform)
            if measured:
                per_line = max(1, int(measured["chars_per_line"]))
                max_lines = max(
                    1,
                    int(
                        (measured["box_h"] / measured["line_pt"]) + 0.34
                    ),
                )
                left, top, right, bottom = measured["box"]
                entry.update(
                    {
                        "text": text[:400],
                        "size": f"{measured['size_pt']:g}pt",
                        "font": str(
                            fmt.get("font.latin")
                            or fmt.get("effective.font.latin")
                            or fmt.get("font")
                            or ""
                        ),
                        "align": str(
                            fmt.get("align") or fmt.get("effective.align")
                            or "left"
                        ),
                        "valign": str(fmt.get("valign") or "top"),
                        "autofit": measured["autofit"] or "none",
                        "box_in": [
                            inches(left),
                            inches(top),
                            inches(right),
                            inches(bottom),
                        ],
                        "capacity": {
                            "chars_per_line": per_line,
                            "max_lines": max_lines,
                            "max_chars": per_line * max_lines,
                            "now_chars": len(text),
                        },
                    }
                )
            elif text.strip():
                entry["text"] = text[:400]
                entry["note"] = "no measurable geometry"
            elif "relId" in fmt or node.get("type") == "picture":
                # Art, kept so the agent can see what must not be covered.
                if "x" in fmt and "width" in fmt:
                    entry["box_in"] = [
                        inches(gate.emu(fmt["x"]) or 0),
                        inches(gate.emu(fmt["y"]) or 0),
                        inches((gate.emu(fmt["x"]) or 0) + (gate.emu(fmt["width"]) or 0)),
                        inches((gate.emu(fmt["y"]) or 0) + (gate.emu(fmt["height"]) or 0)),
                    ]
                entry["role"] = "art"
            else:
                continue
            shapes.append(entry)

        blueprint["slide_list"].append(
            {
                "index": position,
                "path": slide["path"],
                "layout": layout_names.get(position, ""),
                "shapes": shapes,
            }
        )

    return blueprint


def slide_layout_names(path: str) -> dict[int, str]:
    """`{1: 'Title Slide', ...}` from each slide's own layout part."""
    names: dict[int, str] = {}
    pres = zip_read(path, "ppt/presentation.xml") or ""
    order = re.findall(r'<p:sldId[^>]*r:id="(rId\d+)"', pres)
    pres_rels = rels_of(path, "ppt/presentation.xml")
    for index, rel_id in enumerate(order, start=1):
        entry = pres_rels.get(rel_id)
        if not entry:
            continue
        # slide -> its layout: the layout carries the design the slide wears.
        layout = next(
            (
                target
                for kind, target in rels_of(path, entry[1]).values()
                if kind.endswith("/slideLayout")
            ),
            None,
        )
        if not layout:
            continue
        xml = zip_read(path, layout)
        if xml:
            found = re.search(r'<p:cSld[^>]*name="([^"]*)"', xml)
            names[index] = found.group(1) if found else ""
    return names


def slide_placeholders(path: str) -> dict[int, dict[str, dict]]:
    """`{slide index: {shape id: {idx, type}}}` for every placeholder.

    officecli exposes `phType`/`phIndex` on text shapes but not on picture
    placeholders, and the picture of a stock cover is exactly the placeholder
    whose box comes from the layout - so the slide XML is read directly to
    know which box a shape inherits.
    """
    out: dict[int, dict[str, dict]] = {}
    pres = zip_read(path, "ppt/presentation.xml") or ""
    order = re.findall(r'<p:sldId[^>]*r:id="(rId\d+)"', pres)
    pres_rels = rels_of(path, "ppt/presentation.xml")
    for index, rel_id in enumerate(order, start=1):
        entry = pres_rels.get(rel_id)
        if not entry:
            continue
        xml = zip_read(path, entry[1])
        if not xml:
            continue
        found: dict[str, dict] = {}

        def walk(node: ET.Element) -> None:
            for child in node:
                tag = child.tag.rsplit("}", 1)[-1]
                if tag == "grpSp":
                    walk(child)
                    continue
                if tag not in ("sp", "pic", "graphicFrame", "cxnSp"):
                    continue
                ident = child.find(f".//{{{P_NS}}}cNvPr")
                ph = child.find(f".//{{{P_NS}}}ph")
                if ident is None or ph is None:
                    continue
                found[ident.get("id", "")] = {
                    key: value
                    for key, value in (
                        ("phIndex", ph.get("idx")),
                        ("phType", ph.get("type")),
                    )
                    if value is not None
                }

        root = ET.fromstring(xml)
        walk(root.find(f"{{{P_NS}}}cSld/{{{P_NS}}}spTree") or root)
        out[index] = found
    return out


# --------------------------------------------------------------------------
# docx
# --------------------------------------------------------------------------

def docx_texts(path: str) -> list[dict]:
    """Body paragraphs in document order: `{paraId, text, control}`.

    The text of a Word template lives in `<w:sdt>` content controls, which a
    paragraph query reports as empty, so the document XML is read directly:
    every `w:t` under the paragraph is its text, and the presence of an `sdt`
    says the paragraph is a control the agent must write *into* rather than
    beside.
    """
    raw = zip_read(path, "word/document.xml")
    if not raw:
        return []
    root = ET.fromstring(raw)
    body = root.find(f"{{{W_NS}}}body")
    if body is None:
        return []
    out: list[dict] = []
    for para in body.iter(f"{{{W_NS}}}p"):
        # A paragraph can hold several controls: a Word template writes its
        # sample sentence as a Mad-Libs of placeholders ("Facilitator Name"
        # … "called to order the regular meeting of the" … "Marketing &
        # sales team"), and a set on the first one alone leaves the rest of
        # the English on the page. Every control is therefore listed, with
        # the path officecli needs to write *into* it.
        controls = []
        for sdt in para.iter(f"{{{W_NS}}}sdt"):
            ident = sdt.find(f"{{{W_NS}}}sdtPr/{{{W_NS}}}id")
            value = ident.get(f"{{{W_NS}}}val") if ident is not None else None
            controls.append(
                {
                    "sdt_path": (
                        f"/sdt[@sdtId={value}]" if value else "/sdt[1]"
                    ),
                    "text": "".join(
                        node.text or ""
                        for node in sdt.iter(f"{{{W_NS}}}t")
                    ),
                }
            )
        out.append(
            {
                "paraId": para.get(
                    "{http://schemas.microsoft.com/office/word/2010/wordml}"
                    "paraId"
                ),
                "text": "".join(
                    node.text or ""
                    for node in para.iter(f"{{{W_NS}}}t")
                ),
                "controls": controls,
            }
        )
    return out


def docx_blueprint(binary: str, path: str) -> dict:
    paragraphs = results(officecli(binary, "query", path, "p", "--json"))
    tables = results(officecli(binary, "query", path, "table", "--json"))

    # Word templates put their visible text inside content controls
    # (`<w:sdt>` - the grey placeholder the user clicks to type over), and
    # officecli reports the paragraph as empty. The text therefore comes from
    # the XML itself, together with a flag saying which paragraphs are a
    # control: writing to the wrong level of such a paragraph is how a rebuild
    # ends up with the template's sample words still on the page.
    xml_paras = docx_texts(path)
    by_id = {
        info["paraId"]: info for info in xml_paras if info.get("paraId")
    }

    used: dict[str, dict] = {}
    body: list[dict] = []
    body_nodes = [
        node
        for node in paragraphs
        if (node.get("path") or "").startswith("/body/")
    ]
    for position, node in enumerate(body_nodes):
        node_path = node.get("path") or ""
        fmt = node.get("format", {})
        # `styleId`/`style` are the lookup key, `styleName` the display name.
        style_id = str(
            fmt.get("styleId") or fmt.get("style") or "Normal"
        )
        para_id = (
            node_path.split("@paraId=", 1)[-1].split("]", 1)[0]
            if "@paraId=" in node_path
            else ""
        )
        info = by_id.get(para_id)
        if info is None and position < len(xml_paras):
            info = xml_paras[position]
        text = (info or {}).get("text", "")
        entry: dict = {
            "path": node_path,
            "style": style_id,
            "text": text[:300],
        }
        if fmt.get("numId") is not None:
            entry["list"] = {
                "numId": fmt.get("numId"),
                "level": fmt.get("numLevel"),
                "format": fmt.get("numFmt"),
            }
        if (info or {}).get("controls"):
            entry["controls"] = [
                {
                    "path": node_path + control["sdt_path"],
                    "text": control["text"][:80],
                }
                for control in info["controls"]
            ]
        # Direct formatting is what makes a rebuild look subtly wrong, so it is
        # surfaced instead of being folded into the style.
        direct = sorted(
            key
            for key in fmt
            if key not in STRUCTURAL
            and not key.startswith("effective.")
            and not key.endswith(".src")
        )
        if direct:
            entry["direct"] = {
                key: fmt[key] for key in direct if len(str(fmt[key])) < 60
            }
        if (
            not text.strip()
            and not entry.get("list")
            and not entry.get("direct")
        ):
            if re.search(r"/tbl\[\d+\]/tr\[\d+\]/tc\[\d+\]/", node_path):
                continue  # empty table cell paragraph: the table entry covers it
        body.append(entry)
        used.setdefault(style_id, {})

    for table in tables:
        fmt = table.get("format", {})
        body.append(
            {
                "path": table.get("path"),
                "style": "table",
                "rows": int(fmt.get("rows") or 0),
                "cols": int(fmt.get("cols") or 0),
                "col_widths": fmt.get("colWidths", ""),
            }
        )

    # Only the styles the document actually wears, plus the chain they build
    # on: the reference file ships 414 styles and uses eight. The listing view
    # of /styles carries no visual properties, so each used style is read on
    # its own - eight calls instead of a 414-style dump nothing reads.
    styles: dict[str, dict] = {}
    wanted = set(used)
    while wanted:
        style_id = wanted.pop()
        if style_id in styles:
            continue
        try:
            found = results(
                officecli(binary, "get", path, f"/styles/{style_id}")
            )
        except SystemExit:
            styles[style_id] = {"note": "not found in /styles"}
            continue
        fmt = found[0].get("format", {}) if found else {}
        styles[style_id] = {
            key: value
            for key, value in fmt.items()
            if key in KEEP_STYLE and len(str(value)) < 80
        }
        if fmt.get("basedOn"):
            wanted.add(str(fmt["basedOn"]))

    document = zip_read(path, "word/document.xml") or ""
    section = re.search(
        r"<w:pgSz[^>]*w=\"(\d+)\"[^>]*h=\"(\d+)\"", document
    )
    margins = re.search(
        r"<w:pgMar[^>]*w:top=\"(\d+)\"[^>]*w:right=\"(\d+)\"[^>]*"
        r"w:bottom=\"(\d+)\"[^>]*w:left=\"(\d+)\"",
        document,
    )
    sect: dict = {}
    if section:
        sect["page_twips"] = [int(section.group(1)), int(section.group(2))]
        sect["page_cm"] = [
            round(int(section.group(1)) / TWIPS_PER_CM, 1),
            round(int(section.group(2)) / TWIPS_PER_CM, 1),
        ]
    if margins:
        sect["margins_cm"] = [
            round(int(group) / TWIPS_PER_CM, 1)
            for group in margins.groups()
        ]

    decorations = []
    for part in sorted(zip_parts(path, "word/header")) + sorted(
        zip_parts(path, "word/footer")
    ):
        if not part.endswith(".xml"):
            continue
        raw = zip_read(path, part) or ""
        text = re.sub(r"<[^>]+>", " ", raw)
        decorations.append(
            {
                "part": part,
                "graphic": bool(
                    re.search(r"<w:drawing|<w:pict|<v:shape|<w:framePr", raw)
                ),
                "text": " ".join(text.split())[:120],
            }
        )

    return {
        "kind": "docx",
        "theme": theme(binary, path),
        "section": sect,
        "styles": styles,
        "body": body,
        "decorations": decorations,
    }


# --------------------------------------------------------------------------
# xlsx
# --------------------------------------------------------------------------

CELL_RE = re.compile(r"^/([^/]+)/([A-Z]+)(\d+)$")


def xlsx_blueprint(binary: str, path: str) -> dict:
    cells = results(officecli(binary, "query", path, "*", "--json"))

    sheets: dict[str, dict] = {}
    for node in cells:
        match = CELL_RE.match(node.get("path", ""))
        if not match:
            continue
        sheet, column, row = match.group(1), match.group(2), int(match.group(3))
        entry = sheets.setdefault(
            sheet,
            {"name": sheet, "rows": 0, "cols": set(), "styles": {}, "head": []},
        )
        entry["rows"] = max(entry["rows"], row)
        entry["cols"].add(column)
        fmt = node.get("format", {})
        if fmt.get("empty"):
            continue
        # One representative cell per visual style keeps the blueprint readable
        # on a workbook with thousands of cells.
        fingerprint = json.dumps(
            {
                key: value
                for key, value in fmt.items()
                if key not in ("value", "cachedValue", "computedValue", "richtext")
            },
            sort_keys=True,
            default=str,
        )
        if fingerprint not in entry["styles"] and len(entry["styles"]) < 12:
            entry["styles"][fingerprint] = {
                "range": node.get("path"),
                "props": {
                    key: value
                    for key, value in fmt.items()
                    if key != "richtext" and len(str(value)) < 60
                },
            }
        if row <= 3:
            entry["head"].append(
                {
                    "cell": f"{column}{row}",
                    "value": str(node.get("text") or fmt.get("value") or "")[:60],
                }
            )

    inventory = sheet_inventory(path)
    out_sheets = []
    for name, entry in sheets.items():
        cols = sorted(entry["cols"], key=lambda c: (len(c), c))
        out_sheets.append(
            {
                "name": name,
                "used_range": f"{cols[0] if cols else ''}1:"
                f"{cols[-1] if cols else ''}{entry['rows']}"
                if cols
                else "",
                "tab_color": inventory.get(name, {}).get("tab_color", ""),
                "freeze": inventory.get(name, {}).get("freeze", ""),
                "merged": inventory.get(name, {}).get("merged", 0),
                "head": entry["head"],
                "distinct_styles": list(entry["styles"].values()),
            }
        )
    for name, info in inventory.items():
        if name not in sheets:
            out_sheets.append({"name": name, "used_range": "", **info})

    return {
        "kind": "xlsx",
        "theme": theme(binary, path),
        "sheets": out_sheets,
    }


def sheet_inventory(path: str) -> dict[str, dict]:
    """Sheet names, tab colours, freeze panes and merges straight from the
    package - cheap, and it catches empty sheets officecli has no cells for."""
    workbook = zip_read(path, "xl/workbook.xml") or ""
    rels = rels_of(path, "xl/workbook.xml")
    sheets: dict[str, dict] = {}
    for tag in re.findall(r"<sheet [^>]*/>", workbook):
        name = re.search(r'name="([^"]*)"', tag)
        rel = re.search(r'r:id="([^"]*)"', tag)
        if not name or not rel:
            continue
        info: dict = {"tab_color": "", "freeze": "", "merged": 0}
        entry = rels.get(rel.group(1))
        if entry:
            raw = zip_read(path, entry[1]) or ""
            colour = re.search(r"<tabColor[^>]*rgb=\"([0-9A-Fa-f]{8})\"", raw)
            if colour:
                info["tab_color"] = "#" + colour.group(1)[2:]
            if re.search(r"<pane[^>]*state=\"frozen\"", raw):
                info["freeze"] = "frozen"
            info["merged"] = len(re.findall(r"<mergeCell ", raw))
        sheets[name.group(1)] = info
    return sheets


# --------------------------------------------------------------------------

SUMMARY = {
    "pptx": lambda bp: (
        f"{bp['slides']} slides {bp['size_in'][0]}x{bp['size_in'][1]}in"
    ),
    "docx": lambda bp: (
        f"{len(bp['body'])} body entries, {len(bp['styles'])} styles used, "
        f"{len(bp['decorations'])} header/footer parts"
    ),
    "xlsx": lambda bp: f"{len(bp['sheets'])} sheets",
}


def summarize(path: str, bp: dict) -> str:
    lines = [f"{os.path.basename(path)} · {bp['kind']} · "
             f"{SUMMARY[bp['kind']](bp)}"]
    head = bp.get("theme") or {}
    if head:
        lines.append(
            "theme: "
            + str(head.get("name", ""))
            + " · headings "
            + str(head.get("headingFont") or head.get("font.major") or "")
            + " · body "
            + str(head.get("bodyFont") or head.get("font.minor") or "")
            + " · accent1 "
            + str(head.get("accent1") or "")
        )
    if bp["kind"] == "pptx":
        for slide in bp["slide_list"]:
            lines.append(
                f"slide {slide['index']} [{slide['layout']}] "
                f"{len(slide['shapes'])} shapes"
            )
            for shape in slide["shapes"]:
                capacity = shape.get("capacity")
                box = shape.get("box_in")
                where = (
                    f"@{box[0]},{box[1]}in" if box else "no box"
                )
                if capacity:
                    lines.append(
                        f"    {shape['role']:<11} {shape['size']:>5} "
                        f"{capacity['chars_per_line']:>3}x"
                        f"{capacity['max_lines']}={capacity['max_chars']:>4} "
                        f"car | ahora {capacity['now_chars']:>4} | "
                        f"{where} | {shape['text'][:40]!r}"
                    )
                else:
                    lines.append(
                        f"    {shape['role']:<11} {where} | "
                        f"{shape.get('text', '')[:40]!r}"
                    )
    elif bp["kind"] == "docx":
        for style_id, fmt in bp["styles"].items():
            lines.append(
                f"    {style_id:<16} {fmt.get('name', '')} "
                f"{fmt.get('size', '')} {fmt.get('color', '')} "
                f"{'bold' if fmt.get('bold') else ''} "
                f"before={fmt.get('spaceBefore', '')}"
            )
        for entry in bp["body"][:40]:
            text = entry.get("text", "")
            lines.append(
                f"    {entry.get('style', ''):<16} {entry.get('path', '')} "
                f"{text[:50]!r}"
            )
    else:
        for sheet in bp["sheets"]:
            lines.append(
                f"    {sheet['name']:<28} {sheet.get('used_range', '')} "
                f"tab={sheet.get('tab_color', '')} "
                f"freeze={sheet.get('freeze', '')} "
                f"merges={sheet.get('merged', 0)}"
            )
            for style in sheet.get("distinct_styles", [])[:4]:
                lines.append(f"        {style['props']}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="pptx, docx or xlsx to read")
    parser.add_argument("-o", "--output", help="write the blueprint here")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        raise SystemExit(f"no existe: {args.file}")
    kind = os.path.splitext(args.file)[1].lower().lstrip(".")
    if kind not in ("pptx", "docx", "xlsx"):
        raise SystemExit("soporta .pptx, .docx y .xlsx")

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from check_overlaps import binary  # noqa: E402

    cli = binary(None)
    blueprint = {
        "pptx": pptx_blueprint,
        "docx": docx_blueprint,
        "xlsx": xlsx_blueprint,
    }[kind](cli, args.file)
    blueprint["file"] = os.path.abspath(args.file)

    text = json.dumps(blueprint, indent=2, ensure_ascii=False, default=str)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print(f"blueprint: {args.output} ({len(text) // 1024} KB)")
        print(summarize(args.file, blueprint))
    else:
        print(text)


if __name__ == "__main__":
    main()
