/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pulling usable code out of a model reply, for the clipboard shortcuts.
 *
 * Selecting a block in the terminal does not give you the code: the renderer
 * prefixes line numbers and the fences do not survive the copy. So the text is
 * taken from the reply itself rather than from what is on screen.
 */

/** Opening or closing fence, ``` or ~~~, optionally indented. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;

/**
 * The body of every fenced block in `text`, fences and language tag stripped.
 *
 * A block still being streamed has no closing fence; it is emitted on
 * reaching the end of the text rather than dropped, because the user is
 * asking to copy what is on screen right now.
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let openFence: string | null = null;
  let buffer: string[] = [];

  for (const line of text.split('\n')) {
    const fence = line.match(FENCE);
    if (openFence === null) {
      if (fence) {
        openFence = fence[1];
        buffer = [];
      }
      continue;
    }
    // A fence only closes on the same character, at least as long as the
    // opening one, with nothing trailing it.
    if (
      fence &&
      fence[1][0] === openFence[0] &&
      fence[1].length >= openFence.length
    ) {
      blocks.push(buffer.join('\n'));
      openFence = null;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }

  if (openFence !== null) {
    blocks.push(buffer.join('\n'));
  }

  return blocks;
}

/**
 * The last fenced block in `text`, without trailing blank lines.
 *
 * `null` when the reply has no fenced block at all, so the caller can fall
 * back to copying the whole reply instead of reporting a false miss.
 */
export function lastCodeBlock(text: string): string | null {
  const blocks = extractCodeBlocks(text);
  const last = blocks[blocks.length - 1];
  return last === undefined ? null : last.replace(/\s+$/, '');
}
