# Design rules and quality checklist

Visual rules distilled from building and iteratively reviewing corporate decks with real user feedback. Read before laying out pages and again before delivery.

## Contents

1. Consistency rules (non-negotiable)
2. Page anatomy and measurements (720×405 baseline)
3. Typography scale
4. Cards and content blocks
5. Color usage on dark themes
6. Imagery
7. Common failure modes and fixes
8. Pre-delivery checklist

---

## 1. Consistency rules (non-negotiable)

These are the violations users notice immediately:

1. **Same background on all pages of the same type.** If the brand is dark navy, EVERY content page is dark navy. A single light page reads as a bug, not variety.
2. **Same header block on every content page** — identical positions, sizes, and styles; only the title text changes.
3. **Theme tokens, not raw hex.** All color decisions live in `theme.colors`; pages reference `$tokens`. This makes later recolors one-line changes.
4. **One accent logic**: assign semantic meaning to accent colors (e.g. cyan = neutral/structure, coral = risk/attack/warning, purple = defense/response) and keep it stable across the whole deck.
5. Number pages with zero-padded filenames (`01_...`, `02_...`) and show the page number on every content page.

## 2. Page anatomy (720×405 baseline)

Standard content-page header pattern that has survived multiple review rounds:

| Element | Bounds [x,y,w,h] | Notes |
|---|---|---|
| Eyebrow / crumb | [40, 22, 400, 12] | 7px, letterSpacing ~1.5–2, muted color, uppercase: `COMPANY · AREA · CONTEXT` |
| Logo | [598, 18, 82, 23.8] | top-right, fixed; every page |
| Accent bar | [40, 46, 5, 28] | 5px-wide rect in primary accent, left of title |
| Title | [56, 44, 620, 32] | ends at x=676 — never crosses under the logo zone |
| Page number | [662, 378, 18, 12] | bottom-right, accent color |
| Content zone | y ≈ 86–360, x = 40–680 | all body content lives here |

Title discipline: ~45–55 characters max at 24–26px. If a draft title is longer, shorten it — do not shrink the font or widen the box into the logo.

Scale proportionally for 960×540 (multiply all values by 4/3).

## 3. Typography scale (720×405)

| Role | Size | Weight | Color role |
|---|---|---|---|
| Page title | 24–26 | bold, display font | strongest text color |
| Card/section label (eyebrow) | 7–8 | regular, letterSpacing 1.5–2 | accent color, uppercase |
| Card title | 12–14 | bold | strongest text color |
| Body | 10–11 | regular | soft text color |
| Card body / flow box | 8.5 | regular | near-strongest color |
| Captions / notes | 9–9.5 | regular | muted color |
| Big numerals (01, 02) | 18–22 | bold | accent color |

- Never go below 8px for anything meant to be read.
- lineHeight 1.25 for tight card text, 1.3–1.4 for paragraphs.
- Two fonts maximum: one display font for titles, one text font for body. Declare both in `customFonts`.

## 4. Cards and content blocks

- Card fill slightly lighter than the page background (dark theme: page `#0E1245` → card `#171C4E`), 1px border in a subdued line color (`#3A3F78`-class), accent border only to mark category/role.
- roundRect `adjustments: [10000]` gives a modern, restrained radius.
- Internal padding: keep text boxes ≥8px away from card edges on all sides.
- Card body text: 3 lines max at 8.5px in a ~46px-tall box. If it doesn't fit, cut words — never reduce below 8px.
- Flow diagrams (step boxes + arrows): boxes of equal size, 14px gap with a 1.5px stealth-arrow line, last box may be a solid accent "result" box for contrast. Five steps fit comfortably at 720 wide.
- Bullet lists inside cards: real `<p>` lines with `·` or styled bullets, not one wrapped paragraph.

## 5. Color on dark themes

- Text hierarchy: pure/near white for titles and key data → soft lavender-grey (`#C9CEEA`-class) for body → muted (`#9AA3C7`-class) for captions.
- Accents: one primary bright accent (cyan-class) + up to three semantic accents (coral = alert/offensive, purple = defensive, deep cyan = platform/hardware). More than four accents per deck reads as noise.
- Solid accent-filled boxes (e.g. coral result card) use white text and no border.
- Never pure black text on the dark background, never pure white full-page backgrounds mixed into a dark deck.

## 6. Imagery

- Reuse the brand's own extracted media (logos, swooshes, rings) before searching for anything.
- Logos: keep the white variant for dark pages; produce a dark variant by programmatic recolor (numpy: recolor white pixels to the brand navy, keep alpha) for the rare light page.
- Decorative brand graphics (swoosh, rings) belong on cover and closing pages, low-opacity, bleeding off edges — not behind body text.
- If photos are needed, batch-search/download them before page design, store in `media/`, never stretch (use `fit: cover`).

## 7. Common failure modes and fixes (from real review rounds)

| Symptom | Cause | Fix |
|---|---|---|
| `YamlParseError` on one page | unquoted `:` in a `text:` value or flow mapping | wrap the value in double quotes or use a block scalar |
| Title overlaps logo | title box too wide / text too long | shorten title text; keep box ≤620 wide |
| Text touches card border | text box equals card box | inset text box by 8–10px on each side |
| "Two slides don't follow the style" | background or header drifted | restore `$token` background + verbatim header block |
| Checker says TextOverflow but render is fine | heuristic mock metrics | confirm visually; if fine, leave it |
| Edit tool fails to match | user edited the file (different quoting) | re-read the file, match the CURRENT exact string |
| User says "make it easier to understand" | jargon/abbreviations | gloss acronyms in plain words, keep structure |
| User rejects locked-in use case | premature commitment | present candidates as selectable chips/options |
| User removes a partner/section | — | propagate: delete mentions of it across ALL pages, then re-check |

## 8. Pre-delivery checklist

Run through this before delivering, every time:

- [ ] `kimi-slides check` (or manual YAML parse) — zero errors
- [ ] Screenshots of ALL pages reviewed as a stitched grid, plus individual review of dense pages
- [ ] Every page: correct background, header block, logo, page number
- [ ] No text overflow, no border-touching text, no title/logo collision
- [ ] All colors via `$tokens`; all fonts declared in `customFonts`
- [ ] Scope respected (no budget/timeline/work-packages unless requested)
- [ ] No speaker notes, no animations (unless requested)
- [ ] All user edits from previous turns preserved; no reverted content
- [ ] Project self-contained: all media inside the folder, all paths relative
- [ ] Deliver the `.pptd` main file; mention it can be previewed/edited/exported in the editor
