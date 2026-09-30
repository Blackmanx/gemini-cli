/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import {
  debugLogger,
  getPromptIdWithFallback,
  getResponseText,
  LlmRole,
} from '@google/gemini-cli-core';

/**
 * `/btw` asks a side question without disturbing the conversation.
 *
 * The point is that a tangent -- "what does that flag do?", "why did it pick
 * that file?" -- must not enter the main transcript. If it did, the model would
 * carry it into every later turn and would start answering questions nobody
 * asked. So this sends a request of its own, with no tools, over a snapshot of
 * the conversation, and prints the answer separately.
 *
 * The snapshot matters. A side question is almost always *about* the work in
 * front of the user ("why did you just change that?"), so sending the question
 * alone leaves the model with nothing to reason from, and it hedges instead of
 * answering. The history goes in; the answer does not come back into it.
 */
const BTW_SYSTEM_INSTRUCTION = `You are answering an ephemeral side question about the current interactive session.

The conversation so far is provided as context. Use it to answer precisely -- refer to what was actually done, by file and by name.

You have no tools and cannot run anything. If answering would require doing something, say what you would do instead, in one line.

Answer briefly and directly. No preamble, no restating the question, and never ask a follow-up question.`;

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

    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    if (!config) {
      debugLogger.debug('btw command: config is not available in context');
      return {
        type: 'message',
        messageType: 'error',
        content: 'btw: no active session.',
      };
    }

    // The live pending region: the one place that renders below the agent's
    // streaming output and keeps updating while it runs.
    const { setPendingItem } = context.ui;
    // Deliberately not awaited. This command runs while a turn is in flight,
    // and blocking the command processor on a second model call interleaves
    // with the live one: the pending item gets clobbered, the earlier turn's
    // output reappears in place of the answer, and the input bar goes away.
    // Asking and returning is what keeps the session usable.
    void config
      .getBaseLlmClient()
      .generateContent({
        // A synthetic key: this request bypasses the main chat, so it must not
        // resolve through the model-role cycle a normal turn would use.
        modelConfigKey: { model: 'btw' },
        // Its own controller. Sharing the turn's signal would kill the side
        // question the moment the turn it was watching ended.
        abortSignal: new AbortController().signal,
        // The conversation, as context for the question. Read live, so a
        // question asked mid-turn sees what the agent has done so far rather
        // than the transcript as of the last completed turn.
        contents: [
          ...agentContext.geminiClient.getHistory(),
          { role: 'user', parts: [{ text: question }] },
        ],
        systemInstruction: BTW_SYSTEM_INSTRUCTION,
        promptId: getPromptIdWithFallback('btw'),
        role: LlmRole.UTILITY_TOOL,
      })
      .then((response) => {
        const answer = getResponseText(response)?.trim();
        // The live pending region, not the history. History renders above the
        // pending region, so an item pushed there lands on top of the agent's
        // live output instead of under it -- while the agent keeps streaming.
        setPendingItem({
          type: 'info',
          text: `btw: ${question}\n\n${answer || '(no answer)'}`,
        });
      })
      .catch((error: unknown) => {
        setPendingItem({
          type: 'error',
          text: `btw failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });

    setPendingItem({ type: 'info', text: `btw: ${question}\n\n(thinking...)` });

    // Nothing for the processor to add: the answer arrives asynchronously and
    // goes to the pending region on its own. Returning a message here would
    // put a second copy of the question into history on top of it.
    return;
  },
};
