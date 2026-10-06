---
name: pptd-slides
description: Create and edit professional corporate presentations using the PPTD format — a YAML design DSL that compiles to PPTX via the kimi-slides CLI. Use when the user asks to create, edit, replicate, or rebrand a presentation/deck/PPT/PPTX, especially when a corporate template must be matched exactly, when deck-wide visual consistency matters (same background, header, theme on every slide), or when iterative visual review (screenshot + fix rounds) is required. Covers the full workflow from template analysis to validated delivery.
---

# PPTD Slides

PPTD is a YAML design DSL for presentations: one `.pptd` main file + one `.page` file per slide + a `media/` folder. The `kimi-slides` CLI converts PPTX ↔ PPTD, validates projects, and renders screenshots. This skill encodes the workflow and the hard rules that make decks come out clean on the first delivery.

## Tooling check (do first)

Run `command -v kimi-slides`. If present, use it for `convert`, `check`, and `screenshot`. If absent, work in PPTD anyway (any YAML-capable agent can author it) and replace CLI validation with a YAML parse of every file plus the manual review checklist in `references/design-rules.md`. Full CLI usage: `references/pptd-format.md`.

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
`assets/templates/Template PPTs.OSCURO.pptx` (dark variant). To work from it
rather than from prose, convert it first:

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
