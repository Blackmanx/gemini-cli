/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { partListUnionToString } from '../core/geminiRequest.js';
import { containsMagicKeyword } from '../utils/magicKeywords.js';

/**
 * The magic-keyword table.
 *
 * Ported from omp (`modes/magic-keywords.ts`). A keyword is a standalone prose
 * word that opts a turn into a different way of working, without the user
 * having to write a paragraph about it.
 *
 * The visible word stays in the user's message; what it adds is a hidden,
 * user-attributed notice for that turn only. Nothing here persists, so a
 * keyword in one turn cannot quietly become standing policy.
 *
 * This table is the single source of truth: the settings switch, the prompt
 * notices and any UI affordance derive from it.
 */

/** Session facts a notice may render against. */
export interface MagicKeywordContext {
  /** Enabled tool names for the turn, so a contract never names a missing one. */
  tools: readonly string[];
}

/** One magic keyword: its trigger, its requirements, and its notice. */
export interface MagicKeyword {
  /** Settings key suffix (`magicKeywords.<id>`). */
  id: string;
  /** Exact lowercase trigger, matched only as standalone prose. */
  word: string;
  label: string;
  description: string;
  /**
   * Tools that must all be enabled for the notice to apply. A contract that
   * demands a capability the session does not have is skipped rather than
   * injected, because it would only mislead.
   */
  requires: readonly string[];
  notice: (context: MagicKeywordContext) => string;
}

/** Marker replaced with the turn's enabled tool list when the notice renders. */
const TOOLS_PLACEHOLDER = '{{tools}}';

const ULTRATHINK_NOTICE = `The user asked you to think carefully on this turn.

Work through the problem deliberately before answering: identify what is actually being asked, consider the failure modes of each approach, and check the edge cases that would make a plausible answer wrong. Prefer an approach you can justify over the first one that comes to mind. State the reasoning that led to your answer where it would help the user judge it.`;

const ORCHESTRATE_NOTICE = `The user asked you to orchestrate this work.

Scope the whole task first, then delegate the substantial and independent parts in parallel rather than serialising them. Available tools: ${TOOLS_PLACEHOLDER}

Before delegating, state what each subagent must return so you can verify it. After they finish, check their results yourself — a subagent that reports success is a claim, not a fact. Continue until the original request is actually satisfied; if part of it is blocked, say which part and why.`;

const WORKFLOWZ_NOTICE = `The user asked for a deterministic multi-agent workflow.

Freeze the plan before starting: decide the steps, what each produces, and how they combine. Run the independent steps in parallel and the dependent ones in order. Give each subagent a complete brief, because it cannot see this conversation. Check every result against the plan rather than accepting it, and report where reality diverged from it.`;

const JEVIFY_NOTICE = `The user asked you to classify a long list.

Freeze the question and the decision rule before looking at any of the data, so the answer cannot drift as you read. Then work through the whole list in one pass, applying that rule uniformly. Read the details only for the items your classification flags, rather than reading everything twice.`;

export const MAGIC_KEYWORDS: readonly MagicKeyword[] = [
  {
    id: 'ultrathink',
    word: 'ultrathink',
    label: 'Ultrathink',
    description:
      'Let a standalone "ultrathink" ask for careful multi-step reasoning on that turn.',
    requires: [],
    notice: () => ULTRATHINK_NOTICE,
  },
  {
    id: 'orchestrate',
    word: 'orchestrate',
    label: 'Orchestrate',
    description:
      'Let a standalone "orchestrate" ask for parallel delegation and verification.',
    requires: ['invoke_agent'],
    notice: (context) =>
      ORCHESTRATE_NOTICE.replace(
        TOOLS_PLACEHOLDER,
        context.tools.length > 0 ? context.tools.join(', ') : 'none enabled',
      ),
  },
  {
    id: 'workflowz',
    word: 'workflowz',
    label: 'Workflowz',
    description:
      'Let a standalone "workflowz" ask for a deterministic multi-subagent workflow.',
    requires: ['invoke_agent', 'wait'],
    notice: () => WORKFLOWZ_NOTICE,
  },
  {
    id: 'jevify',
    word: 'jevify',
    label: 'Jevify',
    description:
      'Let a standalone "jevify" ask for bulk classification against a frozen rule.',
    requires: [],
    notice: () => JEVIFY_NOTICE,
  },
];

const NOTICES_BY_ID: Readonly<Record<string, MagicKeyword>> =
  Object.fromEntries(MAGIC_KEYWORDS.map((keyword) => [keyword.id, keyword]));

export const ULTRATHINK_KEYWORD_ID = 'ultrathink';

/** Per-keyword switches, defaulting to on. */
export interface MagicKeywordSettings {
  enabled?: boolean;
  ultrathink?: boolean;
  orchestrate?: boolean;
  workflowz?: boolean;
  jevify?: boolean;
}

const KNOWN_IDS: Readonly<Record<string, true>> = Object.fromEntries(
  MAGIC_KEYWORDS.map((keyword) => [keyword.id, true]),
);

/** Narrows an id to a per-keyword switch, so the lookup stays typed. */
function isKnownKeywordId(
  id: string,
): id is Exclude<keyof MagicKeywordSettings, 'enabled'> {
  return Object.prototype.hasOwnProperty.call(KNOWN_IDS, id);
}

/** Whether `id` is enabled, honouring the global switch and its own. */
export function isMagicKeywordEnabled(
  settings: MagicKeywordSettings | undefined,
  id: string,
): boolean {
  if (settings?.enabled === false) return false;
  if (settings === undefined || !isKnownKeywordId(id)) return true;
  return settings[id] !== false;
}

/**
 * The hidden notices a prompt's keywords add, in table order.
 *
 * `tools` is the enabled set for the turn; a keyword whose requirements are
 * not met is dropped, because a contract naming an unavailable tool teaches
 * the model to plan around something that does not exist.
 */
export function magicKeywordNotices(
  text: string,
  context: MagicKeywordContext,
  settings: MagicKeywordSettings | undefined,
): string[] {
  const notices: string[] = [];
  for (const keyword of MAGIC_KEYWORDS) {
    if (!isMagicKeywordEnabled(settings, keyword.id)) continue;
    if (!containsMagicKeyword(text, keyword.word)) continue;
    const missing = keyword.requires.filter(
      (tool) => !context.tools.includes(tool),
    );
    if (missing.length > 0) continue;
    notices.push(keyword.notice(context));
  }
  return notices;
}

/** The keyword ids recognised, for settings UI and docs. */
export function magicKeywordIds(): string[] {
  return MAGIC_KEYWORDS.map((keyword) => keyword.id);
}

export { NOTICES_BY_ID };

/**
 * Append the hidden notices a prompt's magic keywords add.
 *
 * The notices ride as extra text parts on the same user message, so they reach
 * the model with the turn they belong to and nowhere else. The visible message
 * is rendered from the editor buffer rather than from this array, which is what
 * keeps a notice hidden.
 *
 * Returns the request unchanged when no keyword fired, which is the common
 * case and must stay free.
 */
export function applyMagicKeywordNotices(
  request: PartListUnion,
  tools: readonly string[],
  settings: MagicKeywordSettings | undefined,
): PartListUnion {
  const text = partListUnionToString(request);
  if (text.trim() === '') return request;
  const notices = magicKeywordNotices(text, { tools }, settings);
  if (notices.length === 0) return request;
  const parts: Part[] = [{ text }];
  for (const notice of notices) {
    parts.push({ text: `<system-reminder>${notice}</system-reminder>` });
  }
  return parts;
}
