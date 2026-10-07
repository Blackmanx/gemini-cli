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

**Slides 27 to 90 are the content range** in both decks — 64 slides that already
carry the breadcrumb, the footer and the page number. Slides 1–26 are covers,
section dividers and title samples; 91 onward are style specimens. Build a deck
out of 27–90 and vary the picks, so it does not read as one slide repeated.

| clara (120 slides) | oscura (123 slides) | slides | shape |
| --- | --- | --- | --- |
| `TITLE_AND_TWO_COLUMNS_2_1` | `TITLE_AND_TWO_COLUMNS_2` | 50 / 43 | the standard content slide |
| `TITLE_AND_TWO_COLUMNS_2_2_1` | `TITLE_AND_TWO_COLUMNS_2_2` | 9 / 11 | content plus a second element |
| `TITLE_AND_TWO_COLUMNS_2_3_1_2` | `TITLE_AND_TWO_COLUMNS_2_3_3` | 3 / 3 | three-part comparison |
| `TITLE_AND_TWO_COLUMNS_2_3_1_1` | `TITLE_AND_TWO_COLUMNS_2_3_2` | 2 / 2 | three-part, narrower |
| — | `TITLE_AND_BODY_2_2`, `TITLE_AND_TWO_COLUMNS_2_3` | 1 each | one-offs worth avoiding for variety |

They differ in shape count — 12, 16, 23, 29, 32, 33 — so consecutive slides
taken from different parts of the range do not look identical. List what a
candidate holds before keeping it:

```bash
officecli query deck.pptx "/slide[45]/*"
```

## Make the title fit

The title box on the cover is anchored to its **bottom** and has **no autofit**,
and the subtitle sits inside its area:

| | y | height | bottom | size |
| --- | --- | --- | --- | --- |
| subtitle | 2.50" | 0.55" | 3.05" | 18pt |
| title | 1.46" | 2.40" | 3.85" | 54pt |

At 54pt the template's own one-line title occupies 3.10"–3.85" and clears the
subtitle. Two lines grow upward to about 2.0" and print straight through it.
So a title has to stay on one line: either shorten it, or drop the size until it
fits.

```bash
officecli set deck.pptx "/slide[1]/shape[@id=1284]" --prop size=34pt
```

As a rule of thumb at 54pt the box takes roughly 20 characters; at 34pt about 34.

## Do not use `SECTION_TITLE_AND_DESCRIPTION`

Its BODY placeholder resolves to black text on a black panel: the slide comes out
as a black rectangle with unreadable text, and nothing warns. It is the only
layout in either deck with this problem. A LibreOffice render hides it, because
LibreOffice resolves the panel's `lt2` against the wrong theme and paints it
white — check in PowerPoint, not in the preview.

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
officecli validate deck.pptx     # OpenXML schema
```

Deliver the `.pptx`. Say which template it came from and which slides you kept
or removed, so the next person knows what was dropped and why.
