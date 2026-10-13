#!/usr/bin/env python3
"""
Clone a slide of a .pptx, with its art, layout and styles intact.

    python3 clone_slide.py <deck.pptx> <source 1-based> [--at <position>]

`--at` is where the copy lands (1-based, in presentation order); it defaults
to right after the source.

The clone is a byte copy of the slide part plus its relationships, so every
picture, colour and placeholder rule travels with it - an empty slide created
from the same layout would leave the design behind. The copy gets its own part
name, relationship and `<p:sldId>` entry; notes and comment relationships are
dropped, because those parts belong to exactly one slide.
"""

from __future__ import annotations

import argparse
import os
import posixpath
import re
import sys
import zipfile

SLIDE_REL = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
)
SLIDE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
)
SLIDE_ID_RE = re.compile(r"<[^<>]*?sldId\b[^<>]*?/>")
REL_TAG_RE = re.compile(r"<Relationship\b[^>]*/>")


def read_rels(rels_xml: str, part: str) -> dict[str, tuple[str, str]]:
    """id -> (type, target) of one part, resolved against its own folder."""
    out: dict[str, tuple[str, str]] = {}
    match = re.search(r"<Relationships[^>]*>(.*)</Relationships>", rels_xml, re.S)
    if not match:
        return out
    for rel in REL_TAG_RE.findall(match.group(1)):
        attrs = dict(re.findall(r'([\w:.-]+)="([^"]*)"', rel))
        ident, target = attrs.get("Id", ""), attrs.get("Target", "")
        if not ident or attrs.get("TargetMode") == "External" or not target:
            continue
        resolved = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(
                posixpath.join(posixpath.dirname(part), target)
            )
        )
        out[ident] = (attrs.get("Type", ""), resolved)
    return out


def presentation_order(pres: str, rels: dict[str, tuple[str, str]]) -> list[str]:
    """Slide parts, in presentation order (the order `officecli` reports)."""
    order = []
    for tag in SLIDE_ID_RE.findall(pres):
        for key, value in re.findall(r'([\w:.-]+)="([^"]*)"', tag):
            if key.endswith(":id") and value.startswith("rId"):
                entry = rels.get(value)
                if entry:
                    order.append(entry[1])
                break
    return order


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deck")
    parser.add_argument("source", type=int, help="1-based slide to clone")
    parser.add_argument(
        "--at",
        type=int,
        help="1-based position for the copy (default: after the source)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.deck):
        raise SystemExit(f"no existe: {args.deck}")
    with zipfile.ZipFile(args.deck) as zf:
        names = zf.namelist()
        blobs = {name: zf.read(name) for name in names}

    pres_part = "ppt/presentation.xml"
    rels_part = "ppt/_rels/presentation.xml.rels"
    pres = blobs[pres_part].decode("utf-8", "replace")
    pres_rels_xml = blobs[rels_part].decode("utf-8", "replace")
    pres_rels = read_rels(pres_rels_xml, pres_part)

    slides = presentation_order(pres, pres_rels)
    if not slides:
        raise SystemExit("el deck no tiene diapositivas")
    if not 1 <= args.source <= len(slides):
        raise SystemExit(
            f"la diapositiva {args.source} no existe (hay {len(slides)})"
        )
    at = args.at if args.at is not None else args.source + 1
    at = max(1, min(at, len(slides) + 1))

    numbers = [
        int(match.group(1))
        for name in names
        for match in [re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name)]
        if match
    ]
    new_number = max(numbers, default=0) + 1
    new_part = f"ppt/slides/slide{new_number}.xml"
    source_part = slides[args.source - 1]
    blobs[new_part] = blobs[source_part]

    # The relationships are copied, not rebuilt: the layout, the pictures and
    # the hyperlinks of the original are exactly what makes the copy look like
    # the original. Notes and comments are the exception - those parts point
    # back at one slide only.
    source_rels = f"ppt/slides/_rels/{posixpath.basename(source_part)}.rels"
    new_rels_part = f"ppt/slides/_rels/slide{new_number}.xml.rels"
    if source_rels in blobs:
        text = blobs[source_rels].decode("utf-8", "replace")
        kept = [
            rel
            for rel in REL_TAG_RE.findall(text)
            if "notesSlide" not in rel and "comment" not in rel.lower()
        ]
        head = re.search(r"<Relationships[^>]*>", text)
        if head:
            body = "\n  ".join(kept)
            blobs[new_rels_part] = (
                f"{head.group(0)}\n  {body}\n</Relationships>"
            ).encode("utf-8")

    # [Content_Types].xml has to know the new part exists.
    types = blobs["[Content_Types].xml"].decode("utf-8", "replace")
    if f'PartName="/{new_part}"' not in types:
        override = (
            f'<Override PartName="/{new_part}" '
            f'ContentType="{SLIDE_CONTENT_TYPE}"/>'
        )
        blobs["[Content_Types].xml"] = types.replace(
            "</Types>", override + "</Types>"
        ).encode("utf-8")

    # Its own relationship in the presentation part...
    used = {
        int(match.group(1))
        for match in re.finditer(r'Id="rId(\d+)"', pres_rels_xml)
    }
    new_rid = f"rId{max(used, default=0) + 1}"
    relationship = (
        f'<Relationship Id="{new_rid}" Type="{SLIDE_REL}" '
        f'Target="slides/{posixpath.basename(new_part)}"/>'
    )
    blobs[rels_part] = pres_rels_xml.replace(
        "</Relationships>", relationship + "</Relationships>"
    ).encode("utf-8")

    # ... and its own <p:sldId> at the requested position. The entry is shaped
    # like the first one so whatever namespace prefixes the file uses are
    # preserved.
    entries = SLIDE_ID_RE.findall(pres)
    if not entries:
        raise SystemExit("presentation.xml no tiene <p:sldIdLst>")
    numeric = [
        int(value)
        for entry in entries
        for _, value in re.findall(r'([\w:.-]+)="([^"]*)"', entry)
        if value.isdigit()
    ]
    new_id = max(max(numeric, default=256) + 1, 257)
    new_entry = re.sub(
        r'(?<![\w:.-])id="\d+"', f'id="{new_id}"', entries[0], count=1
    )
    new_entry = re.sub(r'"rId\d+"', f'"{new_rid}"', new_entry, count=1)

    insert_at = at - 1
    if insert_at < len(entries):
        position = pres.index(entries[insert_at])
        pres = pres[:position] + new_entry + pres[position:]
    else:
        closing = re.search(r"</[^<>]*?sldIdLst>", pres)
        if not closing:
            raise SystemExit("presentation.xml: falta </p:sldIdLst>")
        pres = pres[: closing.start()] + new_entry + pres[closing.start() :]
    blobs[pres_part] = pres.encode("utf-8")

    added = [name for name in (new_part, new_rels_part) if name in blobs]
    tmp = args.deck + ".cloning"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for name in names + [name for name in added if name not in names]:
            out.writestr(name, blobs[name])
    os.replace(tmp, args.deck)

    print(
        f"clonada /slide[{args.source}] -> /slide[{at}] "
        f"(parte {new_part}, {new_rid})"
    )


if __name__ == "__main__":
    main()
