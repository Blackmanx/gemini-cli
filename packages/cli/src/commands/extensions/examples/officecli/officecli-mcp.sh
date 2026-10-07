#!/usr/bin/env bash
# Start officecli's MCP server on stdio.
#
# The binary is vendored in the bundle, but an extension lives under
# ~/.gemini/extensions, so the two are unrelated trees and no relative path
# links them. Look in the places it can actually be, in order, instead of
# copying 35 MB into the extension.
set -euo pipefail

find_binary() {
  if [ -n "${OFFICECLI:-}" ] && [ -x "${OFFICECLI}" ]; then
    echo "${OFFICECLI}"; return
  fi
  for candidate in \
    "$(dirname "$0")/officecli" \
    "$HOME/opt/gemini-cli/bundle/vendor/officecli/officecli-linux-x64" \
    "$HOME/opt/gemini-cli/bundle/vendor/officecli/officecli" \
    "$(dirname "$0")/../../../vendor/officecli/officecli-linux-x64"
  do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  if command -v officecli >/dev/null 2>&1; then
    command -v officecli; return
  fi
  echo "officecli: no se encuentra el binario." >&2
  echo "  searched: \$OFFICECLI, la extension, ~/opt/gemini-cli/bundle/vendor/officecli, PATH" >&2
  exit 127
}

exec "$(find_binary)" mcp
