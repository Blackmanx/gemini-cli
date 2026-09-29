/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  formatAgentActivity,
  formatAgentRoster,
} from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/agents` — the agent roster.
 *
 * Ported from omp's `/agents` and `/hub`. The question it answers is the one
 * you have mid fan-out: which subagents exist, which are still running, and
 * what each was actually asked to do. Without it, a fan-out looks like an
 * idle terminal.
 *
 * Rendered into the transcript rather than as an overlay, on purpose: an
 * overlay is gone by the time you want to paste it into a bug report.
 */
export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'List the subagents running in this session',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: () => ({
    type: 'message',
    messageType: 'info',
    content: formatAgentRoster(),
  }),
};

/**
 * `/hub` — the same roster, in activity order.
 *
 * `--all` keeps the agents that have already settled. They are dropped by
 * default because a roster of finished work is noise, but they are the whole
 * point when you are reconstructing what happened.
 */
export const hubCommand: SlashCommand = {
  name: 'hub',
  description: 'Live view of agent activity (--all to include finished)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (_context, args) => {
    const includeSettled = /\ball\b/.test(args ?? '');
    return {
      type: 'message',
      messageType: 'info',
      content: includeSettled
        ? formatAgentRoster({ includeSettled: true })
        : formatAgentActivity(),
    };
  },
};
