# PPTD format — condensed specification

PPTD is a YAML (1.2) design DSL that compiles losslessly to/from PPTX. This file is a working subset covering everything needed to author corporate decks. For the exhaustive spec, consult the upstream kimi-slides skill documentation if available.

## Contents

1. Project structure
2. Main file (.pptd)
3. Theme
4. Page files and element types
5. Shared types (Fill, Border, FontFamily, Alignment)
6. CLI reference

---

## 1. Project structure

```
project/
  deck.pptd           # main entry — required, everything loads through it
  pages/1_cover.page  # one .page per slide
  media/image1.png    # all local resources, inside the project folder
```

- Only relative paths, relative to the `.pptd` directory. Referencing files outside the project is forbidden.
- `Image.src` and image fills may be `https://` URLs (jpg/jpeg/png/gif only).
- Coordinates in px (1px = 1pt at 72 PPI), origin top-left. Recommended sizes: 16:9 → `[960, 540]` (or `[720, 405]` for compact decks); 4:3 → `[720, 540]`.

## 2. Main file (.pptd)

```yaml
version: v2            # required, fixed
title: My Deck
size: [720, 405]
customFonts:
  - family: Poppins
    src: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700"
theme:
  colors:
    primary: "#2563EB"
    bg: "#0E1245"
  textStyles:
    title:
      fontSize: 26
      color: "$primary"
      fontFamily: Poppins
      bold: true
    body:
      fontSize: 11
      color: "#C9CEEA"
      lineHeight: 1.35
pages:
  - pages/01_cover.page
  - pages/02_content.page
```

Theme references use `$token`: `$primary` in any color field, `$title` in a text `style:` field.

Fonts: Google Fonts via `https://fonts.googleapis.com/css2?family=...` URL, or system fonts (e.g. Arial) used directly without declaring. The `family` must match the font name exactly.

## 3. Page files (.page)

Every page is self-contained — no masters, no inheritance between pages:

```yaml
pageType: content
background:
  type: solid
  color: "$bg"
elements:
  - elementId: title          # unique per page
    elementType: text
    bounds: [56, 44, 620, 32] # [x, y, width, height]
    content:
      style: $title
      text: "Slide title"
      align: [left, middle]
```

Elements render in list order: later elements paint on top of earlier ones.

### Element types

**text**
```yaml
- elementId: body
  elementType: text
  bounds: [40, 100, 640, 60]
  content:
    text: "Plain text"          # or block scalar with <p>/<span style="...">/<strong> markup
    fontSize: 11
    fontFamily: Montserrat
    color: "$body"
    bold: false
    lineHeight: 1.35
    letterSpacing: 0
    align: [left, top]          # [horizontal, vertical]: left/center/right + top/middle/bottom
```
Rich text inside `text` supports `<p style="margin-top:2px">`, `<span style="color:$cyan; font-size:8px; letter-spacing:2px">`, `<strong>`, `<u>`, `<sup>`. Use a block scalar (`|`) whenever markup or colons appear.

**shape**
```yaml
- elementId: card
  elementType: shape
  bounds: [40, 130, 200, 118]
  shapeName: roundRect           # rect, roundRect, ellipse, ...
  adjustments: [10000]           # corner radius for roundRect
  fill: {type: solid, color: "$card"}
  border: {style: solid, width: 1, color: "$line"}
```

**icon** (Font Awesome)
```yaml
- elementId: icon
  elementType: icon
  bounds: [84, 142, 32, 32]
  iconName: "fas:shield-halved"  # fas:/far:/fab: prefixes
  fill: {type: solid, color: "$cyan"}
```

**image**
```yaml
- elementId: logo
  elementType: image
  bounds: [598, 18, 82, 23.8]
  src: media/logo.png
  fit: {mode: fill}              # fill | contain | cover
```

**line** (connectors/arrows)
```yaml
- elementId: arrow
  elementType: line
  bounds: [162, 188, 14, 1]
  viewBox: [14, 1]
  points: "0,0.5 14,0.5"
  curve: sharp
  arrow: [null, stealth]
  border: {style: solid, width: 1.5, color: "$cyan"}
```

**table** and **chart** exist with richer schemas; when needed, consult the full spec or build the visual from shapes+text instead (often more controllable for small decks).

## 4. Shared types

**Fill**
```yaml
fill: {type: solid, color: "#171C4E"}
fill:
  type: gradient
  gradientType: linear
  angle: 90                      # 0 = left→right, clockwise
  stops:
    - {position: 0, color: "$primary"}
    - {position: 1, color: "$accent"}
fill: {type: image, src: "media/bg.jpg", fit: {mode: cover}, opacity: 0.9}
```

**Border**: `{style: solid|dash|dot, width: 1, color: "#000000"}`. `border: null` clears inherited borders.

**Color**: HEX6 `#RRGGBB`, HEX8 with alpha, or `$themeToken`.

**FontFamily**: string (`"MiSans"`) or `{latin: "Arial", ea: "MiSans"}` to split Latin / East-Asian fonts.

**Shadow**: `{blur: 8, color: "#00000066", offset: [0, 2]}`.

**Style defaults** (when nothing sets them): color `#000000`, fontSize 18, fontFamily MiSans, lineHeight 1, align center/middle.

## 5. CLI reference

```bash
# PPTX -> PPTD project (extracts images to media/, rewrites paths)
kimi-slides convert path/deck.pptx -o path/output/

# Validate (input = directory containing the .pptd)
kimi-slides check path/deck                    # all pages
kimi-slides check path/deck -p 1,3 -s error    # subset of pages/severities
kimi-slides check path/deck --level keep       # check only, never modify (recommended)
kimi-slides check path/deck --level auto       # safe deterministic repairs

# Render pages to PNG for visual review
kimi-slides screenshot path/deck -o shots/
kimi-slides screenshot path/deck -p 2-6 -o shots/
```

`check` issue types: `YamlParseError`, `MissingField`, `InvalidType`, `OutOfRange`, `InvalidTheme` (unknown `$token`), `PageNotFound`, `UnknownField`, `BoundsOutside`, `SrcNotFound`, `TextOverflow`, `TextUnderFill`, `TextOcclusion`, `TextDrift`.

Interpretation guidance:

- Text checks are heuristic mock-measurements — confirm against the screenshot before acting.
- `BoundsOutside` and `TextOcclusion` may be intentional design (bleed, deliberate overlap); ignore only when deliberate.
- Everything else: fix and re-run until zero errors.

Screenshot rendering is simulated; the editor is the ground truth, but screenshots catch 95% of layout problems (overflow, overlap, contrast, misalignment).
