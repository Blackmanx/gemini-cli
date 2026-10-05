/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '@google/gemini-cli-core';
import { lastCodeBlock } from './codeBlockExtract.js';
import { copyToClipboard } from './commandUtils.js';
import type { Settings } from '../../config/settingsSchema.js';
import type { HistoryItem } from '../types.js';

/**
 * Copying the model's last code block, shared by the F5 key and `/copy-block`.
 *
 * Selecting a block on screen does not give you the code: the renderer prefixes
 * line numbers and the fences do not survive the copy. The text is taken from
 * the reply itself instead.
 */
export interface CopyBlockOutcome {
  /** What to tell the user, or `null` when nothing was copied. */
  message: string;
  isError: boolean;
  /** The text that reached the clipboard, for tests and callers. */
  copied: string | null;
}

/**
 * The last thing the model actually printed, from the TUI's own history.
 *
 * The chat history is not the source: what reaches the screen is what the user
 * is looking at, and a reply can be edited, truncated or replayed before it is
 * drawn. Mining the rendered items also means fences are present, which is what
 * the extractor needs.
 */
export function lastRenderedReply(
  history: readonly HistoryItem[] | undefined,
): string {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    const item = history![i];
    if ((item.type === 'gemini' || item.type === 'gemini_content') && item.text)
      return item.text;
  }
  return '';
}

export async function copyLastCodeBlock(
  history: readonly HistoryItem[] | undefined,
  settings: Settings,
): Promise<CopyBlockOutcome> {
  const block = lastCodeBlock(lastRenderedReply(history));
  if (!block) {
    return {
      message: 'No code block in the last response.',
      isError: false,
      copied: null,
    };
  }

  try {
    await copyToClipboard(block, settings);
    return {
      message: 'Code block copied to the clipboard.',
      isError: false,
      copied: block,
    };
  } catch (error) {
    debugLogger.debug(
      `Could not copy code block: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      message: `Failed to copy. ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      copied: null,
    };
  }
}
