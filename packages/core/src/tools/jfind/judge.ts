/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The jfind judge: a small, cheap Gemini model answering calibrated relevance
 * probability questions through structured JSON output.
 *
 * oh-my-pi's judge is a dedicated native endpoint returning calibrated
 * probabilities ("nouls"). Gemini has no equivalent, so each batch request
 * carries the same state the upstream judge sees and the model answers with
 * `{items: [{k, p}]}` under a response schema, temperature 0. `p` is
 * self-reported rather than calibrated, but thresholding one model's answers
 * against each other is what the cascade needs.
 *
 * Cost controls: the cheapest tier is the default model, `temperature: 0`
 * plus a response schema keeps output tokens to a few tokens per entry, the
 * output cap is a guardrail rather than a budget, and an in-session cache
 * makes an identical repeat search free.
 */
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../config/config.js';
import { LlmRole } from '../../telemetry/llmRole.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getResponseText } from '../../utils/partUtils.js';
import type { JudgeRequest } from './questions.js';

/** Probabilities keyed by entry, plus the token spend it took. */
export interface JudgeAnswer {
  answers: Map<string, number>;
  inputTokens: number;
  outputTokens: number;
}

export interface Judge {
  judge(
    request: JudgeRequest,
    options: { signal?: AbortSignal },
  ): Promise<JudgeAnswer>;
}

/** Model-config override scope: every jfind judge call resolves through it. */
const JFIND_OVERRIDE_SCOPE = 'jfind';

/** The judge answers with exactly one `{k, p}` item per requested entry key. */
const BATCH_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          k: { type: 'string', description: 'question key, e.g. e017' },
          p: {
            type: 'number',
            description: 'calibrated probability in [0, 1]',
          },
        },
        required: ['k', 'p'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/**
 * Temperature 0, strict JSON, and a small output cap. The cap is a
 * guardrail, not a budget: a full 64-entry batch is a few hundred output
 * tokens; anything larger means a malformed answer and is retried.
 */
const JUDGE_GENERATE_CONFIG: GenerateContentConfig = {
  temperature: 0,
  maxOutputTokens: 4096,
  responseMimeType: 'application/json',
  responseJsonSchema: BATCH_RESPONSE_SCHEMA,
};

const SYSTEM_INSTRUCTION =
  'You are a relevance judge for semantic code search. For every question key, estimate p: ' +
  'the probability (0 to 1) that the entry matches what the search is looking for. These are ' +
  'calibrated absolute probabilities, not relative ranks: 0.5 means "as likely as not". Apply ' +
  'the `criteria` given in the state exactly. When two adjacent values are both defensible, ' +
  'favor the higher one when the entry could plausibly contain any part of the subject — the ' +
  'caller prunes on these answers, so a plausible match missed is worse than a weak match kept. ' +
  'Answer only through the JSON schema, one item per question key, no commentary.';

/** Scopes that already carry the judge override, so repeat constructions do not stack it. */
const overrideRegistered = new WeakSet<object>();

/** Distinct prompts answered at most once per session; oldest entry goes first. */
const CACHE_MAX = 256;

/** A live, never-aborted signal for callers that have none. */
const NEVER_ABORTED = new AbortController().signal;

interface ParsedAnswer {
  answers: Map<string, number>;
}

/** A parsed JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A parsed JSON array. */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Parse a judge response body: one finite `[0,1]` probability per requested
 * key; malformed rows are dropped rather than failing the whole batch.
 * @throws {Error} when the body is not JSON or has no `items` array.
 */
export function parseJudgeAnswers(
  text: string,
  keys: readonly string[],
): ParsedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`judge returned invalid JSON: ${getErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('judge response is missing an `items` array');
  }
  const items = parsed['items'];
  if (!isArray(items)) {
    throw new Error('judge response is missing an `items` array');
  }
  const requested = new Set(keys);
  const answers = new Map<string, number>();
  for (const row of items) {
    if (!isRecord(row)) continue;
    const { k, p } = row;
    if (typeof k !== 'string' || !requested.has(k)) continue;
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    answers.set(k, Math.min(1, Math.max(0, p)));
  }
  return { answers };
}

/** A judge bound to a config: the configured judge model and the session's answer cache. */
export class GeminiJudge implements Judge {
  private readonly config: Config;
  private readonly model: string;
  private readonly cache = new Map<string, Map<string, number>>();
  private requestCounter = 0;

  constructor(config: Config, model: string) {
    this.config = config;
    this.model = model;
    const service = config.modelConfigService;
    if (!overrideRegistered.has(service)) {
      service.registerRuntimeModelOverride({
        match: { overrideScope: JFIND_OVERRIDE_SCOPE },
        modelConfig: { generateContentConfig: JUDGE_GENERATE_CONFIG },
      });
      overrideRegistered.add(service);
    }
  }

  async judge(
    request: JudgeRequest,
    options: { signal?: AbortSignal },
  ): Promise<JudgeAnswer> {
    const cached = this.cache.get(request.prompt);
    if (cached) {
      // Refresh recency so an active search pattern survives later one-offs.
      this.cache.delete(request.prompt);
      this.cache.set(request.prompt, cached);
      return { answers: cached, inputTokens: 0, outputTokens: 0 };
    }

    const response = await this.config.getBaseLlmClient().generateContent({
      modelConfigKey: {
        model: this.model,
        overrideScope: JFIND_OVERRIDE_SCOPE,
      },
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      systemInstruction: SYSTEM_INSTRUCTION,
      abortSignal: options.signal ?? NEVER_ABORTED,
      promptId: `jfind-judge-${++this.requestCounter}`,
      role: LlmRole.UTILITY_TOOL,
      maxAttempts: 2,
    });

    const text = getResponseText(response)?.trim();
    if (!text) throw new Error('judge returned an empty response');
    const { answers } = parseJudgeAnswers(text, request.keys);

    // Only complete answers are worth remembering: a partially malformed
    // batch stays usable for this search but must be re-asked next time.
    if (answers.size === request.keys.length) {
      if (this.cache.size >= CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(request.prompt, answers);
    }

    const usage = response.usageMetadata;
    return {
      answers,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
