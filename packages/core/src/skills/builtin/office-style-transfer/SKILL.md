---
name: office-style-transfer
description: Generate a PPTX, DOCX or XLSX that looks like it was made with the same template the user hands you — reusing that file's theme, fonts, colours, layouts, styles and decorative art, and never rebuilding from scratch. Use when the user provides an existing Office file (a .pptx, .docx or .xlsx, often a .potx/.dotx/.xltx template renamed, or a file from a network share) as the style reference for a new deck, document or spreadsheet, or asks to "generate a presentation/document/excel with the same style/look/branding as this one".
---

# Office style transfer

## The one rule that matters

**The reference file is both your template and your output. Copy it, then edit
it in place. Never create a new document "with the same styles".**

A template's look is not only its theme: it is the decorative art drawn *on each
slide or in the header*, the placeholder geometry the layout inherits, the exact
paragraph spacing of each style, and the content controls that hold the sample
words. A document rebuilt "with the right fonts" reproduces none of that — it
comes out with the right colours on the wrong shapes. Measured on the reference
deck this skill was calibrated against:

| | the reference file | a file rebuilt from its styles |
| --- | --- | --- |
| shapes per slide | 7 — art, title, body, quote | 2 — title, body |
| decorative art | 2 pictures per slide | none |
| validate errors | 4 pre-existing | 0, but the design is gone |

```bash
cp "$REFERENCE" out.pptx          # .potx → .pptx, .dotx → .docx, .xltx → .xlsx
officecli close out.pptx          # release any resident before editing
```

## Read the whole file before writing a word

