/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EDIT_TOOL_NAMES,
  HASHLINE_EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '../tools/tool-names.js';

/**
 * Vibe mode.
 *
 * Ported from omp's `/vibe`. The idea: a long stretch of exploratory work -
 * reading, tracing, understanding - where the cost of a stray edit is high
 * and the value is low. Vibe mode narrows the toolset to what can only read,
 * so the agent cannot drift into editing while it is still finding out what
 * to do.
 *
 * It is a mode rather than a prompt because the guarantee has to be mechanical.
 * Asking a model in prose to refrain from editing is a request; removing the
 * write tools is a fact. The mode name is also a signal, so the system prompt
 * gets a directive too - the model should know WHY the tools are missing
 * rather than concluding something is broken.
 */

/**
 * Tools that can change something outside the model's own reasoning, and so
 * are removed in vibe mode.
 *
 * `shell` is in the list and that is the whole point of the mode: a shell can
 * edit a file just as easily as `edit` can, so leaving it in would make the
 * read-only guarantee a suggestion.
 */
const BLOCKED_TOOLS: readonly string[] = [
  ...EDIT_TOOL_NAMES,
  HASHLINE_EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
];

/**
 * What vibe mode tells the model.
 *
 * States the reason, because a model that finds its write tools missing will
 * otherwise spend a turn diagnosing the harness.
 */
export const VIBE_PROMPT_DIRECTIVE = [
  'Vibe mode is on.',
  '',
  'You are exploring: reading, tracing, and working out what should change.',
  'Write and edit tools are removed for this mode, so a request to change a',
  'file cannot be carried out yet. If you reach a conclusion that requires a',
  'change, say what the change is and stop there - do not describe it as done.',
  'To make edits, leave vibe mode and ask for them.',
].join('\n');

/** Keep the model's view of the world honest about the missing tools. */
export function applyVibePrompt(text: string, enabled: boolean): string {
  if (!enabled) return text;
  // A second entry is a duplicate; the mode can only be on once.
  if (text.includes('Vibe mode is on.')) return text;
  return `${text}\n\n${VIBE_PROMPT_DIRECTIVE}`;
}

export interface VibeTools {
  /**
   * `undefined` means "no restriction", which is what the tool registry
   * expects. Returning a list here is what actually removes the tools.
   */
  getCoreTools: () => string[] | undefined;
  setCoreTools: (tools: string[] | undefined) => void;
}

/**
 * Turn vibe mode on or off, returning the previous state.
 *
 * Restoring the previous allowlist rather than clearing it matters: a user who
 * narrowed the toolset in settings must get their own setting back, not an
 * unrestricted one.
 */
export function setVibeMode(
  vibe: VibeTools,
  enabled: boolean,
  previousCoreTools: string[] | undefined,
): void {
  if (enabled) {
    const current = vibe.getCoreTools();
    if (current === undefined) {
      // No allowlist set, so there is nothing to subtract from and no way to
      // know the full set here. Report it rather than guessing a list that
      // would silently hide tools the user wanted.
      throw new Error(
        'Vibe mode needs an explicit tool allowlist to narrow. Set ' +
          'coreTools in settings, or narrow tools with the --allowed-tools flag.',
      );
    }
    vibe.setCoreTools(current.filter((name) => !BLOCKED_TOOLS.includes(name)));
    return;
  }
  vibe.setCoreTools(previousCoreTools);
}

/** The tool names vibe mode removes, exposed for the command's help text. */
export function vibeBlockedTools(): readonly string[] {
  return BLOCKED_TOOLS;
}
