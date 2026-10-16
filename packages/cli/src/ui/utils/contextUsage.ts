/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { tokenLimit } from '@google/gemini-cli-core';

export interface ContextUsage {
  /** Tokens currently occupying the context window (the last request's prompt). */
  used: number;
  /** Context window size of the model in tokens (0 when unknown). */
  limit: number;
  /** used / limit as a raw ratio (0 when the limit is unknown). */
  fraction: number;
}

/**
 * Raw context-window accounting: how many tokens the current history occupies
 * and how many the model accepts in total. Used by the footer's context bar.
 */
export function getContextUsage(
  promptTokenCount: number,
  model: string | undefined,
): ContextUsage {
  if (!model || typeof model !== 'string' || model.length === 0) {
    return { used: promptTokenCount, limit: 0, fraction: 0 };
  }
  const limit = tokenLimit(model);
  if (limit <= 0) {
    return { used: promptTokenCount, limit: 0, fraction: 0 };
  }
  return { used: promptTokenCount, limit, fraction: promptTokenCount / limit };
}

export function getContextUsagePercentage(
  promptTokenCount: number,
  model: string | undefined,
): number {
  return getContextUsage(promptTokenCount, model).fraction;
}

export function isContextUsageHigh(
  promptTokenCount: number,
  model: string | undefined,
  threshold = 0.6,
): boolean {
  return getContextUsagePercentage(promptTokenCount, model) > threshold;
}
