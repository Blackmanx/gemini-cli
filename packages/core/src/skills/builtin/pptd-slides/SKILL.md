---
name: pptd-slides
description: Build a presentation from the .pptx template the project provides, so it looks like the ones already delivered. Covers editing a template slide in place, deleting the slides you do not need, replacing text, reusing the template's figures, and the layout and colour traps that make a deck look wrong. Use when the user asks for a deck, presentation, slides or PPTX that has to match the project's corporate template. Exception: when the user hands an existing .pptx as the base or style source (a path, "con el estilo de este"), do NOT use the project template — that is office-style-transfer, even if branding is requested; the project template applies only when the user gives no reference file.
---

# Presentations from a project template (.pptx)

## The one rule that matters

**Copy slides from the template and edit them. Never build slides from layouts.**

The breadcrumb, the page number, the footer and the decorative waves are drawn
**on each slide**, not inherited from the layout. A slide created from a layout
therefore comes out bare — one placeholder, no chrome — no matter how correct
the layout is. Measured on the template this skill was written against:

| | a real template slide | a slide created from its layout |
| --- | --- | --- |
| shapes | 5 — body, breadcrumb, 3 placeholders | **1** |

So a deck that "uses the template" only if its slides came *from* the template.

```bash
cp "$TEMPLATE" deck.pptx
officecli close deck.pptx
```

Identify the template's closing slide before pruning — it is the deck's end
card, usually a `ONE_COLUMN_TEXT` slide. Do not assume it is the source deck's
final page: appendix slides often follow it. Select the closing slide
explicitly and ensure no retained slide follows it.

```bash
officecli batch deck.pptx --commands "$(python3 -c '
import json
keep, total = {1, 2, 3, 4, 5, 6, 27, 50, 117}, 120   # your picks, deck length
print(json.dumps([{"command": "remove", "path": f"/slide[{i}]"}
                  for i in range(total, 0, -1) if i not in keep]))')"
```

Replace `keep` with the slides selected for this deck and use the correct
closing-slide index and total for the source template. Descending deletion
preserves the original indices; because the closing slide is the highest
retained index, it becomes the final slide.

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

## Inventory the template

If the project has no deck to follow, this skill ships a neutral one:
`assets/templates/neutral-deck.pptx` — cover, agenda, divider, two columns,
three cards, bullets, metrics, a native chart, a timeline, a table, a quote and
an end card. Copy it and prune it exactly as you would a project template.



A corporate deck is a kit: content slides, covers, section dividers, an agenda,
a timeline, an org chart, team and chart slides, and an end card. Which indexes
hold which is a property of the deck you were given, so read it before planning
— one call lists the whole file, and one candidate in full:

```bash
officecli query deck.pptx "*" --compact --fields x,y,width,height,size
officecli query deck.pptx "/slide[45]/*"
```

The content slides are the ones that already carry the breadcrumb, the footer
and the page number; the structural slides sit around them. Pick a content range
and vary the picks — candidates differ in shape count, so consecutive slides
taken from different parts of the range do not look identical. A proposal is:
cover, index, the content slides with a divider between blocks, and the closing
slide. Divider slides are meant to carry the block's name; do not mistake a
timeline's own first and last slide for an opening and a closing one.

## Make the title fit

A cover title is usually anchored to its **bottom** and has **no autofit**,
with the subtitle sitting inside the title's area: a second line grows upward
and prints straight through the subtitle. Measure both boxes before writing:

```bash
python3 scripts/check_overlaps.py deck.pptx --capacity /slide[1]
```

Keep the cover title on one line: shorten it, or drop the size until it fits.

```bash
officecli set deck.pptx "/slide[1]/shape[@id=1284]" --prop size=34pt
```

As a rule of thumb a 54pt cover title takes roughly 20 characters and a 34pt one about 34, but trust `--capacity` over the rule.

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
**one-line label the template shipped with**. Writing a longer title into it
does not error and does not change the box on disk:

```bash
officecli get deck.pptx "/slide[5]/group[...]/shape[@id=...]"
# height=...emu   <- one line at the shipped size, plus spcFirstLastPara and insets
```

PowerPoint recomputes that `cy` only when the file is opened and re-saved, so
until then it renders two lines inside a box that claims one, and the second
line lands on the paragraph below. Measure the box with
`check_overlaps.py --capacity` before writing into a card title.

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

The closing slide is the template's end card — the deck's own art, no body text.
It is required even when the brief does not explicitly request a conclusion, and
it must be last in the finished deck. Write the closing line on it.

Before delivery, query the final slide index and verify that the last slide is
the end card and carries the closing message. If it is missing or another slide
comes after it, rebuild from the untouched template and preserve the end card;
never substitute a blank slide or claim the deck is complete without it.

The breadcrumb is constant across the content slides and names the project in
whatever form the template uses. Set it once on every content slide, not per
slide.

## Prevent overlap before delivery

Template text is not a free-form canvas. Identify each exact shape and its role
before editing it; do not infer that a long sentence belongs in a title, subtitle
or card label just because it is nearby in reading order. Preserve the template's
separate title and description shapes. Keep titles to one line when the template
anchors them beside or above a subtitle; shorten the title or reduce its font
size rather than letting it wrap into the description. Card headings and body
copy must also stay within the individual shape's measured capacity.

After replacing text, run the overlap checker on the **entire final deck**:

```bash
python3 scripts/check_overlaps.py deck.pptx
```

Treat a non-zero result as a release blocker. Fix every finding by shortening
the text, reducing its font size, or choosing a slide whose text areas fit the
content. Never move, resize, or delete template shapes to hide a collision.
Repeat the check after each correction; do not deliver until it exits zero.

The checker reports text outside a no-autofit shape and intersections between
rendered text, including text inside groups. It compares where the glyphs land,
not just the shape rectangles, so it catches the `spAutoFit` trap described
above. `officecli view deck.pptx issues` is only a cross-check: it misses shapes
inside groups and is not the release gate.

When changing the wording is not acceptable and no matching slide exists, report
that the content does not fit this template rather than delivering overlapping
text.

## Do not use `SECTION_TITLE_AND_DESCRIPTION`

Its BODY placeholder resolves to black text on a black panel: the slide comes out
as a black rectangle with unreadable text, and nothing warns. It is the only
layout in either deck with this problem. A LibreOffice render hides it, because
LibreOffice resolves the panel's `lt2` against the wrong theme and paints it
white — check in PowerPoint, not in the preview.

## Figures

The template carries its pictures inside the `.pptx`, often with **no alt text
at all** — an export can strip every one — and the slide titles say nothing
about them. Inventory the deck's own art before reaching for a new image;
reusing it is what keeps the result looking like the template:

```bash
officecli query deck.pptx "/slide[i]/*" --compact    # what each slide holds
```

Then `officecli add ... type picture` with `src`, `x`, `y`, `alt` — there is no
`w` or `h`:

```bash
officecli batch deck.pptx --commands '[
  {"command":"add","parent":"/slide[2]","type":"picture",
   "props":{"src":"figura.png","x":"2cm","y":"3cm","alt":"Crecimiento"}}]'
```

A corporate template can hold hundreds of pictures — icon sets, families of
illustrations, photographs, partner logos: inventory before inventing.

## Finishing

```bash
officecli validate deck.pptx     # OpenXML schema
```

Deliver the `.pptx`. Say which template it came from and which slides you kept
or removed, so the next person knows what was dropped and why. Under WSL the
file belongs on the Windows filesystem for review — normally the user's
Windows Downloads (`/mnt/c/Users/<user>/Downloads`; see the session context's
`<windows_paths>` block) — not the Linux workspace.
