# Neutral templates

Bundled starting points for the document and presentation skills. They were
generated for this repository (python-pptx / python-docx, no third-party
assets), so they carry no licence obligations: copy, edit and rebrand them
freely, or replace them with the project's own template whenever one exists.

`neutral-deck.pptx` — 16:9, 12 slides, one accent colour, the chrome
(breadcrumb, footer, page number) drawn on every content slide rather than
inherited from a layout, a native clustered-column chart, and an end card that
must stay last. Slides: cover, agenda, section divider, two columns, three
cards, bullets with an aside, metric strip, chart, timeline, table, quote,
end card.

It is a template to copy and prune, exactly like a project deck: keep the
slides you need, edit them in place, and check capacity before writing
(`python3 ../scripts/check_overlaps.py neutral-deck.pptx --capacity /slide[5]`).

Regenerate it with `python3 scripts/build-neutral-templates.py`.
