---
name: office-docs
description: Create, edit and fill Word documents and Excel workbooks using the department's corporate templates as the base, so styles, logos, headers and chart formatting match the rest of the department's output. Use whenever the user asks for an acta de reunión, a procedimiento, project documentation, a deliverable document, a report, a spreadsheet, or any .docx/.xlsx work that should look like corporate material. Triggers include "acta", "procedimiento", "documentación del proyecto", "plantilla corporate", "informe", "plantilla de Excel", "gráficos corporate", "docx", "xlsx".
---

# corporate Office documents

Four department templates ship with this skill. Start from one instead of
imitating one — the styles, logos, header bands and page setup are already in
there and are the thing being asked for.

| Template key       | File                        | For |
| ------------------ | --------------------------- | --- |
| `acta`             | `assets/templates/acta-reunion.dotx`     | Meeting minutes: who convened, who attended, agenda, per-point development, agreements |
| `procedimiento`    | `assets/templates/procedimiento.dotx`    | Step-by-step procedures, SOPs, runbooks |
| `documentacion`    | `assets/templates/documentacion-proyecto.dotx` | Project deliverables; this one carries the logo header |
| `graficos`        | `assets/templates/chart-workbook.xlsx`    | Charts and KPI workbooks; four sheet recipes, all already themed |

The spreadsheet carries the corporate palette — `dk1 #0E1245`, `dk2 #61CAFE`,
`accent1 #FF5C5C`, the same tokens the PPT template uses.

**The three Word templates do not.** All three sit on the stock Office theme
(`dk1 #0E2841`, `accent1 #156082`), so a document built from them will not
match a slide or a chart from this kit. What they *do* carry is the structure
corporate actually works in: heading hierarchy, section names, table shapes, the
`documentacion` logo header. Treat them as the right skeleton, and if the
colour has to match, pull the tokens from `graficos` and apply them per element
rather than expecting the theme to do it.

## Before writing anything

**Read the template first.** Filling a table means knowing its real row count and
header; adding a chart means knowing which sheets already have one.

```bash
python3 scripts/describe_template.py acta          # headings, tables, page setup
python3 scripts/describe_template.py graficos      # sheets, charts, active sheet
python3 scripts/describe_template.py --theme graficos   # palette only
```

Guessing the layout from the file name gets the table shapes wrong, and these
templates do not agree with each other: `acta` titles with a `Titulo` style,
`procedimiento` leaves its title as a bold `Normal` paragraph.

## Creating

```bash
python3 scripts/new_from_template.py acta informe.docx
python3 scripts/new_from_template.py procedimiento proc.docx --title "Alta de proveedores"
python3 scripts/new_from_template.py graficos seguimiento.xlsx --sheet "Progreso circular"
```

Any output path works; the script creates parent directories.

Pass `--title` and `--subtitle` rather than setting them yourself. The deliverable
name lives in four places — the cover title, the running header and the footer
repeat it — and none of them are ordinary body paragraphs. `apply_cover_text`
in `scripts/office.py` rewrites all of them in one pass and is the only
practical way in: the cover title is a text-box shape, and the templates break
`[Nombre del entregable]` across four runs inside one tab-separated paragraph.
A paragraph-level or run-level edit leaves `Nombre del entregable` stamped on
every page.

The script also strips the template's sample prose on the way out — and the
templates carry several placeholder traditions, not just Lorem ipsum:
`consectetuer`, `Pellentesque habitant`, `Suspendisse dui purus`,
`Subapartado N`, the `Apartado 1..4` sample headings and empty headings. All of
it goes, leaving the front matter (change log, index, acronyms) and its styles.

A document from `new_from_template.py` is an empty shell by design: cover,
header, footer and structure, no content. Fill the body with `python-docx` and
insert tables in flow — `Document.add_table` appends at the end of the body, so
a table moved by hand with `_element` ends up after the last section instead of
under the one it belongs to. That text lives in body paragraphs
*and* inside table cells, so pass it as-is and let the script remove it;
`--keep-filler` keeps it if you are inspecting the template.

## Filling the body

`new_from_template.py` produces the shell — cover, header, footer, styles, front
matter — and nothing else. Write the content with `fill_document.py` from a JSON
outline rather than by hand:

```bash
python3 scripts/fill_document.py informe.docx outline.json
```

```json
{"front": {"change_log": {"date": "06/10/2026", "by": "Consultor corporate",
                          "reviewed_by": "Revisor corporate", "approved_by": "Director corporate"},
           "acronyms": [["IA", "Inteligencia Artificial"]]},
 "sections": [
   {"heading": "Introduccion", "paragraphs": ["En 2026, la IA se ha consolidado..."]},
   {"heading": "Retos", "bullets": ["La regulacion de los datos"],
    "paragraphs": ["Ambos condicionan el ritmo de despliegue."]},
   {"heading": "Sectores", "paragraphs": ["Finanzas y Salud lideran la adopcion."],
    "table": {"caption": "Tabla 1: Adopcion por sector",
              "header": ["Sector", "Tasa (%)"],
              "rows": [["Finanzas y Seguros", "85%"]]}}]}
```

