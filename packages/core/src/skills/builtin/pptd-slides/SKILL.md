---
name: pptd-slides
description: Create and edit professional corporate presentations using the PPTD format — a YAML design DSL that compiles to PPTX via the kimi-slides CLI. Use when the user asks to create, edit, replicate, or rebrand a presentation/deck/PPT/PPTX, especially when a corporate template must be matched exactly, when deck-wide visual consistency matters (same background, header, theme on every slide), or when iterative visual review (screenshot + fix rounds) is required. Covers the full workflow from template analysis to validated delivery.
---

# PPTD Slides

PPTD is a YAML design DSL for presentations: one `.pptd` main file + one `.page` file per slide + a `media/` folder. The `kimi-slides` CLI converts PPTX ↔ PPTD, validates projects, and renders screenshots. This skill encodes the workflow and the hard rules that make decks come out clean on the first delivery.

## Tooling check (do first)

Run `command -v kimi-slides`.

- **Present** — use it for `convert`, `check` and `screenshot`, and work in PPTD.
- **Absent** — do not hand-roll python-pptx against the corporate template. Use
  `assets/templates/new_deck.py` (see below), which exists because that template is a
  Google Slides export and breaks the obvious python-pptx code in three ways.

## Building directly from the corporate template

The corporate deck is a Google Slides export. Three of its traits silently produce a
broken deck, which is why raw `python-pptx` against it is a trap:

1. **Content layouts have no `TITLE` placeholder.** The heading is exported as a
   `SUBTITLE`, so `slide.shapes.title` is `None` and any loop looking for
   placeholder index 0 writes nothing — the slide comes out untitled.
2. **Artwork overlaps the text boxes.** Most layouts carry decorative rings and
   bars positioned on top of the text placeholders, so text lands on the artwork.
3. **23 of the 55 layouts are built from `PICTURE` placeholders** — 88 in all,
   which is exactly where the good-looking designs live. Text written into one
   renders as nothing at all: no error, just a blank. Plain python-pptx
   therefore cannot use the image grids, two-column slides or section headers
   *at all*, and a deck built that way is text-only by accident.

`new_deck.py` handles all three and reports what it had to work around:

```bash
python3 assets/templates/new_deck.py --list            # every layout, CLASH flag and img= count
python3 assets/templates/new_deck.py --describe "3 imágenes"
python3 assets/templates/new_deck.py deck.pptx \
    --slide "0|Crecimiento del uso de IA en 2026|Informe corporate"
python3 assets/templates/new_deck.py deck.pptx --slides slides.json --trim-art
```

For anything beyond a title and a body, use `fields`, which addresses every
placeholder in a layout by index. This is how the image layouts get used:

```json
[{"layout": "13",
  "title": "Adopción por sector",
  "fields": {"2": {"image": "media/finanzas.png"},
             "3": {"image": "media/salud.png"},
             "4": "Retail: 70%"}},
 {"layout": "28",
  "title": "Tres palancas",
  "fields": {"19": {"image": "media/a.png"}, "20": {"image": "media/b.png"}}}]
```

### Reusing the template's own figures

The template carries ~210 images inside the .pptx: the corporate logo, the decorative
waves and rings, a few people illustrations, and a large set of grey line-art
icons in browser frames — globe, checklist, network, money, location, security,
video, tools. They are reusable content, but they live in the archive, not in an
asset folder, so there is nothing to point an `image` field at.

`figures.py` indexes them with stable ids:

```bash
python3 assets/templates/figures.py list              # id, size, and which slides use it
python3 assets/templates/figures.py sheet sheet.png   # contact sheet, for picking by eye
python3 assets/templates/figures.py extract 42 out.png
```

A slide spec cites one inline, with no file to supply:

```json
[{"layout": "13", "title": "Adopcion por sector",
  "fields": {"2": {"figure": 42}, "3": {"figure": 51}, "4": {"figure": 30}}}]
```

