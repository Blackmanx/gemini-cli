/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { setVibeMode, vibeBlockedTools } from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/vibe` — toggle read-only exploration mode.
 *
 * Ported from omp's `/vibe`. Worth having as a mode rather than a prompt: a
 * model asked in prose to refrain from editing is making a request, while a
 * model whose write tools are gone is working with a fact.
 *
 * The previous allowlist is restored on exit, not cleared - a user who
 * narrowed their toolset in settings must get their setting back, not an
 * unrestricted one.
 */
export const vibeCommand: SlashCommand = {
  name: 'vibe',
  description: 'Toggle vibe mode: read-only tools while you work it out',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session.',
      };
    }

    const vibe = {
      getCoreTools: () => config.getCoreTools(),
      setCoreTools: (tools: string[] | undefined) => config.setCoreTools(tools),
    };
    const enabled = config.getVibeMode() === true;

    if (!enabled) {
      const previous = config.getCoreTools();
      try {
        setVibeMode(vibe, true, previous);
      } catch (err) {
        return {
          type: 'message',
          messageType: 'error',
          content: err instanceof Error ? err.message : String(err),
        };
      }
      config.setVibeMode(true);
      config.setVibePreviousCoreTools(previous);
      const args_ = (args ?? '').trim();
      return {
        type: 'submit_prompt',
        content:
          `${VIBE_ON_NOTICE}\n\n` +
          (args_ === ''
            ? 'The user just turned on vibe mode without saying what to explore.'
            : args_),
      };
    }

    setVibeMode(vibe, false, config.getVibePreviousCoreTools());
    config.setVibeMode(false);
    config.setVibePreviousCoreTools(undefined);
    return {
      type: 'message',
      messageType: 'info',
      content: 'Vibe mode off. Write and shell tools are back.',
    };
  },
};

const VIBE_ON_NOTICE = [
  'Vibe mode is on: the write, edit and shell tools have been removed.',
  'Explore and report; do not claim to have changed anything.',
].join(' ');

/** Kept in sync with the core directive so the two cannot drift apart. */
export const VIBE_BLOCKED = vibeBlockedTools();
