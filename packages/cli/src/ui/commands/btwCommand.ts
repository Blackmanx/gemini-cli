/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { CommandKind, type SlashCommand } from './types.js';
import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  debugLogger,
  getPromptIdWithFallback,
  getResponseText,
  LlmRole,
  modelStringToModelConfigAlias,
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

/**
 * How long to wait for the side answer before giving up.
 *
 * Without this the placeholder below can sit there forever, with no way for the
 * user to tell a slow answer from a dead one.
 */
const BTW_TIMEOUT_MS = 90_000;

/**
 * The conversation with tool traffic removed.
 *
 * This runs while a turn is in flight, so the live history can be mid-flight
 * too: a function call whose response has not arrived yet, or a tool result
 * whose call was only just emitted. Replaying that against a request carrying
 * no tools is a malformed conversation -- the model sees a pattern of tool
 * calls it is not allowed to continue and starts reproducing it, which is what
 * tripped loop detection. The narration around those calls is what actually
 * answers the question, so keep the text and drop the rest.
 */
function conversationAsText(history: readonly Content[]): Content[] {
  return history
    .map((content): Content | null => {
      const parts = (content.parts ?? []).filter(
        (part) => typeof part.text === 'string' && part.text.length > 0,
      );
      return parts.length === 0 ? null : { role: content.role, parts };
    })
    .filter((content): content is Content => content !== null);
}

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
    const answered = (text: string, isError: boolean) => {
      setPendingItem({
        type: isError ? 'error' : 'info',
        text: `btw: ${question}\n\n${text}`,
      });
    };

    // A side question is a glance, not a task. It runs on flash-lite by
    // default so it cannot spend the budget of the main turn, and the model is
    // overridable because the right answer depends on the question.
    const btwModel =
      context.services.settings.merged.omp?.btwModel ??
      DEFAULT_GEMINI_FLASH_LITE_MODEL;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      answered('(timed out)', true);
      controller.abort();
    }, BTW_TIMEOUT_MS);

    // Deliberately not awaited. This command runs while a turn is in flight,
    // and blocking the command processor on a second model call interleaves
    // with the live one: the pending item gets clobbered, the earlier turn's
    // output reappears in place of the answer, and the input bar goes away.
    // Asking and returning is what keeps the session usable.
    void config
      .getBaseLlmClient()
      .generateContent({
        // A real model, not a synthetic key. The key is looked up in the model
        // config service, so an invented name resolves to nothing and the
        // request never comes back -- which is what left the placeholder
        // spinning at "(thinking...)" with no error anywhere.
        modelConfigKey: {
          model: modelStringToModelConfigAlias(btwModel),
        },
        // Its own controller, so cancelling this answer never cancels the turn
        // it was watching, and never the other way round.
        abortSignal: controller.signal,
        contents: [
          ...conversationAsText(agentContext.geminiClient.getHistory()),
          { role: 'user', parts: [{ text: question }] },
        ],
        systemInstruction: BTW_SYSTEM_INSTRUCTION,
        promptId: getPromptIdWithFallback('btw'),
        role: LlmRole.UTILITY_TOOL,
      })
      .then((response) => {
        clearTimeout(timer);
        answered(getResponseText(response)?.trim() || '(no answer)', false);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        // Only the timeout above has already spoken. Every other failure --
        // including any abort raised elsewhere -- gets reported, because a
        // silently swallowed error here is indistinguishable from a hang.
        if (!timedOut) {
          const message =
            error instanceof Error ? error.message : String(error);
          answered(`failed: ${message}`, true);
        }
      });

    setPendingItem({ type: 'info', text: `btw: ${question}\n\n(thinking...)` });

    // Nothing for the processor to add: the answer arrives asynchronously and
    // goes to the pending region on its own. Returning a message here would
    // put a second copy of the question into history on top of it.
    return;
  },
};
