---
name: pptd-slides
description: Build corporate presentations from the department PowerPoint templates so they look like corporate made them. Covers editing an existing template slide in place, deleting the slides you do not need, replacing text, reusing the template's figures, and the layout and colour traps that make a deck look wrong. Use when the user asks for a deck, presentation, slides or PPTX in the company's corporate style, or to edit one of the corporate templates.
---

# corporate presentations

## The one rule that matters

**Copy slides from the template and edit them. Never build slides from layouts.**

The breadcrumb, the page number, the footer and the decorative waves are drawn
**on each slide**, not inherited from the layout. A slide created from a layout
therefore comes out bare — one placeholder, no chrome — no matter how correct
the layout is. Measured on the corporate template:

| | a real template slide | a slide created from its layout |
| --- | --- | --- |
| shapes | 5 — body, breadcrumb, 3 placeholders | **1** |

So a deck that "uses the template" only if its slides came *from* the template.

```bash
cp "$TEMPLATE" deck.pptx
officecli close deck.pptx

# keep the first N, delete the rest (delete from the end so indexes hold)
python3 - <<'EOF'
import json
keep = 6
total = 120                     # officecli get deck.pptx / | count
print(json.dumps([{"command": "remove", "path": f"/slide[{i}]"}
                  for i in range(total, keep, -1)]))
EOF
officecli batch deck.pptx --commands "$(python3 - <<'EOF'
import json
keep, total = 6, 120
print(json.dumps([{"command": "remove", "path": f"/slide[{i}]"}
                  for i in range(total, keep, -1)]))
EOF
)"

# see what is on the slide you are keeping, then replace the text
officecli query deck.pptx "/slide[2]/*"
officecli batch deck.pptx --commands '[
  {"command":"set","path":"/slide[2]/shape[@id=1298]","props":{"text":"Crecimiento de la IA"}}]'
```

Deleting 114 slides takes about three seconds in one batch.

## Which slides to keep

The template is 120 slides, and its own content slides cluster on a few layouts.
Keeping slides from the right ones is what makes the deck look consistent:

| layout | clara | oscura | use for |
| --- | --- | --- | --- |
| `TITLE_AND_TWO_COLUMNS_2_1` | 66 | — | the standard content slide, clara |
| `TITLE_AND_TWO_COLUMNS_2` | — | 63 | the standard content slide, oscura |
| `TITLE_AND_TWO_COLUMNS_2_2_1` / `_2_2` | 12 | 11 | a content slide with a second element |
| `1_título arriba - blanco` / `1_título arriba` | 4 | 5 | a slide led by a title on a wide band |
| `TITLE_AND_TWO_COLUMNS_2_3_1` / `_2_3` | 4 | 4 | three-part comparison |

Two decks ship with the skill, and they are different files with different
layout names:

| file | slides | layouts |
| --- | --- | --- |
| `assets/templates/Template PPTs.pptx` (clara) | 120 | 54 |
| `assets/templates/Template PPTs.OSCURO.pptx` (oscura) | 123 | 55 |

`officecli query` a few slides before choosing, and check what the body text box
already holds — replacing it means replacing all of it, not appending.

## Do not use `SECTION_TITLE_AND_DESCRIPTION`

Its BODY placeholder resolves to black text on a black panel: the slide comes out
as a black rectangle with unreadable text, and nothing warns. It is the only
layout in either deck with this problem. A LibreOffice render hides it, because
LibreOffice resolves the panel's `lt2` against the wrong theme and paints it
white — check in PowerPoint, not in the preview.

## Keep titles short

The title box is anchored `valign=bottom` with `autoFit=none`. A title longer
than the one the template shipped wraps onto a second line and grows upward into
the label above it, so "Crecimiento de la IA en España 2026" overprints
"Nombre del cliente". Use roughly the length the template's own slide uses.

## Figures

The templates carry their pictures inside the `.pptx`, with **no alt text at
all** — the Google Slides export strips all 3912 — and the slide titles are
useless as context (`49`, `Iconografia`). `figures.py` gives them ids and names:

```bash
python3 assets/templates/figures.py list --limit 40          # id, name, kind, slides
python3 assets/templates/figures.py search candado           # find by meaning
python3 assets/templates/figures.py extract 42 out.png       # write one out
```

Then `officecli add ... type picture` with `src`, `x`, `y`, `alt` — there is no
`w` or `h`:

```bash
officecli batch deck.pptx --commands '[
  {"command":"add","parent":"/slide[2]","type":"picture",
   "props":{"src":"figura.png","x":"2cm","y":"3cm","alt":"Crecimiento"}}]'
```

The clara deck has 587 readable pictures (blue icon set, a security/SSL family,
photographs of people, partner logos); the oscura one has 209.

## Finishing

```bash
officecli validate deck.pptx     # OpenXML schema; the templates pass except
                                 # three pre-existing chart errors in chart-workbook.xlsx
```

Deliver the `.pptx`. Say which template it came from and which slides you kept
or removed, so the next person knows what was dropped and why.