It handles the three things that go wrong when done by hand: the template's own
sample sections are removed first, headings get bare text because the style
numbers them itself, and tables are inserted in flow rather than appended after
the last section.

## Headings are numbered for you

`Heading 1` and `Heading 2` carry automatic numbering from the template's
numbering definition. Writing `"1. Introducción"` into one renders as
**"1. 1. Introducción"**. Put the bare text in the heading and let the template
number it.

The table of contents is a Word field with a cached result. The cache still
lists the old placeholder headings until someone refreshes it in Word
(`Ctrl+A`, `F9`); say so rather than trying to compute it in python-docx.

## The .dotx wrinkle

Word templates declare a *template* content type and python-docx refuses them
outright. `new_from_template.py` rewrites that one string in
`[Content_Types].xml` on the way out, so you get a `.docx` with the template's
theme, styles, header/footer parts and embedded logos intact. The bundled
templates are never modified — the conversion happens on the copy. If you need
to do it by hand, import `dotx_to_docx` from `scripts/office.py`.

## Working on an existing document

Same tools, different path. `describe_template.py` takes any `.docx` or
`.dotx`, not just the bundled ones:

```bash
python3 scripts/describe_template.py ~/otro/informe.docx
```

Then edit with `python-docx` (`Document`, `paragraphs`, `tables`, `sections`)
or `openpyxl` (`load_workbook`, `active`, `save`). Both are installed.

Fill tables by index, never by assuming a fixed row count:

```python
from docx import Document
doc = Document("informe.docx")
tabla = doc.tables[0]
fila = tabla.add_row().cells          # append; existing rows keep their data
fila.cells[0].text = "2026-10-06"
doc.save("informe.docx")
```

## Building a workbook

`new_from_template.py graficos` copies the workbook; `fill_workbook.py` makes it
yours. A spec may add new sheets with corporate styling, fill the template's ready
charts, or both in one pass:

```bash
python3 scripts/fill_workbook.py salida.xlsx spec.json
```

```json
{"chart_sheets": [
   {"sheet": "Barras por segmento",
    "categories": ["Finanzas", "Salud", "Retail", "Manufactura"],
    "series": [{"name": "2024", "values": [0.50, 0.45, 0.40, 0.35]},
               {"name": "2026", "values": [0.85, 0.78, 0.70, 0.65]}],
    "drop_others": true}],
 "sheets": [
   {"name": "Resumen",
    "columns": ["Sector", "Adopción (%)", "Inversión 2026 (M€)"],
    "rows": [["Finanzas y Seguros", 0.85, 1200],
             ["Salud", 0.78, 950]]}]}
```

New sheets get the department palette from the template's own tokens — navy
`#0E1245` header band in white bold, banded rows, sized columns, frozen header —
so they match the charts without any manual formatting. Columns whose header
mentions `%` are formatted as percentages. `drop_others` removes the chart
sheets you did not ask for, which is how a delivered workbook stops carrying
three sheets of sample data.

## Charts

`assets/templates/chart-workbook.xlsx` has four worked sheets that are already themed:
`Gráfico de barras agrupadas`, `Barras por segmento`, `Progreso circular`,
`Gráfico de anillo`. Copy the relevant one rather than building a chart from
scratch — the formatting is the point.

**Every chart reads a fixed block of cells, and that block's shape has nothing
to do with the shape of a table of your data.** Writing your numbers anywhere
else leaves the chart plotting the template's sample series — `Lorem ipsum`,
`Jan`…`Dec` — which reads as real data and is worse than an empty chart.

```bash
python3 scripts/chart_data.py describe        # every chart, its ranges and its shape
python3 scripts/chart_data.py describe libro.xlsx
```

```
=== Gráfico de barras agrupadas
  Bar
    categories  B7:M7  (horizontal)
    values      B8:M8  (horizontal)
    shape       1 serie(s) x 12 categorias
    ahora       ['Jan', 'Feb', ... 'Dec']
```

Pick the sheet whose shape fits the data, then write into it with `set`:

```bash
python3 scripts/chart_data.py set salida.xlsx "Gráfico de barras agrupadas" datos.json
```

```json
{"categories": ["Ene", "Feb", "Mar"],
 "series": [{"name": "Adopción IA", "values": [0.50, 0.62, 0.74]}]}
```

`set` writes into the exact ranges the chart reads, clears the sample labels
beside them (`Name`, `Date`, `Lorem ipsum`), and **refuses** data of the wrong
length instead of truncating it — a chart with three bars when the block holds
twelve would otherwise silently mislead. Choose a different sheet, or rebuild
the block, rather than forcing it.

openpyxl reads charts but does not create them. For a chart type that does not
exist here, copy a sheet that already has one and repoint its ranges, or build
it in LibreOffice headless and let it write the XML — `soffice` is installed.

## Delivering

- Deliver the `.docx` or `.xlsx`, never a rendered PDF, unless asked.
- Say which template it came from.
- If you changed the structure of a template, say so; the next person inherits it.
- For a document meant to be printed or circulated, open it once with
  `soffice --headless --convert-to pdf` to confirm it is not broken — that is
  the only check that catches a table that overflows the page.