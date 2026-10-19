#!/usr/bin/env python3
"""Build the neutral templates that ship with the office skills.

Run from anywhere:  python3 scripts/build-neutral-templates.py

Requires python-pptx and python-docx (pip install python-pptx python-docx).
Outputs, both validated with the vendored officecli and rendered with
LibreOffice during development:

  packages/core/src/skills/builtin/pptd-slides/assets/templates/neutral-deck.pptx
  packages/core/src/skills/builtin/office-docs/assets/templates/neutral-document.docx

Design goals: neutral (no brand), licence-clean (no third-party assets), and
built so the skills have something real to work against — chrome drawn on every
slide (breadcrumb, footer, page number) rather than inherited from a layout, no
autofit, a native chart, a styled table, and an end card that must stay last.

Two OpenXML traps this script already handles, because the schema rejects them
and PowerPoint only tolerates the first:

  * python-pptx draws chart axis ids from a signed range and the schema wants
    UInt32; the ids are cross-references, so each distinct value must map to a
    single replacement (see fix_chart_axis_ids);
  * inside w:tcPr the border block must precede w:shd, and inside w:tcBorders
    the edges must be written top, left, bottom, right.
"""
import pathlib
import re
import shutil
import zipfile

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

OUT = pathlib.Path(__file__).resolve().parents[1] / 'packages/core/src/skills/builtin'

# ------------------------------------------------------------------ palette
INK = RGBColor(0x16, 0x21, 0x2B)
BODY = RGBColor(0x3E, 0x4C, 0x59)
MUTED = RGBColor(0x7B, 0x87, 0x94)
RULE = RGBColor(0xD3, 0xD9, 0xE0)
SURFACE = RGBColor(0xF4, 0xF6, 0xF8)
ACCENT = RGBColor(0x2E, 0x6B, 0xE6)
ACCENT_2 = RGBColor(0x12, 0xA5, 0x94)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

FONT = 'Calibri'
W, H = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.9)
TITLE_TOP = Inches(0.72)
CONTENT_TOP = Inches(1.85)

PROJECT = 'Project name'
BREADCRUMB = 'Programme · Area · Call'
FOOTER = 'Confidential — internal draft'


