/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TodoItem, TodoPhase } from './types.js';

/**
 * Reminder builders and the "is the model waiting on the user?" heuristic,
 * ported from omp's `TodoTracker` (`checkCompletion` / `takeMidRunNudge` /
 * `isAwaitingUserAnswer`).
 *
 * Two nudges exist, both gated on `omp.todo.reminders`:
 *
 * - **Stop-time**: when the model stops (final text, no tool calls) while todos
 *   are still incomplete, inject a `<system-reminder>` and run it again — bounded
 *   by `omp.todo.remindersMax`. Suppressed when the model asked the user a
 *   question (interrupting would be rude) or is only blocked.
 * - **Mid-run**: after enough mutating tool calls without touching the board,
 *   remind the model to reconcile the list with reality.
 */

/** A todo that still needs work. `blocked` is deliberately excluded: the model
 *  cannot make progress on it, so nudging would just nag. */
function isIncomplete(task: TodoItem): boolean {
  return task.status === 'pending' || task.status === 'in_progress';
}

/** The incomplete tasks grouped under their non-empty phases. */
function incompleteByPhase(
  phases: TodoPhase[],
): Array<{ name: string; tasks: TodoItem[] }> {
  return phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter(isIncomplete),
    }))
    .filter((phase) => phase.tasks.length > 0);
}

/** Whether any phase has a pending or in-progress task. */
export function hasIncompleteTodos(phases: TodoPhase[]): boolean {
  return incompleteByPhase(phases).length > 0;
}

/** The incomplete list as a markdown-ish bullet tree for reminder bodies. */
function formatIncomplete(phases: TodoPhase[]): string {
  return incompleteByPhase(phases)
    .map(
      (phase) =>
        `- ${phase.name}\n${phase.tasks
          .map((task) => `  - ${task.content}`)
          .join('\n')}`,
    )
    .join('\n');
}

/**
 * The stop-time reminder: names the leftover work and the attempt number so the
 * model can see it is being re-prompted.
 */
export function buildStopTimeReminder(
  phases: TodoPhase[],
  attempt: number,
  maxAttempts: number,
): string {
  const incomplete = incompleteByPhase(phases).flatMap((p) => p.tasks);
  return (
    '<system-reminder>\n' +
    `You stopped with ${incomplete.length} incomplete todo item(s):\n` +
    `${formatIncomplete(phases)}\n\n` +
    'Please continue working on these tasks or mark them complete if finished.\n' +
    `(Reminder ${attempt}/${maxAttempts})\n` +
    '</system-reminder>'
  );
}

/**
 * The mid-run nudge: the model has changed code without reconciling the board.
 */
export function buildMidRunNudge(phases: TodoPhase[]): string {
  const incomplete = incompleteByPhase(phases).flatMap((p) => p.tasks);
  return (
    '<system-reminder>\n' +
    `You have made several changes this turn while ${incomplete.length} todo ` +
    `item(s) remain incomplete:\n${formatIncomplete(phases)}\n\n` +
    'Reconcile the todo list with your actual progress — mark finished items ' +
    'complete, and add or split steps you discover along the way.\n' +
    '</system-reminder>'
  );
}

// --- Question detection -----------------------------------------------------
// Ported from omp's `isAwaitingUserAnswer`. When the model stops on a question,
// a "please continue" reminder would trample the user's turn to answer, so the
// stop-time reminder stays silent instead.

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const INLINE_EMPHASIS_RE = /(\*\*|__)(.*?)\1/g;
const OPTION_LINE_RE = /^(?:[-*+]|\d+[.)])\s+\S/;
const RECOMMENDATION_RE =
  /^(?:i(?:'d| would)?\s+recommend|(?:my\s+)?recommendation)\b/i;
const CHOICE_CONFIRMATION_RE = /^(?:go|proceed|continue|stick)\s+with\b/i;
const QUESTION_PROMPT_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;
/**
 * A trailing `?`/`？` marks a question, but the English word gates above filter
 * incidental `?` out of prose (e.g. a TS `foo?: string` tail). Non-ASCII text has
 * no cheap word list, yet any non-ASCII char in a `?`-terminated line reliably
 * marks genuine prose (CJK, Spanish `¿…?`, accented Latin), so treat it as real.
 */
const NON_ASCII_TEXT_RE = /[^\x00-\x7F]/;
/** A question wrapped whole in emphasis; strikethrough is excluded (retracted). */
const WRAPPED_EMPHASIS_RE = /^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/;

interface PromptLine {
  text: string;
  hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
  const withoutMarkdownPrefix = line
    .trim()
    .replace(INLINE_EMPHASIS_RE, '$2')
    .replace(MARKDOWN_PROMPT_PREFIX_RE, '')
    .trim();
  const withoutPromptLabel = withoutMarkdownPrefix
    .replace(PROMPT_LABEL_RE, '')
    .trim();
  const withoutEmphasis = withoutPromptLabel
    .replace(WRAPPED_EMPHASIS_RE, '$2')
    .trim();
  return {
    text: withoutEmphasis,
    hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
  };
}

function isQuestionPromptLine(line: string): boolean {
  const candidate = promptLine(line);
  if (!/[?？]\s*$/.test(candidate.text)) return false;
  return (
    candidate.hadPromptLabel ||
    QUESTION_PROMPT_RE.test(candidate.text) ||
    CHOICE_CONFIRMATION_RE.test(candidate.text) ||
    USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
    NON_ASCII_TEXT_RE.test(candidate.text)
  );
}

function isResponseCueLine(line: string): boolean {
  const candidate = promptLine(line)
    .text.replace(/[.!?。！？]+$/, '')
    .trim();
  return USER_RESPONSE_CUE_RE.test(candidate);
}

/**
 * Whether the model's final message is a question awaiting the user — in which
 * case the stop-time reminder must not fire.
 */
export function isAwaitingUserAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lines = trimmed.split(/\r?\n/);
  const lastLine = lines.at(-1)?.trim();
  if (
    lastLine !== undefined &&
    (isQuestionPromptLine(lastLine) || isResponseCueLine(lastLine))
  ) {
    return true;
  }

  // Options and a recommendation do not answer the question on the user's
  // behalf. Stop at other prose so self-answered questions still resume.
  let optionCount = 0;
  let hasRecommendation = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (OPTION_LINE_RE.test(line)) {
      optionCount++;
      continue;
    }
    const candidate = promptLine(line);
    if (optionCount > 0) {
      return (
        optionCount >= 2 &&
        isQuestionPromptLine(line) &&
        (hasRecommendation ||
          candidate.hadPromptLabel ||
          USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
          CHOICE_CONFIRMATION_RE.test(candidate.text))
      );
    }
    if (RECOMMENDATION_RE.test(candidate.text)) {
      hasRecommendation = true;
      continue;
    }
    return false;
  }
  return false;
}