Build the contact sheet and look at it before choosing ids — the numbering is
alphabetical by media name, not by meaning. An id out of range is reported, not
silently skipped.

Run `--describe <layout>` first: it lists the text and image placeholder indices
so the `fields` keys are right. An index that is not in the layout is reported,
never ignored.

Layouts are named, not indexed — `--list` prints them, and an ambiguous name is
an error rather than a guess. `--trim-art` deletes only the artwork that
geometrically collides with a text placeholder. The template's 123 sample slides
are dropped on the way out, so the deck starts empty.

Read every warning. "image placeholder N left empty" means that decorative frame
stays as an empty circle — fill every image slot or choose a layout with the
count you need. "body appended to the heading" means the layout offers a single
text area.

Verify the result before delivering — this catches the collisions nothing else
will report:

```bash
soffice --headless --convert-to pdf deck.pptx && pdftoppm -png -r 50 deck.pdf page
```

**A render is not proof of visibility.** The deck ships two themes and they
disagree on `lt2`: black in one, near-white in the other. LibreOffice resolves
it against the wrong one and paints black panels white, so a slide whose text is
invisible in PowerPoint looks perfect in the PDF. `new_deck.py` therefore checks
the resolved text colour against the fill of whatever shape sits underneath, and
refuses any layout where they match — `SECTION_TITLE_AND_DESCRIPTION` is the one
it catches. Colour safety here is static analysis, not a screenshot.

## Workflow

### 1. Frame the request before writing any file

Determine four things; ask the user when they are not derivable from the request:

1. **Request type**: create from scratch / edit an existing deck / replicate a deck from images or PDF.
2. **Design source**: a provided PPTX template (convert it and extract its system), a style reference (images, web), or self-directed design.
3. **Input type**: topic only / full document / page-by-page outline. With only a topic, expand content via research unless the user says otherwise.
4. **Exact page count and scope**. Confirm what is OUT of scope: for a first-contact or idea-pitch deck this usually means NO budget, NO timeline, NO work packages — just the idea. Getting scope wrong means redoing pages.

### 2. If a corporate template exists, extract its design system first

```
kimi-slides convert template.pptx -o work/template/
kimi-slides screenshot work/template -o work/shots/
```

Stitch the screenshots into one grid image (PIL) and read it. Extract and record:

- Background color of every page type (sample pixels with PIL if unsure).
- Palette: accent colors, card fills, border colors, muted text colors — as hex.
- Fonts (titles vs body) and size hierarchy.
- Reusable components: cover layout, header band, logo placement, footers, card shapes (square vs rounded corners), dividers.
- Logo assets: reuse the extracted images from `media/`; if a logo only exists in white and a light page needs it, recolor programmatically (numpy) instead of finding a substitute.

Turn this into a `theme:` block (colors + textStyles) in the `.pptd` and a fixed header pattern reused verbatim on every content page. For a complete worked example (corporate corporate identity: palette tokens, Google Fonts setup, header pattern, card style) read `references/brand.md`; its assets are in `assets/templates/`.

The corporate corporate template ships with this skill at
`assets/templates/Template PPTs.OSCURO.pptx` (dark variant). Read its design
system out of the file rather than describing it from memory:

```bash
python3 assets/templates/extract-theme.py     # palette, fonts, layouts, media count
```

That reads the theme straight out of the PPTX and prints the `theme:` values
plus the layout names, in about a second. It wants `python-pptx`
(`pip install python-pptx`); without it the palette and fonts still come out,
since those live in the theme XML, and only the slide size and layouts are
skipped. `references/brand.md` is the same system already written up: read
it for the intent behind the values, not just the values.

When `kimi-slides` is available, prefer it for the full round trip:

```bash
kimi-slides convert "assets/templates/Template PPTs.OSCURO.pptx" -o work/template/
```

### 3. Build the project

```
deck_name/
  deck_name.pptd      # version: v2, size, theme, customFonts, pages list
  pages/01_cover.page # one file per slide, numbered with zero padding
  media/              # every referenced image, copied inside the project
```