def textbox(slide, x, y, w, h, *, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(x, y, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return box, tf


def write(tf, text, *, size, color, bold=False, italic=False, first=False,
          space_after=0, space_before=0, align=PP_ALIGN.LEFT, line=None):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_after = Pt(space_after)
    p.space_before = Pt(space_before)
    if line:
        p.line_spacing = line
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = color
    run.font.name = FONT
    return p


def rect(slide, x, y, w, h, *, fill=None, line=None, shape=MSO_SHAPE.RECTANGLE,
         radius=None):
    s = slide.shapes.add_shape(shape, x, y, w, h)
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(0.75)
    s.shadow.inherit = False
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = radius
    s.text_frame.text = ''
    return s


def slide(prs, *, background=None):
    s = prs.slides.add_slide(prs.slide_layouts[6])  # blank
    if background is not None:
        rect(s, 0, 0, W, H, fill=background)
    return s


def chrome(s, page, *, title=None, eyebrow=None):
    """Breadcrumb, footer and page number live on the slide, never inherited."""
    _, tf = textbox(s, MARGIN, Inches(0.3), Inches(7), Inches(0.3))
    write(tf, BREADCRUMB, size=10, color=MUTED, first=True)
    _, tf = textbox(s, W - MARGIN - Inches(1.2), Inches(0.3), Inches(1.2), Inches(0.3))
    write(tf, PROJECT, size=10, color=MUTED, first=True, align=PP_ALIGN.RIGHT)
    _, tf = textbox(s, MARGIN, H - Inches(0.55), Inches(8), Inches(0.3))
    write(tf, FOOTER, size=9, color=MUTED, first=True)
    _, tf = textbox(s, W - MARGIN - Inches(1), H - Inches(0.55), Inches(1), Inches(0.3))
    write(tf, str(page), size=9, color=MUTED, first=True, align=PP_ALIGN.RIGHT)
    if eyebrow:
        _, tf = textbox(s, MARGIN, TITLE_TOP, Inches(9), Inches(0.3))
        write(tf, eyebrow.upper(), size=11, color=ACCENT, bold=True, first=True)
    if title:
        _, tf = textbox(s, MARGIN, TITLE_TOP + (Inches(0.32) if eyebrow else 0),
                        W - 2 * MARGIN, Inches(0.7))
        write(tf, title, size=26, color=INK, bold=True, first=True)
        rect(s, MARGIN, TITLE_TOP + (Inches(1.02) if eyebrow else Inches(0.7)),
             Inches(1.1), Pt(3), fill=ACCENT)


def bullet_list(tf, items, *, size=16, sub_size=14):
    first = True
    for item, subs in items:
        p = write(tf, f'•  {item}', size=size, color=BODY, first=first,
                  space_after=6, line=1.15)
        p.level = 0
        first = False
        for sub in subs:
            write(tf, f'–  {sub}', size=sub_size, color=MUTED, space_after=4,
                  line=1.15).level = 1


def fix_chart_axis_ids(path: pathlib.Path) -> None:
    """python-pptx draws axis ids from a signed range; OpenXML wants UInt32.

    The ids are cross-references, so each distinct original value must map to a
    single replacement or the chart ends up pointing at an axis that is not
    there.
    """
    tmp = path.with_suffix('.tmp')
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename.startswith('ppt/charts/chart') and item.filename.endswith('.xml'):
                text = data.decode('utf-8')
                mapping: dict[str, str] = {}

                def positive(match: re.Match) -> str:
                    original = match.group(2)
                    if original not in mapping:
                        mapping[original] = str(100000000 + len(mapping) + 1)
                    return f'{match.group(1)} val="{mapping[original]}"'

                text = re.sub(
                    r'(<(?:c:)?(?:axId|crossAx)) val="(-?\d+)"', positive, text
                )
                data = text.encode('utf-8')
            dst.writestr(item, data)
    shutil.move(str(tmp), str(path))


def build_deck() -> pathlib.Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H

    # 1 — cover
    s = slide(prs)
    rect(s, 0, 0, Inches(0.18), H, fill=ACCENT)
    _, tf = textbox(s, MARGIN, Inches(1.7), Inches(9), Inches(0.4))
    write(tf, 'PROJECT DELIVERABLE', size=12, color=ACCENT, bold=True, first=True)
    _, tf = textbox(s, MARGIN, Inches(2.2), Inches(10.5), Inches(1.8))
    write(tf, 'Title of the presentation', size=40, color=INK, bold=True, first=True,
          line=1.05)
    _, tf = textbox(s, MARGIN, Inches(4.05), Inches(9.5), Inches(0.9))
    write(tf, 'One line that says what this deck answers, in plain language.',
          size=18, color=BODY, first=True, line=1.2)
    rect(s, MARGIN, Inches(5.35), Inches(1.6), Pt(3), fill=ACCENT)
    _, tf = textbox(s, MARGIN, Inches(5.65), Inches(9), Inches(0.5))
    write(tf, 'Author · Team          Date          v1.0', size=12, color=MUTED,
          first=True)
    rect(s, 0, H - Inches(0.9), W, Inches(0.9), fill=SURFACE)
    _, tf = textbox(s, MARGIN, H - Inches(0.62), Inches(10), Inches(0.3))
    write(tf, BREADCRUMB, size=10, color=MUTED, first=True)
    _, tf = textbox(s, W - MARGIN - Inches(1), H - Inches(0.62), Inches(1), Inches(0.3))
    write(tf, '1', size=9, color=MUTED, first=True, align=PP_ALIGN.RIGHT)

    # 2 — agenda
    s = slide(prs)
    chrome(s, 2, eyebrow='Contents', title='Agenda')
    items = ['Context and objective', 'What we propose', 'How it works',
             'Results so far', 'Plan and next steps']
    col_w = (W - 2 * MARGIN - Inches(0.6)) / 2
    for i, item in enumerate(items):
        col, row = divmod(i, 3)
        x = MARGIN + col * (col_w + Inches(0.6))
        y = CONTENT_TOP + row * Inches(1.15)
        rect(s, x, y, Inches(0.42), Inches(0.42), fill=SURFACE,
             shape=MSO_SHAPE.OVAL)
        _, tf = textbox(s, x, y + Inches(0.06), Inches(0.42), Inches(0.3))
        write(tf, str(i + 1), size=13, color=ACCENT, bold=True, first=True,
              align=PP_ALIGN.CENTER)
        _, tf = textbox(s, x + Inches(0.65), y + Inches(0.04), col_w - Inches(0.7),
                        Inches(0.6))
        write(tf, item, size=16, color=INK, first=True)
        _, tf = textbox(s, x + Inches(0.65), y + Inches(0.42), col_w - Inches(0.7),
                        Inches(0.5))
        write(tf, 'One sentence about this section.', size=12, color=MUTED, first=True)

    # 3 — section divider
    s = slide(prs)
    rect(s, 0, 0, Inches(0.18), H, fill=ACCENT)
    _, tf = textbox(s, MARGIN, Inches(2.4), Inches(2), Inches(1))
    write(tf, '01', size=54, color=RULE, bold=True, first=True)
    _, tf = textbox(s, MARGIN, Inches(3.35), Inches(9), Inches(1))
    write(tf, 'Context and objective', size=34, color=INK, bold=True, first=True)
    _, tf = textbox(s, MARGIN, Inches(4.35), Inches(8.5), Inches(0.8))
    write(tf, 'What the situation is, and what this section has to answer.',
          size=16, color=BODY, first=True, line=1.2)
    _, tf = textbox(s, MARGIN, H - Inches(0.55), Inches(8), Inches(0.3))
    write(tf, FOOTER, size=9, color=MUTED, first=True)
    _, tf = textbox(s, W - MARGIN - Inches(1), H - Inches(0.55), Inches(1), Inches(0.3))
    write(tf, '3', size=9, color=MUTED, first=True, align=PP_ALIGN.RIGHT)

    # 4 — two columns
    s = slide(prs)
    chrome(s, 4, eyebrow='Context', title='Two ideas, side by side')
    for i, (head, body) in enumerate([
        ('Where we start', 'Two or three sentences of context. Keep the '
         'paragraph to the width of the column and let the second one carry the '
         'counterpart.'),
        ('What it means', 'The consequence of the first column, stated plainly. '
         'A reader should be able to stop here and still follow the argument.'),
    ]):
        x = MARGIN + i * (col_w + Inches(0.6))
        rect(s, x, CONTENT_TOP, col_w, Pt(2), fill=ACCENT_2 if i else ACCENT)
        _, tf = textbox(s, x, CONTENT_TOP + Inches(0.25), col_w, Inches(0.5))
        write(tf, head, size=18, color=INK, bold=True, first=True)
        _, tf = textbox(s, x, CONTENT_TOP + Inches(0.85), col_w, Inches(2.6))
        write(tf, body, size=15, color=BODY, first=True, line=1.25)

    # 5 — three cards
    s = slide(prs)
    chrome(s, 5, eyebrow='Proposal', title='Three parts of the answer')
    card_w = (W - 2 * MARGIN - 2 * Inches(0.4)) / 3
    for i, (head, body) in enumerate([
        ('First', 'What it is, in one clause that fits the card.'),
        ('Second', 'The middle part, with its own one-clause description.'),
        ('Third', 'The closing part of the answer.'),
    ]):
        x = MARGIN + i * (card_w + Inches(0.4))
        rect(s, x, CONTENT_TOP, card_w, Inches(3.4), fill=SURFACE,
             shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.04)
        rect(s, x, CONTENT_TOP, card_w, Pt(3), fill=ACCENT)
        _, tf = textbox(s, x + Inches(0.35), CONTENT_TOP + Inches(0.45),
                        card_w - Inches(0.7), Inches(0.4))
        write(tf, head, size=16, color=INK, bold=True, first=True)
        _, tf = textbox(s, x + Inches(0.35), CONTENT_TOP + Inches(0.95),
                        card_w - Inches(0.7), Inches(2.2))
        write(tf, body, size=13, color=BODY, first=True, line=1.25)

    # 6 — bullets
    s = slide(prs)
    chrome(s, 6, eyebrow='How it works', title='What happens, step by step')
    _, tf = textbox(s, MARGIN, CONTENT_TOP, Inches(7.2), Inches(4.2))
    bullet_list(tf, [
        ('First step, stated as an action.', ['A detail that belongs to it.']),
        ('Second step, with its own outcome.', []),
        ('Third step, and what it produces.',
         ['One clarification, if the reader needs it.']),
        ('What is explicitly out of scope.', []),
    ])
    rect(s, MARGIN + Inches(7.6), CONTENT_TOP, Inches(3.9), Inches(3.9), fill=SURFACE,
         shape=MSO_SHAPE.ROUNDED_RECTANGLE, radius=0.03)
    _, tf = textbox(s, MARGIN + Inches(8.0), CONTENT_TOP + Inches(0.4),
                    Inches(3.1), Inches(0.4))
    write(tf, 'Note', size=13, color=ACCENT, bold=True, first=True)
    _, tf = textbox(s, MARGIN + Inches(8.0), CONTENT_TOP + Inches(0.85),
                    Inches(3.1), Inches(2.7))
    write(tf, 'A short aside the reader should not miss. It is the only box of '
              'its kind in the deck, so it reads as an aside and not as a card.',
          size=13, color=BODY, first=True, line=1.25)

    # 7 — metrics
    s = slide(prs)
    chrome(s, 7, eyebrow='Results', title='Four numbers that matter')
    metric_w = (W - 2 * MARGIN) / 4
    for i, (value, label) in enumerate([
        ('42%', 'Share of the total'), ('1.2M', 'Records processed'),
        ('7', 'Partners involved'), ('18', 'Months of plan'),
    ]):
        x = MARGIN + i * metric_w
        if i:
            rect(s, x - Inches(0.15), CONTENT_TOP, Pt(1), Inches(1.9), fill=RULE)
        _, tf = textbox(s, x, CONTENT_TOP, metric_w - Inches(0.4), Inches(1.1))
        write(tf, value, size=44, color=ACCENT if i % 2 == 0 else ACCENT_2,
              bold=True, first=True)
        _, tf = textbox(s, x, CONTENT_TOP + Inches(1.15), metric_w - Inches(0.4),
                        Inches(0.8))
        write(tf, label, size=13, color=BODY, first=True, line=1.2)
    _, tf = textbox(s, MARGIN, CONTENT_TOP + Inches(2.5), Inches(10), Inches(0.6))
    write(tf, 'One line on where the numbers come from, so they can be checked.',
          size=13, color=MUTED, italic=True, first=True)

    # 8 — chart
    s = slide(prs)
    chrome(s, 8, eyebrow='Evidence', title='Trend over the last six periods')
    data = CategoryChartData()
    data.categories = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
    data.add_series('Baseline', (12, 18, 21, 25, 27, 31))
    data.add_series('With the change', (12, 22, 30, 38, 47, 58))
    frame = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, MARGIN, CONTENT_TOP,
                               Inches(8.6), Inches(4.1), data)
    chart = frame.chart
    chart.has_title = False
    chart.has_legend = True
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart.legend.include_in_layout = False
    plot = chart.plots[0]
    plot.gap_width = 60
    plot.series[0].format.fill.solid()
    plot.series[0].format.fill.fore_color.rgb = RULE
    plot.series[1].format.fill.solid()
    plot.series[1].format.fill.fore_color.rgb = ACCENT
    _, tf = textbox(s, MARGIN + Inches(9.0), CONTENT_TOP, Inches(2.5), Inches(4))
    write(tf, 'Read this as', size=13, color=ACCENT, bold=True, first=True,
          space_after=6)
    write(tf, 'The gap opens in P2 and keeps widening, so the effect is not a '
              'one-period blip.', size=13, color=BODY, line=1.25)

    # 9 — timeline
    s = slide(prs)
    chrome(s, 9, eyebrow='Plan', title='Milestones')
    axis_y = CONTENT_TOP + Inches(1.9)
    rect(s, MARGIN, axis_y, W - 2 * MARGIN, Pt(2), fill=RULE)
    step = (W - 2 * MARGIN) / 4
    for i, (period, label) in enumerate([
        ('Q1', 'Setup and baseline'), ('Q2', 'First pilot'),
        ('Q3', 'Second pilot'), ('Q4', 'Consolidation and report'),
    ]):
        x = MARGIN + i * step
        rect(s, x - Inches(0.09), axis_y - Inches(0.07), Inches(0.18), Inches(0.18),
             fill=ACCENT, shape=MSO_SHAPE.OVAL)
        _, tf = textbox(s, x - Inches(0.1), axis_y - Inches(0.75), Inches(2.4),
                        Inches(0.4))
        write(tf, period, size=18, color=INK, bold=True, first=True)
        _, tf = textbox(s, x - Inches(0.1), axis_y + Inches(0.35), Inches(2.6),
                        Inches(0.8))
        write(tf, label, size=13, color=BODY, first=True, line=1.2)

    # 10 — table
    s = slide(prs)
    chrome(s, 10, eyebrow='Detail', title='Comparison')
    rows, cols = 5, 4
    table_shape = s.shapes.add_table(rows, cols, MARGIN, CONTENT_TOP,
                                     W - 2 * MARGIN, Inches(3.4))
    table = table_shape.table
    headers = ['Item', 'Option A', 'Option B', 'Decision']
    widths = [Inches(3.4), Inches(2.9), Inches(2.9), Inches(2.35)]
    for i, wd in enumerate(widths):
        table.columns[i].width = wd
    for c, head in enumerate(headers):
        cell = table.cell(0, c)
        cell.fill.solid()
        cell.fill.fore_color.rgb = INK
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        cell.margin_left = cell.margin_right = Inches(0.12)
        write(cell.text_frame, head, size=12, color=WHITE, bold=True, first=True)
    body_rows = [
        ('Scope', 'Narrow', 'Broad', 'Broad, phased'),
        ('Effort', 'Low', 'High', 'Medium'),
        ('Risk', 'Low', 'Medium', 'Low'),
        ('Recommendation', '—', '—', 'Option B, phased'),
    ]
    for r, row in enumerate(body_rows, start=1):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.fill.solid()
            cell.fill.fore_color.rgb = SURFACE if r % 2 else WHITE
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.margin_left = cell.margin_right = Inches(0.12)
            write(cell.text_frame, value, size=12,
                  color=INK if c == 0 or c == 3 else BODY, bold=(c == 0),
                  first=True)
    _, tf = textbox(s, MARGIN, CONTENT_TOP + Inches(3.6), Inches(10), Inches(0.4))
    write(tf, 'Table 1. Comparison used to take the decision.', size=10,
          color=MUTED, italic=True, first=True)

    # 11 — quote
    s = slide(prs)
    chrome(s, 11, eyebrow='In their words', title='What the users said')
    _, tf = textbox(s, MARGIN, CONTENT_TOP + Inches(0.3), Inches(1.2), Inches(1.2))
    write(tf, '“', size=72, color=RULE, bold=True, first=True)
    _, tf = textbox(s, MARGIN + Inches(1.1), CONTENT_TOP + Inches(0.5),
                    Inches(10.4), Inches(2.4))
    write(tf, 'A quotation that carries the point on its own, long enough to '
              'sound like a person and short enough to be read from the back of '
              'the room.', size=26, color=INK, italic=True, first=True, line=1.2)
    _, tf = textbox(s, MARGIN + Inches(1.1), CONTENT_TOP + Inches(3.0),
                    Inches(8), Inches(0.4))
    write(tf, 'Role, organisation', size=13, color=MUTED, first=True)

    # 12 — end card
    s = slide(prs, background=INK)
    rect(s, 0, 0, Inches(0.18), H, fill=ACCENT)
    _, tf = textbox(s, MARGIN, Inches(2.9), Inches(10), Inches(1.1))
    write(tf, 'Thank you', size=44, color=WHITE, bold=True, first=True)
    _, tf = textbox(s, MARGIN, Inches(4.15), Inches(9), Inches(0.5))
    write(tf, 'Questions, and what we need from you next.', size=16,
          color=RGBColor(0xC9, 0xD2, 0xDC), first=True)
    rect(s, MARGIN, Inches(4.85), Inches(1.6), Pt(3), fill=ACCENT_2)
    _, tf = textbox(s, MARGIN, Inches(5.15), Inches(9), Inches(0.4))
    write(tf, 'name@example.com          +00 000 000 000', size=12,
          color=RGBColor(0x9A, 0xA5, 0xB1), first=True)
    _, tf = textbox(s, W - MARGIN - Inches(1), H - Inches(0.55), Inches(1), Inches(0.3))
    write(tf, '12', size=9, color=RGBColor(0x7B, 0x87, 0x94), first=True,
          align=PP_ALIGN.RIGHT)

    target = OUT / 'pptd-slides' / 'assets' / 'templates' / 'neutral-deck.pptx'
    target.parent.mkdir(parents=True, exist_ok=True)
    prs.save(target)
    fix_chart_axis_ids(target)
    return target


def build_document() -> pathlib.Path:
    import docx
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt as DPt, RGBColor as DRGB

    d = docx.Document()
    section = d.sections[0]
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)

    styles = d.styles
    normal = styles['Normal']
    normal.font.name = FONT
    normal.font.size = DPt(11)
    normal.font.color.rgb = DRGB(0x3E, 0x4C, 0x59)
    normal.paragraph_format.space_after = DPt(8)
    normal.paragraph_format.line_spacing = 1.15

    def style(name, *, size, color, bold=False, italic=False, before=0, after=6):
        st = styles[name]
        st.font.name = FONT
        st.font.size = DPt(size)
        st.font.bold = bold
        st.font.italic = italic
        st.font.color.rgb = DRGB(*color)
        st.paragraph_format.space_before = DPt(before)
        st.paragraph_format.space_after = DPt(after)
        return st

    style('Title', size=26, color=(0x16, 0x21, 0x2B), bold=True, after=10)
    style('Heading 1', size=17, color=(0x2E, 0x6B, 0xE6), bold=True, before=16, after=6)
    style('Heading 2', size=13.5, color=(0x16, 0x21, 0x2B), bold=True, before=12, after=4)
    style('Heading 3', size=11.5, color=(0x3E, 0x4C, 0x59), bold=True, before=10, after=4)
    caption = style('Caption', size=9, color=(0x7B, 0x87, 0x94), italic=True, after=10)
    caption.paragraph_format.space_before = DPt(4)

    # header: hairline + running title
    header = section.header
    hp = header.paragraphs[0]
    hp.text = 'Project name · Document title'
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in hp.runs:
        run.font.size = DPt(8.5)
        run.font.color.rgb = DRGB(0x7B, 0x87, 0x94)
        run.font.name = FONT
    pPr = hp._p.get_or_add_pPr()
    borders = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:color'), 'D3D9E0')
    bottom.set(qn('w:space'), '6')
    borders.append(bottom)
    after_pbdr = {
        'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct',
        'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
        'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents',
        'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap',
        'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
    }
    inserted = False
    for index, child in enumerate(pPr):
        if child.tag.split('}')[-1] in after_pbdr:
            pPr.insert(index, borders)
            inserted = True
            break
    if not inserted:
        pPr.append(borders)

    # footer: doc code + PAGE field
    footer = section.footer
    fp = footer.paragraphs[0]
    fp.text = 'Confidential — internal draft          '
    fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in fp.runs:
        run.font.size = DPt(8.5)
        run.font.color.rgb = DRGB(0x7B, 0x87, 0x94)
        run.font.name = FONT
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    fp._p.append(field)

    d.add_paragraph('Title of the document', style='Title')
    lead = d.add_paragraph(
        'One paragraph that states what this document is for and who should read '
        'it. It is the only paragraph before the first heading.')
    lead.paragraph_format.space_after = DPt(14)

    d.add_heading('1. Context', level=1)
    d.add_paragraph(
        'Body text, set to the document width. Keep paragraphs to one idea; the '
        'styles carry the spacing, so no manual blank lines are needed.')

    d.add_heading('1.1 What we found', level=2)
    d.add_paragraph('A first finding, stated plainly.')
    d.add_paragraph('A second finding that follows from it.')
    for item in ['First point of the list, with its own line.',
                 'Second point, same level.',
                 'Third point, closing the list.']:
        d.add_paragraph(item, style='List Bullet')

    d.add_heading('2. Comparison', level=1)
    table = d.add_table(rows=4, cols=3)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    for c, head in enumerate(['Item', 'Option A', 'Option B']):
        cell = table.cell(0, c)
        cell.text = ''
        run = cell.paragraphs[0].add_run(head)
        run.font.bold = True
        run.font.size = DPt(10.5)
        run.font.color.rgb = DRGB(0xFF, 0xFF, 0xFF)
        run.font.name = FONT
        shading = OxmlElement('w:shd')
        shading.set(qn('w:val'), 'clear')
        shading.set(qn('w:fill'), '16212B')
        cell._tc.get_or_add_tcPr().append(shading)
    for r, row in enumerate([('Scope', 'Narrow', 'Broad'),
                             ('Effort', 'Low', 'High'),
                             ('Recommendation', '—', 'Option B, phased')], start=1):
        for c, value in enumerate(row):
            cell = table.cell(r, c)
            cell.text = ''
            run = cell.paragraphs[0].add_run(value)
            run.font.size = DPt(10.5)
            run.font.bold = c == 0
            run.font.name = FONT
            run.font.color.rgb = DRGB(0x3E, 0x4C, 0x59)
            if r % 2 == 0:
                shading = OxmlElement('w:shd')
                shading.set(qn('w:val'), 'clear')
                shading.set(qn('w:fill'), 'F4F6F8')
                cell._tc.get_or_add_tcPr().append(shading)
    d.add_paragraph('Table 1. Comparison used to take the decision.', style='Caption')

    d.add_heading('3. Callout', level=1)
    callout = d.add_table(rows=1, cols=1)
    cell = callout.cell(0, 0)
    cell.text = ''
    run = cell.paragraphs[0].add_run(
        'A note that must not be missed. The single-cell shaded table is how a '
        'callout is written here, so it stays a table when the document is '
        'converted.')
    run.font.size = DPt(10.5)
    run.font.color.rgb = DRGB(0x16, 0x21, 0x2B)
    run.font.name = FONT
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement('w:tcBorders')
    # CT_TcBorders order is top, left, bottom, right; tcBorders itself must sit
    # before w:shd inside w:tcPr.
    for edge, sz, color in (('top', '4', 'D3D9E0'), ('left', '18', '2E6BE6'),
                            ('bottom', '4', 'D3D9E0'), ('right', '4', 'D3D9E0')):
        el = OxmlElement(f'w:{edge}')
        el.set(qn('w:val'), 'single')
        el.set(qn('w:sz'), sz)
        el.set(qn('w:color'), color)
        borders.append(el)
    shading = OxmlElement('w:shd')
    shading.set(qn('w:val'), 'clear')
    shading.set(qn('w:fill'), 'F4F6F8')
    existing_shd = tcPr.find(qn('w:shd'))
    if existing_shd is not None:
        tcPr.remove(existing_shd)
    tcPr.append(borders)
    tcPr.append(shading)

    target = OUT / 'office-docs' / 'assets' / 'templates' / 'neutral-document.docx'
    target.parent.mkdir(parents=True, exist_ok=True)
    d.save(target)
    return target


deck = build_deck()
doc = build_document()
for path in (deck, doc):
    print(f'{path.relative_to(OUT)}  {path.stat().st_size / 1024:.0f} KB')
