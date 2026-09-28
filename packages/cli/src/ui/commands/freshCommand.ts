/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';

/**
 * `/fresh` — reset the model session without losing the conversation.
 *
 * Ported from omp's `/fresh`. When a session feels wedged — the model keeps
 * repeating itself, or a tool loop has left the stream in a bad state — the
 * instinct is `/clear`, and `/clear` throws away the whole conversation to
 * fix it. That is a much larger price than the problem warrants.
 *
 * `/fresh` re-establishes the model session and leaves the local transcript
 * alone, so the context you were working in survives the reset.
 */
export const freshCommand: SlashCommand = {
  name: 'fresh',
  description:
    'Reset the model session without losing this conversation (use when the session seems stuck)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context, _args) => {
    const geminiClient = context.services.agentContext?.geminiClient;

    if (!geminiClient) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: 'No active model session to reset.',
        },
        Date.now(),
      );
      return;
    }

    context.ui.setDebugMessage('Resetting the model session.');

    // Re-create the chat underneath. The on-disk transcript, the recorded
    // session file and the history in the UI are all left alone — that is
    // the whole difference from /clear.
    await geminiClient.resetChat();

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: 'Model session reset. The conversation so far is still here; if that did not help, try /clear to start over.',
      },
      Date.now(),
    );
  },
};