Hard structural rules:

- **Fully self-contained**: all referenced files live inside the project folder; only relative paths (`pages/...`, `media/...`). External URLs are allowed only for images and fonts.
- **One theme, referenced everywhere**: define colors once in `theme.colors` and use `$token` references. Never hardcode a hex that already has a token.
- **Identical header on every content page**: crumb/eyebrow text, logo (top-right), accent bar, title, page number. Copy the block verbatim; only the title text changes.
- **Same background on every slide unless deliberately designing a divider/cover variant.** The most common real user complaint is "these two slides don't follow the style of the others". When in doubt, keep the corporate background.

### 4. Write pages — layout and content rules

Layout (details and measurements in `references/design-rules.md`):

- Keep every element inside the page bounds except intentional bleed.
- Titles must not collide with the top-right logo: cap title width and shorten long titles.
- Cards need internal padding: short text, centered, never touching borders. Estimate overflow conservatively; the checker is heuristic, so also look at the render.
- Leave breathing room: it is better to split a dense slide into two than to shrink fonts below ~8.5px body.

Content:

- Plain, concrete language. Gloss acronyms on first use (e.g. "hardware real conectado a una simulación" instead of bare "HIL"). If a reviewer says "make it easier to understand", simplify wording, not structure.
- No AI clichés: avoid "no es X, es Y", slogan stacks, "key takeaway", "N caminos", forced metaphors.
- Do not over-commit: if the user wants an open/generic use case, present candidate domains as options instead of locking one in.
- No speaker notes and no animations unless explicitly requested.
- Language of the deck = language of the user.

### 5. Validate — always, in loops

```
kimi-slides check deck_name --level keep      # repeat until zero errors
kimi-slides screenshot deck_name -o shots/    # then LOOK at every page
```

- Fix all errors. Treat warnings as prompts to inspect the render, not as automatic truths — intentional bleed/overlap can be ignored, everything else gets fixed.
- Visually review stitched screenshots of ALL pages after any multi-page change, and re-render affected pages after single-page edits. Look for: text cut off or touching card borders, title/logo overlap, inconsistent backgrounds, orphan empty space.
- Without the CLI: parse every `.page`/`.pptd` with a YAML parser, then apply the manual checklist in `references/design-rules.md`.

### 6. Iterate and deliver

- **Never revert user edits.** When the user modifies files between turns (renames, deletions, reworded text), treat their version as the baseline; re-read files before editing and match their exact quoting/style.
- When applying review comments, re-read the target file first — the user's edits change exact strings, so blind search-and-replace fails.
- Deliver the `.pptd` project (main file path), not a converted PPTX, unless the user explicitly asks for a different format. Tell the user the deck can be previewed/edited and exported from the editor.

## YAML pitfalls (the #1 source of broken decks)

- Quote any `text:` value containing `:`, `#`, `{`, `}`. Colons inside unquoted flow mappings are the classic failure: `{text: Title: subtitle}` breaks; `{text: "Title: subtitle"}` works.
- Prefer block scalars for rich text with inline HTML-ish tags:
  ```yaml
  content:
    text: |
      <p><span style="color:$cyan">LABEL</span></p>
  ```
- After user edits, quoting style may change between files — always `read` before `edit`.
- Validate YAML early: one broken page file can block the whole check run.

## Reference files

- `references/pptd-format.md` — condensed PPTD DSL spec (file structure, elements, fills, borders, theme) and full CLI command reference. Read when authoring or repairing PPTD syntax.
- `references/design-rules.md` — visual design rules, standard measurements, and the final quality checklist. Read before laying out pages and before delivery.
- `references/brand.md` — complete worked example of a corporate design system in PPTD (dark navy theme, fonts, header pattern, card styles), with ready-to-use assets in `assets/templates/`. Read when building a deck for corporate or as a model for extracting any other brand.
