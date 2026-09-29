/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HierarchicalMemory } from '../config/memory.js';
import { PromptProvider } from '../prompts/promptProvider.js';
import { resolvePathFromEnv as resolvePathFromEnvImpl } from '../prompts/utils.js';
import { applyVibePrompt } from '../modes/vibe.js';

/**
 * Resolves a path or switch value from an environment variable.
 * @deprecated Use resolvePathFromEnv from @google/gemini-cli-core/prompts/utils instead.
 */
export function resolvePathFromEnv(envVar?: string) {
  return resolvePathFromEnvImpl(envVar);
}

/**
 * Returns the core system prompt for the agent.
 */
export function getCoreSystemPrompt(
  config: Config,
  userMemory?: string | HierarchicalMemory,
  interactiveOverride?: boolean,
  topicUpdateNarrationOverride?: boolean,
): string {
  const prompt = new PromptProvider().getCoreSystemPrompt(
    config,
    userMemory,
    interactiveOverride,
    topicUpdateNarrationOverride,
  );
  // The toolset is the real guarantee; this tells the model why it changed, so
  // a missing write tool is not mistaken for a broken harness.
  return applyVibePrompt(prompt, config.getVibeMode());
}

/**
 * Provides the system prompt for the history compression process.
 */
export function getCompressionPrompt(config: Config): string {
  return new PromptProvider().getCompressionPrompt(config);
}