`extract_style.py` reads the file once — geometry straight out of the package
(where officecli does not resolve a placeholder's inherited box), text from the
XML (where officecli reports a Word content control as empty), and capacity
measured with the same font metrics the overlap gate will judge the result by —
and writes a pruned blueprint plus a short summary:

```bash
python3 scripts/extract_style.py out.pptx -o style.json
```

```
out.pptx · pptx · 4 slides 11.0x8.5in
theme: Custom 5 · headings Century Gothic · body Gill Sans MT · accent1 #82B1E4
slide 1 [5_Diapositiva de título] 8 shapes
    title        40pt  11x2=  22 car | ahora   16 | @7.57,5.67in | 'TAILWIND TRADERS'
    body         11pt  42x13= 546 car | ahora  353 | @0.25,4.47in | 'Lorem ipsum dolor sit amet…'
```

Each text shape reports its **capacity** — characters per line × lines the box
is tall enough to show, taken from the box's real geometry and font. Write to
that budget and the first render is already clean. A cover title that fits 11
characters per line and two lines cannot hold a 24-character title at 40pt; that
is the whole defect, visible before a word is written.

## PPTX: clone the slide you need, never build one

A slide created `--prop layout=...` from a layout is an empty shell: the
reference deck's slides each carry pictures and panels **on the slide itself**,
which the layout never materialises. Clone instead — the copy travels with its
art, colours and placeholder rules byte for byte:

```bash
python3 scripts/clone_slide.py out.pptx 2 --at 5   # clone slide 2 into position 5
```

Prune the slides you do not need **after** cloning, in descending index order so
the earlier indices stay valid:

```bash
officecli batch out.pptx --commands '[
  {"command":"remove","path":"/slide[6]"},
  {"command":"remove","path":"/slide[4]"}]'
officecli close out.pptx
```

Write every text in one batch — one round trip, atomic:

```bash
officecli batch out.pptx --commands '[
  {"command":"set","path":"/slide[1]/shape[@id=2]","props":{"text":"TAILWIND TRADERS"}},
  {"command":"set","path":"/slide[2]/shape[@id=86]","props":{"text":"Objetivos 2027"}}]'
officecli close out.pptx
```

`\n` in a `text` prop starts a new paragraph; keep each line within
`chars_per_line` and the whole block within `max_chars`.

### The three gates — run all three, in this order

```bash
python3 scripts/check_overlaps.py out.pptx        # exit 0 = no overlap, no overflow
officecli validate out.pptx                        # exit 0 = package is sound
soffice --headless --convert-to pdf --outdir render out.pptx
pdftoppm -png -r 55 render/out.pdf render/p       # then LOOK at every page
```

The geometric gate catches what the eye misses — a 6pt collision at the far edge
of a wide slide is invisible in a 55dpi thumbnail and fatal in print. It
resolves inherited placeholder geometry, measures line boxes (not shape
bounding boxes), and applies overlap thresholds relative to each line's own size
— so an 11pt caption is judged as strictly as a 40pt title.

The render catches what the gate cannot: a paragraph whose bullet list the
template styled as prose, or a text that fits its box but covers the logo.
**Read every page.** Both were found that way on the reference deck.

## DOCX: write into the content control, not the paragraph

Word templates put their sample text inside **content controls** (`<w:sdt>` — the
grey placeholder a user clicks to type over). A `set --prop text` on the
paragraph itself lands in a stray run *beside* the control and leaves the
template's words on the page. The blueprint lists each control's path:

```json
{"path": "/body/p[@paraId=5897F7F7]", "style": "Heading1",
 "controls": [{"path": "/body/p[@paraId=5897F7F7]/sdt[@sdtId=-1634780686]",
               "text": "MARKETING & SALES TEAM"}]}
```

Write to `controls[0].path`. **A paragraph can hold several controls** — a
Mad-Libs sentence is often four or five of them ("Facilitator Name" … "called to
order the regular meeting of the" … "Marketing & sales team" … "at" … "date").
Set the first to your full sentence and remove the rest, or the template's
English survives next to yours:

```bash
officecli batch out.docx --commands '[
  {"command":"set","path":"/body/p[@paraId=20AE0895]/sdt[@sdtId=1807509488]",
   "props":{"text":"Ana Ruiz abrió la sesión a las 10:00."}},
  {"command":"remove","path":"/body/p[@paraId=20AE0895]/sdt[@sdtId=-929966237]"},
  {"command":"remove","path":"/body/p[@paraId=20AE0895]/sdt[@sdtId=-1717117452]"}]'
officecli close out.docx
```

Numbered sections renumber themselves: removing a `ListNumber` item shifts every
Roman numeral after it, and adding one continues the sequence. The styles
carrying the look — `Heading1` 26pt #000942 bold, `Subheading` 16pt,
`ListNumber` upperRoman, `ListNumber2` lowerLetter — are named in the blueprint;
write with `--prop style=<styleId>` and nothing else.

After editing, confirm the sample text is gone from the **rendered** page, not
just the XML — search the PDF text for every distinctive phrase the template
carried ("Facilitator", "Lorem", the sample company name) with entity decoding
on, because `&amp;` hides a match from a naive search:

```bash
python3 -c "
import zipfile, re, html
raw = zipfile.ZipFile('out.docx').read('word/document.xml').decode('utf8')
text = html.unescape(' '.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', raw)))
print([p for p in ('Facilitator','Lorem','Marketing & sales') if p.lower() in text.lower()])"
```

A stray `.` or ` ` at the end of a rewritten sentence is punctuation sitting in a
run outside the control. Reword to consume it, or remove the run.

## XLSX: keep the theme, tab colours and formats

The blueprint lists every sheet with its tab colour, freeze state, merge count,
the first three rows of values, and one representative cell per distinct visual
style (font, fill, number format, alignment, border). Copy the file, keep the
sheets you need, delete the rest, and write values with `officecli set` — the
formats are already on the cells:

```bash
officecli set out.xlsx "/Hoja1/B2" --prop value="4.2"
```

Do not recreate a formatted table cell by cell: the reference file's formats are
already correct on every cell you keep.

## Templates that are really templates (.potx, .dotx, .xltx)

An Office template carries the same XML under a different content type and
extension. Copy it and rename to the working extension — nothing else changes:

| given | working copy |
| --- | --- |
| `X.potx` | `cp X.potx out.pptx` |
| `X.dotx` | `cp X.dotx out.docx` |
| `X.xltx` | `cp X.xltx out.xlsx` |

`officecli validate` confirms the result opens as a document, not a template.

## Ordering that matters

1. `cp` the reference file to the working name.
2. **`officecli close`** it — a resident that survives your external edits will
   flush its stale copy over them when it next goes idle (this happened: a
   `remove` followed by a `clone_slide.py` call lost the clone).
3. `extract_style.py` — read before writing.
4. `clone_slide.py` / structural edits — anything touching the package goes
   before officecli edits, for the same reason.
5. `officecli batch` — all text in one pass.
6. `officecli close` — flush before anything else reads the file.
7. The three gates, then **look at every rendered page**.
