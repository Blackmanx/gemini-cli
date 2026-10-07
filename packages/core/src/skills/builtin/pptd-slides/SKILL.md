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

## The structural slides

A deck is not only its content. It opens, divides and closes, and the templates
have every one of those shapes — in slides 1 to 26, which sit outside the
content range:

| | clara | oscura |
| --- | --- | --- |
| cover | 1–5 | 7–12 |
| section divider | 6 | 13–14 |
| index / agenda | 7–8 | 15–16 |
| timeline | — | 105–106 |
| org chart, for partners | 106 | 112–113 |
| team and roles | 101–107 | 107–111 |
| chart slide | 108 | 114 |
| content | 27–90 | 27–90 |

So a proposal is: cover, index, then the content slides, a divider between
blocks of content, and a closing slide. The divider slides read "Separador de
temas" and are meant to carry the block's name.

**There is no closing slide in either deck.** Close on the cover or a divider
carrying the next step or the contact, or reuse a content slide with just a
title — do not invent a new design. `ONE_COLUMN_TEXT` (oscura 123, clara 117)
is a spare full-width slide if you want something plain.

Note that "Inicio" and "Fin" in the dark deck (105–106) are the **ends of a
timeline**, not an opening and a closing slide.

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

## How much text a shape holds

Every shape is sized for the label the template shipped. A longer sentence grows
out of a circle, a card or a bar and prints over its neighbour — nothing errors.
The shapes that bite most often:

| shape | fits |
| --- | --- |
| circle or Venn region | 2–4 words; it is a label, not a caption |
| card title | 2–3 words |
| card body | one clause |
| cover title | ~20 characters at 54pt |
| step or column heading | 3–5 words |

Write to the shape's capacity, not to how much you have to say. If the content
does not fit, that is a reason to pick another slide from the range, not to
overflow this one.

## Length follows the content

There is no slide count to hit and no ceiling to respect. A three-point summary
is three slides; a proposal with nine sections is nine or ten. Build as many as
the material needs, taking them from across the 27–90 range rather than
repeating one design.

Count the structural slides too. A deck that only holds the sections the brief
happened to list is missing its cover, its index, its dividers and its close —
the brief lists *content*, not structure. Ask what the material can fill, not how
many clauses the request has.

## The shape of a proposal deck

A ten-slide I+D proposal, as a worked reference:

| # | slide | it carries |
| --- | --- | --- |
| 1 | cover | title, one-line summary, client, date |
| 2 | context | the problem, and why it is urgent now |
| 3 | the idea | what the platform is, in two lines |
| 4 | objective and scope | general objective, then the specific ones |
| 5 | architecture | the diagram: input, the agent network, the output |
| 6 | how it works | one worked example, numbered steps |
| 7 | I+D lines | the lines to be researched, one card each |
| 8 | consortium | who does what, one column per partner |
| 9 | pilot | the open use case, end to end |
| 10 | why us, why now | three value cards and a closing band |

The last slide is the one that goes missing. It is not a "thank you": it is the
argument, three cards - differential innovation, market moment, complementary
consortium - over one full-width band naming what the call actually funds.

The breadcrumb is constant across the content slides and names the project:
`corporate · I+D · <convocatoria>`. Set it once on every content slide, not per slide.

## Composing a diagram

**The reference decks author their diagrams; they are not copied from the
template.** No template slide has a 34-shape architecture diagram in it, so
copying one and replacing text will never produce that. Add the elements.

```bash
officecli batch deck.pptx --commands '[
  {"command":"add","parent":"/slide[5]","type":"shape","props":{
     "x":"2cm","y":"3cm","w":"5cm","h":"1.6cm",
     "fill":"0E1245","color":"FFFFFF","text":"Sistema bajo prueba","margin":"6pt"}},
  {"command":"add","parent":"/slide[5]","type":"connector","props":{"x":"7.1cm","y":"3.8cm"}},
  {"command":"add","parent":"/slide[5]","type":"shape","props":{
     "x":"8.2cm","y":"3cm","w":"5cm","h":"1.6cm",
     "fill":"FF5C5C","color":"FFFFFF","text":"Informe y evidencias"}}]'
```

What matters when composing:

- `fill` takes a colour or `none`, and accepts theme modifiers - `accent1+lumMod75`,
  `accent2+shade60+alpha80` - so tints come from the palette instead of a guessed hex.
- `color` is the **text** colour, not the fill. `textColor` is not a property and is
  rejected with a warning.
- `geometry` chooses the preset: `rect`, `roundRect`, `ellipse`, `diamond`,
  `rightArrow`, `star5`, the `callout*` family.
- `margin` is inner padding; without it the text touches the border.
- `connector` draws the arrow between two boxes.

Start from a **sparse** content slide and delete what is on it first - adding
shapes on top of a slide that already carries a diagram gives you two diagrams
stacked. Then add yours and check with `check_overlaps.py` as usual.

## Check before delivering

```bash
python3 scripts/check_overlaps.py deck.pptx
```

It reads the geometry `officecli query` already reports and reports any two
text boxes that intersect, exiting non-zero while it finds them. Empty decorative
shapes are skipped — those overlapping their neighbours is the design. Run it
after filling the text, not before: the overlaps only exist once the sentences
are in.

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
