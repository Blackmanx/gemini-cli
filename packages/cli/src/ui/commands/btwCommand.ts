/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import {
  coreEvents,
  debugLogger,
  getPromptIdWithFallback,
  getResponseText,
  LlmRole,
} from '@google/gemini-cli-core';

/**
 * `/btw` asks a side question without disturbing the conversation.
 *
 * The point is that a tangent -- "what does this flag do?", "why did it pick
 * that file?" -- must not enter the main transcript. If it did, the model would
 * carry it into every later turn and would start answering questions nobody
 * asked. So this sends a request of its own, with no tools and no history, and
 * prints the answer separately.
 */
const BTW_SYSTEM_INSTRUCTION = `You are answering a side question about work already done in a terminal session.

You cannot see the session and you have no tools. Answer from general knowledge and from the question itself. If the answer depends on something only the session knows, say exactly what you would need to know.

Be brief and direct. No preamble.`;

export const btwCommand: SlashCommand = {
  name: 'btw',
  description:
    'Ask a side question without adding it to the conversation. Just /btw then your question.',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  // Safe mid-task: a tangent should not have to wait for the current turn.
  isSafeConcurrent: true,
  action: async (context, args) => {
    const question = (args ?? '').trim();
    if (!question) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Usage: /btw <question>',
      };
    }

    const config = context.services.agentContext?.config;
    if (!config) {
      debugLogger.debug('btw command: config is not available in context');
      return {
        type: 'message',
        messageType: 'error',
        content: 'btw: no active session.',
      };
    }

    // Deliberately not awaited. This command runs while a turn is in flight,
    // and blocking the command processor on a second model call interleaves
    // with the live one: the pending item gets clobbered, the earlier turn's
    // output reappears in place of the answer, and the input bar goes away.
    // Asking and returning is what keeps the session usable.
    void config
      .getBaseLlmClient()
      .generateContent({
        // A synthetic key: this request bypasses the main chat, so it must
        // not resolve through the model-role cycle a normal turn would use.
        modelConfigKey: { model: 'btw' },
        abortSignal: new AbortController().signal,
        contents: [{ role: 'user', parts: [{ text: question }] }],
        systemInstruction: BTW_SYSTEM_INSTRUCTION,
        promptId: getPromptIdWithFallback('btw'),
        role: LlmRole.UTILITY_TOOL,
      })
      .then((response) => {
        const answer = getResponseText(response)?.trim();
        coreEvents.emitFeedback(
          'info',
          `btw: ${question}\n\n${answer || '(no answer)'}`,
        );
      })
      .catch((error: unknown) => {
        coreEvents.emitFeedback(
          'error',
          `btw failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return {
      type: 'message',
      messageType: 'info',
      content: `btw: ${question}\n\n(answering in a moment -- the agent keeps working)`,
    };
  },
};
