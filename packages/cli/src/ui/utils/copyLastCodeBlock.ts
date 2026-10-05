/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '@google/gemini-cli-core';
import { lastCodeBlock } from './codeBlockExtract.js';
import { copyToClipboard } from './commandUtils.js';
import type { Settings } from '../../config/settingsSchema.js';
import type { Content } from '@google/gemini-cli-core';

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

/** The concatenated text of every model reply in the chat, oldest first. */
export function lastModelReply(history: readonly Content[] | undefined): string {
  return (
    history
      ?.filter((item) => item.role === 'model')
      .flatMap((item) => item.parts?.map((part) => part.text) ?? [])
      .join('') ?? ''
  );
}

export async function copyLastCodeBlock(
  history: readonly Content[] | undefined,
  settings: Settings,
): Promise<CopyBlockOutcome> {
  const block = lastCodeBlock(lastModelReply(history));
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