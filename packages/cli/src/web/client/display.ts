/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The largest file the browser will attach. */
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/**
 * How much text is shown without folding.
 *
 * Past this length a tool's output or the model's reasoning is folded
 * away, so one long shell run does not push the rest of the answer off
 * the screen.
 */
export const AUTO_EXPAND_LIMIT = 1200;

/**
 * Whether text is short enough to be shown without folding.
 *
 * The reasoning and the output of a tool are shown as they are when they
 * are short, and folded away when they are not.
 */
export function shouldAutoExpand(text: string | undefined): boolean {
  return text !== undefined && text.length <= AUTO_EXPAND_LIMIT;
}

/** Turns a byte count into something a person can read. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
