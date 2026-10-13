---
name: office-docs
description: Build corporate Word documents and Excel workbooks from the department templates, preserving the corporate styles, section structure, numbering and table shapes. Use for actas, procedimientos, project documentation, reports, deliverables, .docx and .xlsx work in the company's style, and for filling the department's themed charts. Triggers include acta, procedimiento, documentación del proyecto, plantilla corporate, informe, docx, xlsx, gráficos corporate. Exception: when the user hands an existing file as the base or the style source (a path, "desde este documento", "con el estilo de este"), do NOT use these templates — that is office-style-transfer, even if the result is an acta or mentions corporate; the bundled templates apply only when the user gives no reference file.
---

# corporate Office documents

Everything is done with `officecli`, the Office engine bundled at
`bundle/vendor/officecli/`. It reads, queries and writes `.docx`, `.xlsx` and
`.pptx` by selector, validates against the OpenXML schema, and recalculates
derived fields.

```bash
officecli get     informe.docx /                        # structure
officecli query   informe.docx 'p[style=Ttulo1]'          # CSS-like selectors
officecli set     informe.docx /body/p[10] --prop text="..."
officecli batch   informe.docx --commands '[...]'        # several edits, one pass
officecli validate informe.docx
officecli refresh informe.docx                           # recalculated fields
officecli import  datos.xlsx /sheet --csv datos.csv
```

## Start from a template, always

The department's templates are real Office files: the styles, logos, header
bands and page setup are the thing being asked for.

| key | file | for |
| --- | --- | --- |
| `acta` | `assets/templates/acta-reunion.dotx` | meeting minutes |
| `procedimiento` | `assets/templates/procedimiento.dotx` | SOPs, runbooks |
| `documentacion` | `assets/templates/documentacion-proyecto.dotx` | project deliverables, carries the logo header |
| `graficos` | `assets/templates/chart-workbook.xlsx` | charts, four themed sheet recipes |

The `.dotx` wrinkle: Word templates declare a *template* content type and
`python-docx` refuses them outright. Rewriting that one string in
`[Content_Types].xml` turns the copy into a `.docx` with the theme, styles,
header/footer parts and logos intact.

## Headings are numbered by the template

`Ttulo1`, `Ttulo2`… carry automatic numbering. Writing `"1. Introducción"`
renders as **`1. 1. Introducción`**. Put the bare text in the heading.

And `style` is the OOXML **styleId**, not the display name:

| you pass | what happens |
| --- | --- |
| `"Heading 1"` (the name) | a reference Word cannot resolve |
| `Heading1` | officecli **injects Word's own built-in heading**, dropping the corporate typeface and numbering |
| `Ttulo1` | correct: renders as `1. Introducción`, numbered by the template |

The templates' style ids are Spanish: `Ttulo1`…`Ttulo9`, `TtuloTDC`,
`Titulosdetablas`, `Titulofiguras`, `Cita`, `Normal`. Read them from the file
rather than guessing: `officecli get doc.docx /styles`.

## Table captions

A caption uses the `Titulosdetablas` style and belongs **immediately after** its
table, with the two kept together. A caption left on its own page reads as a
stray label — that is the commonest defect in these documents:

```
[Normal            ] TABLA DE ACRÓNIMOS
[Titulos de tablas ] Tabla 1          <- orphan: the table is a page earlier
```

Put the caption directly after the table's last row, and if it must not break,
set `keepNext` on it. Never leave a caption whose table you removed.

## The table of contents

`officecli refresh` recalculates **page numbers**. It does **not** rebuild the
entries: a document whose body headings were rewritten keeps listing the old
ones (`Subapartado 1`, `Apartado 1…4`) until the field is rebuilt.

```bash
officecli refresh informe.docx        # page numbers, via its HTML backend
```

To rebuild, remove the stale `toc` and add a fresh one (`officecli query
doc.docx 'toc'` lists them; `/toc[1]` is LISTA DE FIGURAS, `/toc[2]` LISTA DE
TABLAS). Say in the delivery that the index needs a refresh in Word — `Ctrl+A`,
`F9` — because the cached entries only recompute there.

## Remove the sample content

The templates ship placeholder prose and headings, and leaving them in reads as
finished work: `Lorem ipsum`, `consectetuer`, `Pellentesque habitant`,
`Suspendisse dui purus`, `Subapartado N`, `Apartado 1..4`, empty headings, and
the bracketed `[Nombre del entregable]` on the cover, header and footer. All of
it must go, including the sample prose hidden inside table cells.

```bash
officecli query informe.docx 'p[text~=Lorem]'     # find what is there
officecli batch informe.docx --commands '[{"command":"remove","path":"/body/p[12]"}]'
```

## Excel

### The charts read fixed blocks

`assets/templates/chart-workbook.xlsx` has four themed sheets. Each chart plots a fixed
range whose shape has nothing to do with a table of your data, so writing the
numbers elsewhere leaves the chart plotting the template's sample series
(`Lorem ipsum`, `Jan`…`Dec`) — which reads as real data and is worse than an
empty chart.

| sheet | categories | series |
| --- | --- | --- |
| `Gráfico de barras agrupadas` | `B7:M7` | `B8:M8` — one series, twelve periods |
| `Barras por segmento` | `D10:G10` | `D11:G13` — three series, four categories |
| `Progreso circular` | — | four donuts, two values each (`G17:G18`, `J17:J18`, …) |
| `Gráfico de anillo` | `B14:B17` | `C14:C17` |

A sector-by-year table is four categories × three series, so it belongs in
`Barras por segmento`, not in `Gráfico de barras agrupadas`. The templates also
carry decoy blocks in columns no chart reads — cells of `Name`, `Date` and month
names with sample numbers under them — which are invisible to the chart and
obvious to whoever opens the file.

### New sheets

For a sheet that does not exist, use the palette the template's own theme
carries rather than copying a sheet: navy `#0E1245` header band in white bold,
banded rows, sized columns, frozen header. Do not add rows into a chart's range
or move its XML by hand — write into the range the chart reads, or build a plain
sheet and let the template's styling do the rest.

## Delivering

- Deliver the `.docx` or `.xlsx`, never a rendered PDF, unless asked.
- Say which template it came from.
- Open it once with `soffice --headless --convert-to pdf` before delivering: that
  is the only check that catches a caption stranded on its own page or a table
  that overflows.
- For a Word file, say the index needs `Ctrl+A`, `F9`.
- Under WSL, save the deliverable on the Windows filesystem — normally the
  user's Windows Downloads (`/mnt/c/Users/<user>/Downloads`; the session
  context's `<windows_paths>` block names the exact user) — so the user can
  review it in Windows.