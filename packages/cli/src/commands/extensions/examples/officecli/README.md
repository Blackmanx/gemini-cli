# officecli — Office documents as MCP tools

Runs the vendored `officecli` binary as an MCP stdio server, so the agent can
create, read and modify `.docx`, `.xlsx` and `.pptx` directly.

## Install

```bash
echo y | gemini extensions install ~/opt/gemini-cli/bundle/examples/officecli
gemini mcp list        # should read: officecli ... (stdio) - Connected
```

The prompt is a third-party-source confirmation; `y` accepts it.

## Where the binary comes from

`officecli-mcp.sh` looks for the binary in order: `$OFFICECLI`, its own
directory, `~/opt/gemini-cli/bundle/vendor/officecli/officecli-linux-x64`, and
`PATH`. An extension installs under `~/.gemini/extensions` while the binary
ships inside the bundle, so no relative path joins them and no copy is made.

Only `linux-x64` is vendored. Set `OFFICECLI` to point at another build.

## Scope

The server exposes a single tool named `officecli` that covers create, read and
modify across the three formats — not one tool per format or per operation.

This is the generic engine. The `office-docs` and `pptd-slides` skills keep the
corporate-specific parts: which template paragraphs are sample filler, that the cover
title lives in a text box split across runs, that a chart reads `B8:M8`, and
that headings are already auto-numbered.
