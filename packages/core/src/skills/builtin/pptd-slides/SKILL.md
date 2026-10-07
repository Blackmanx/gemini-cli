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
officecli batch deck.pptx --commands "$(python3 -c '
import json
keep, total = 6, 120
print(json.dumps([{"command": "remove", "path": f"/slide[{i}]"}
                  for i in range(total, keep, -1)]))')"
```

Deleting 114 slides takes about three seconds in one batch.

### Read the whole deck in one call, never one call per slide

This is where decks get expensive. `officecli query deck.pptx "/slide[2]/*"`
prints the full property dump of one slide — geometry, every colour, and the
raw bullet XML — for roughly 15 KB. Doing that per slide to learn what is on
them is what turns a deck into hundreds of tool calls.

`--compact` prints one tab-separated line per element, label and text only:

```bash
# the entire deck, every element, one line each
officecli query deck.pptx "*" --compact --fields x,y,width,height,size
```

That is the whole deck in about 11 KB, whatever its length, and the last line
reports how many elements were listed — so a single call tells you whether you
have seen everything.

Then write everything in one batch. Twenty `set` calls in a batch cost the same
wall-clock as one; twenty separate calls cost twenty round trips:

```bash
officecli batch deck.pptx --commands '[
  {"command":"set","path":"/slide[2]/shape[@id=1300]","props":{"text":"La propuesta"}},
  {"command":"set","path":"/slide[2]/shape[@id=1299]","props":{"text":"ValidAI"}}]'
```

**Look before you write.** `check_overlaps.py --capacity` prints, for every text
shape, how many characters fit on a line and how many lines the shape is tall
enough to show — read off the real geometry and font, no guessing:

```bash
python3 scripts/check_overlaps.py deck.pptx --capacity /slide[5]
# /slide[5]/group[@id=2433]/shape[@id=2437]  17.0pt  16 car/linea x 1 linea(s) = 16 car
```

Sixteen characters, and `Arquitectura Multiagente` is twenty-four. That is the
whole defect, visible before a word is written, instead of after a render.
Write to the budget, run the check once, and the deck arrives clean the first
time.

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

### The `spAutoFit` trap

This is why a deck can pass a shape-geometry check and still be broken, and it
is the single most common defect in these cards.

A card title carries `<a:spAutoFit/>` and a `cy` frozen at the height of the
**one-line label the template shipped with**. Writing a two-word title into it
does not error and does not change the box on disk:

```bash
officecli get deck.pptx "/slide[5]/group[@id=2433]/shape[@id=2437]"
# height=485487emu   <- one line at 17pt, plus spcFirstLastPara and the insets
```

PowerPoint recomputes that `cy` only when the file is opened and re-saved, so
until then it renders two lines inside a box that claims one. Measured on the
three-card slide: the title box ends 0.85 cm above the paragraph below it, one
line takes 1.1 cm, and the second line lands squarely on the body text.

Three titles that break this way out of the box, in both decks:

| title | text | box | renders as |
| --- | --- | --- | --- |
| `Arquitectura Multiagente` | 24 chars | one line | two lines |
| `Ciberseguridad en IA` | 20 chars | one line | two lines |
| `Trazabilidad Blockchain` | 23 chars | one line | two lines |

So a rectangle comparison finds nothing and the deck is still wrong. Compare
the **text**, not the box — that is what `scripts/check_overlaps.py` does, and
why it reports a collision where the geometry looks clean.

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

**The closing slide is the template's last one** and it is easy to delete by
accident. `ONE_COLUMN_TEXT` — dark #123, clara #117 — is the end card: navy, the
waves, the corporate logo centred, and no text. It is the last thing in the template
and carries none of the sample prose, so it reads as surplus when you are
deleting the slides you did not use. Keep it, write the closing line on it, and
put it last.

The breadcrumb is constant across the content slides and names the project:
`corporate · I+D · <convocatoria>`. Set it once on every content slide, not per slide.

## Check before delivering

```bash
python3 scripts/check_overlaps.py deck.pptx
```

One command, the whole deck, non-zero while anything is wrong. It reports two
things:

- **texto que se sale** — the string needs more lines than the shape is tall and
  the shape has no autofit, so it prints outside the shape.
- **texto sobre texto** — two runs of text land on the same pixels. It measures
  where the glyphs go, not where the boxes are, which is the only way to see the
  `spAutoFit` trap above: the box geometry is clean and the deck is still wrong.

Run it after filling the text, not before: the overlaps only exist once the
sentences are in. It reads the entire slide tree in a single `officecli query`,
so it costs one call, not one per slide.

**Its output is the baseline, not decoration.** The untouched template reports
nothing in the 27–90 content range; a deck built from it should report nothing
either. Every finding is a real defect and is fixed by shortening the text or
changing the size — never by adjusting geometry, because the geometry is the
template's and it is correct. If a finding survives both, the honest fix is
another slide from the range.

`officecli view deck.pptx issues` is a useful cross-check for the structural
checks, but it only sees top-level shapes: everything inside a group — which is
most of these cards — is invisible to it, and it reports text overflow for a box
the renderer will fix on its own. Use it for what it covers, not as the gate.

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
