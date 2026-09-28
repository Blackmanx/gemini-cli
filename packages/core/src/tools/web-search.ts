/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { WEB_SEARCH_TOOL_NAME, WEB_SEARCH_DISPLAY_NAME } from './tool-names.js';
import type { GroundingMetadata } from '@google/genai';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';

import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { getResponseText } from '../utils/partUtils.js';
import { debugLogger } from '../utils/debugLogger.js';
import { WEB_SEARCH_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { wrapUntrusted } from '../utils/textUtils.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  applyQueryConstraints,
  parseStructuredQuery,
  type StructuredQuery,
  type ConstraintTarget,
} from '../utils/searchQuery.js';

/** Temporal windows accepted by the `recency` parameter. */
export type WebSearchRecency = 'day' | 'week' | 'month' | 'year';

const RECENCY_VALUES: readonly WebSearchRecency[] = [
  'day',
  'week',
  'month',
  'year',
];

/**
 * Hard per-attempt timeout for one grounded request, in milliseconds.
 * A grounding-less response is retried once inside this budget.
 */
export const WEB_SEARCH_TIMEOUT_MS = 30_000;

/** One initial attempt plus one retry. */
export const WEB_SEARCH_MAX_ATTEMPTS = 2;

/** Upper bound on the `limit` parameter, matching the other search backends. */
export const WEB_SEARCH_MAX_SOURCES = 20;

/**
 * Google grounding has no first-class recency parameter, so the window is
 * carried in the instruction text instead. The wording is deliberately a
 * search-time *preference*: it never claims the API filtered anything.
 */
const RECENCY_INSTRUCTIONS: Record<WebSearchRecency, string> = {
  day: 'Search-time recency hint: the caller asked for the last 24 hours (recency: day). Weight sources published within that window most heavily, and say when a source falls outside it. This is a prompt-level preference, not an API-side date filter.',
  week: 'Search-time recency hint: the caller asked for the last 7 days (recency: week). Weight sources published within that window most heavily, and say when a source falls outside it. This is a prompt-level preference, not an API-side date filter.',
  month:
    'Search-time recency hint: the caller asked for the last 30 days (recency: month). Weight sources published within that window most heavily, and say when a source falls outside it. This is a prompt-level preference, not an API-side date filter.',
  year: 'Search-time recency hint: the caller asked for the last 12 months (recency: year). Weight sources published within that window most heavily, and say when a source falls outside it. This is a prompt-level preference, not an API-side date filter.',
};

/** Runtime guard for the `recency` parameter. */
export function isWebSearchRecency(value: unknown): value is WebSearchRecency {
  if (typeof value !== 'string') {
    return false;
  }
  return RECENCY_VALUES.some((candidate) => candidate === value);
}

/**
 * Build the instruction sent to the grounded model.
 *
 * With no `recency` the query is returned untouched, so a caller that passes
 * no new parameters produces a byte-identical request.
 */
export function buildSearchInstruction(
  query: string,
  recency?: WebSearchRecency,
): string {
  if (recency === undefined) {
    return query;
  }
  return `${query}\n\n${RECENCY_INSTRUCTIONS[recency]}`;
}

/**
 * Epoch milliseconds before which a source is too old for `recency`.
 *
 * Calendar arithmetic in UTC, so month drift (Mar 31 − 1mo → Feb 28/29) and
 * leap years land the same way the query date operators do.
 */
export function recencyCutoff(
  recency: WebSearchRecency,
  nowMs: number,
): number {
  const cutoff = new Date(nowMs);
  switch (recency) {
    case 'day':
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);
      break;
    case 'week':
      cutoff.setUTCDate(cutoff.getUTCDate() - 7);
      break;
    case 'month':
      cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
      break;
    case 'year':
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
      break;
    default:
      break;
  }
  return cutoff.getTime();
}

/** Format epoch milliseconds as a UTC `YYYY-MM-DD` day, for note text. */
function formatUtcDay(ms: number): string {
  const day = new Date(ms);
  const year = day.getUTCFullYear();
  const month = String(day.getUTCMonth() + 1).padStart(2, '0');
  const date = String(day.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
  /** Publication date when the grounding backend reports one. */
  publishedAt?: string;
  /** Alternate spelling some backends use for the publication date. */
  date?: string;
}

interface GroundingChunkItem {
  web?: GroundingChunkWeb;
  // Other properties might exist if needed in the future
}

interface GroundingSupportSegment {
  startIndex: number;
  endIndex: number;
  text?: string; // text is optional as per the example
}

interface GroundingSupportItem {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
  confidenceScores?: number[]; // Optional as per example
}

/**
 * A grounding chunk reduced to the fields the constraint filter reads, with
 * the original chunk carried along so the caller's shape survives filtering.
 */
interface IndexedSource extends ConstraintTarget {
  chunk: GroundingChunkItem;
  /** Position of this chunk in the unfiltered grounding list. */
  originalIndex: number;
  /** Parsed publication date in epoch ms, when the backend reported one. */
  publishedAtMs?: number;
}

/** An {@link IndexedSource} the backend gave a usable publication date for. */
interface DatedSource extends IndexedSource {
  publishedAtMs: number;
}

/** One grounded round-trip, classified for retry and error reporting. */
type GroundingAttempt =
  | {
      kind: 'grounded';
      text: string;
      sources: GroundingChunkItem[];
      supports: GroundingSupportItem[];
      backendQueries: string[];
    }
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  | { kind: 'timeout' };

/** Outcome of the post-grounding source pipeline. */
export interface SourceFilterOutcome {
  /** Sources surviving every filter, in their original order. */
  sources: GroundingChunkItem[];
  /**
   * Position in the unfiltered grounding list of each surviving source, so
   * citation markers can be renumbered onto the filtered list.
   */
  originalIndices: number[];
  /** Operator relaxations, recency caveats and truncation notices. */
  notes: string[];
}

/** The first parseable date on a source, if the backend reported one. */
function sourceDate(chunk: GroundingChunkItem): string | undefined {
  const raw = chunk.web?.publishedAt ?? chunk.web?.date;
  if (raw === undefined) {
    return undefined;
  }
  return Number.isNaN(Date.parse(raw)) ? undefined : raw;
}

/**
 * Reduce a parsed query to its operator dimensions.
 *
 * Free text is deliberately dropped: grounding chunks carry a title and a
 * URL but no snippet, so the `terms`/`phrases` dimensions of
 * {@link applyQueryConstraints} would match almost nothing and then relax,
 * emitting a note on every ordinary query. Keeping only the operators makes
 * `site:`/`after:`/… real filters while leaving a plain query untouched.
 */
export function selectOperatorConstraints(q: StructuredQuery): StructuredQuery {
  return {
    ...q,
    terms: [],
    excludeTerms: [],
    phrases: [],
    orGroups: [],
    raw: '',
  };
}

/**
 * Run grounding chunks through the query operators, the recency window and
 * the source limit, in that order, reporting every relaxation or drop.
 *
 * With `recency` and `limit` both absent and an operator-free query this is
 * the identity on the source list and returns no notes, which is what keeps
 * the no-new-parameter output byte-identical.
 */
export function applySourceFilters(
  sources: readonly GroundingChunkItem[],
  query: string,
  recency: WebSearchRecency | undefined,
  limit: number | undefined,
  nowMs: number,
): SourceFilterOutcome {
  const notes: string[] = [];
  if (sources.length === 0) {
    return { sources: [], originalIndices: [], notes };
  }

  const indexed: IndexedSource[] = sources.map((chunk, originalIndex) => {
    const publishedAt = sourceDate(chunk);
    const publishedAtMs =
      publishedAt === undefined ? undefined : Date.parse(publishedAt);
    return {
      chunk,
      url: chunk.web?.uri,
      title: chunk.web?.title,
      publishedAt,
      originalIndex,
      publishedAtMs,
    };
  });

  const operators = selectOperatorConstraints(parseStructuredQuery(query));
  const constrained = applyQueryConstraints(indexed, operators);
  let kept = constrained.items;
  notes.push(...constrained.notes);

  if (recency !== undefined) {
    const cutoff = recencyCutoff(recency, nowMs);
    const beforeRecency = kept.length;
    const dated = kept.filter(
      (entry): entry is DatedSource => entry.publishedAtMs !== undefined,
    );
    if (dated.length === 0) {
      notes.push(
        `Note: the ${recency} recency filter was not applied — none of the ${beforeRecency} sources carried a publication date.`,
      );
    } else {
      kept = kept.filter((entry) => {
        const time = entry.publishedAtMs;
        return time === undefined || time >= cutoff;
      });
      const dropped = beforeRecency - kept.length;
      if (dropped > 0) {
        notes.push(
          `Note: the ${recency} recency filter dropped ${dropped} of ${dated.length} dated sources published before ${formatUtcDay(cutoff)}.`,
        );
      }
      const undated = beforeRecency - dated.length;
      if (undated > 0) {
        notes.push(
          `Note: ${undated} of the ${beforeRecency} sources carried no publication date and were kept unchecked by the ${recency} recency filter.`,
        );
      }
    }
  }

  if (limit !== undefined && kept.length > limit) {
    const originalCount = kept.length;
    kept = kept.slice(0, limit);
    notes.push(
      `Note: showing ${limit} of ${originalCount} sources (limit: ${limit}); ${originalCount - limit} were dropped.`,
    );
  }

  return {
    sources: kept.map((entry) => entry.chunk),
    originalIndices: kept.map((entry) => entry.originalIndex),
    notes,
  };
}

/**
 * Render the queries a search used, for `include_queries`.
 *
 * Reports the instruction actually sent plus whatever the backend echoed
 * back, so the caller can see the recency hint that was added.
 */
export function formatQueryEcho(
  instruction: string,
  backendQueries: readonly string[],
): string {
  const lines = [`Query sent: ${instruction}`];
  for (const backendQuery of backendQueries) {
    lines.push(`Retrieval query: ${backendQuery}`);
  }
  return lines.join('\n');
}

/**
 * Parameters for the WebSearchTool.
 */
export interface WebSearchToolParams {
  /**
   * The search query.
   */

  query: string;

  /**
   * Restrict results to a recency window. Passed to the model as a
   * search-time hint and re-applied locally against whatever dates the
   * returned sources carry.
   */
  recency?: WebSearchRecency;

  /** Maximum number of sources to return. */
  limit?: number;

  /** Whether to echo the queries that were sent/used. */
  include_queries?: boolean;
}

/**
 * Extends ToolResult to include sources for web search.
 */
export interface WebSearchToolResult extends ToolResult {
  sources?: GroundingMetadata extends { groundingChunks: GroundingChunkItem[] }
    ? GroundingMetadata['groundingChunks']
    : GroundingChunkItem[];
}

class WebSearchToolInvocation extends BaseToolInvocation<
  WebSearchToolParams,
  WebSearchToolResult
> {
  constructor(
    private readonly context: AgentLoopContext,
    params: WebSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return `Searching the web for: "${this.params.query}"`;
  }

  async execute({
    abortSignal: signal,
  }: ExecuteOptions): Promise<WebSearchToolResult> {
    const instruction = buildSearchInstruction(
      this.params.query,
      this.params.recency,
    );

    try {
      // A grounded response with neither text nor sources is usually a
      // transient hiccup, so it earns the remaining attempts.
      let attempt = await this.attemptGrounding(signal, instruction);
      for (
        let attemptNumber = 1;
        attempt.kind === 'empty' && attemptNumber < WEB_SEARCH_MAX_ATTEMPTS;
        attemptNumber++
      ) {
        attempt = await this.attemptGrounding(signal, instruction);
      }

      if (attempt.kind === 'cancelled') {
        return {
          llmContent: 'Web search was cancelled.',
          returnDisplay: 'Search cancelled.',
        };
      }

      if (attempt.kind === 'timeout') {
        const errorMessage = `Error during web search for query "${this.params.query}": the search timed out after ${WEB_SEARCH_TIMEOUT_MS} ms.`;
        debugLogger.warn(errorMessage);
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error performing web search.`,
          error: {
            message: errorMessage,
            type: ToolErrorType.WEB_SEARCH_FAILED,
          },
        };
      }

      if (attempt.kind === 'empty') {
        return {
          llmContent: `No search results or information found for query: "${this.params.query}"`,
          returnDisplay: 'No information found.',
        };
      }

      const { text: responseText, supports: groundingSupports } = attempt;
      const filtered = applySourceFilters(
        attempt.sources,
        this.params.query,
        this.params.recency,
        this.params.limit,
        Date.now(),
      );
      // Filters can drop sources, so citation markers are renumbered from
      // the original chunk index to its position in the surviving list. With
      // no filtering this map is the identity.
      const positionByOriginal = new Map<number, number>();
      filtered.originalIndices.forEach((original, position) => {
        positionByOriginal.set(original, position);
      });

      let modifiedResponseText = responseText;
      const sourceListFormatted: string[] = [];

      if (filtered.sources.length > 0) {
        filtered.sources.forEach(
          (source: GroundingChunkItem, index: number) => {
            const title = source.web?.title || 'Untitled';
            const uri = source.web?.uri || 'No URI';
            sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
          },
        );

        if (groundingSupports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          groundingSupports.forEach((support: GroundingSupportItem) => {
            if (support.segment && support.groundingChunkIndices) {
              const citationMarker = support.groundingChunkIndices
                .map((chunkIndex: number) => positionByOriginal.get(chunkIndex))
                .filter(
                  (position): position is number => position !== undefined,
                )
                .map((position: number) => `[${position + 1}]`)
                .join('');
              if (citationMarker.length > 0) {
                insertions.push({
                  index: support.segment.endIndex,
                  marker: citationMarker,
                });
              }
            }
          });

          // Sort insertions by index in descending order to avoid shifting subsequent indices
          insertions.sort((a, b) => b.index - a.index);

          // Use TextEncoder/TextDecoder since segment indices are UTF-8 byte positions
          const encoder = new TextEncoder();
          const responseBytes = encoder.encode(modifiedResponseText);
          const parts: Uint8Array[] = [];
          let lastIndex = responseBytes.length;
          for (const ins of insertions) {
            const pos = Math.min(ins.index, lastIndex);
            parts.unshift(responseBytes.subarray(pos, lastIndex));
            parts.unshift(encoder.encode(ins.marker));
            lastIndex = pos;
          }
          parts.unshift(responseBytes.subarray(0, lastIndex));

          // Concatenate all parts into a single buffer
          const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
          const finalBytes = new Uint8Array(totalLength);
          let offset = 0;
          for (const part of parts) {
            finalBytes.set(part, offset);
            offset += part.length;
          }
          modifiedResponseText = new TextDecoder().decode(finalBytes);
        }

        if (sourceListFormatted.length > 0) {
          modifiedResponseText +=
            '\n\nSources:\n' + sourceListFormatted.join('\n');
        }
      }

      if (filtered.notes.length > 0) {
        modifiedResponseText += '\n\nNotes:\n' + filtered.notes.join('\n');
      }

      if (this.params.include_queries) {
        modifiedResponseText +=
          '\n\n' + formatQueryEcho(instruction, attempt.backendQueries);
      }

      return {
        llmContent: `Web search results for "${this.params.query}":\n\n${wrapUntrusted(modifiedResponseText)}`,
        returnDisplay: `Search results for "${this.params.query}" returned.`,
        sources: filtered.sources,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          llmContent: 'Web search was cancelled.',
          returnDisplay: 'Search cancelled.',
        };
      }
      const errorMessage = `Error during web search for query "${
        this.params.query
      }": ${getErrorMessage(error)}`;
      debugLogger.warn(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error performing web search.`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_SEARCH_FAILED,
        },
      };
    }
  }

  /**
   * One grounded round-trip, classified so the caller can retry, report a
   * cancellation, or surface a timeout as a tool error instead of throwing.
   */
  private async attemptGrounding(
    signal: AbortSignal,
    instruction: string,
  ): Promise<GroundingAttempt> {
    const timeoutSignal = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
    const attemptSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await this.context.geminiClient.generateContent(
        { model: 'web-search' },
        [{ role: 'user', parts: [{ text: instruction }] }],
        attemptSignal,
        LlmRole.UTILITY_TOOL,
      );

      const responseText = getResponseText(response);
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sources = groundingMetadata?.groundingChunks as
        | GroundingChunkItem[]
        | undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const groundingSupports = groundingMetadata?.groundingSupports as
        | GroundingSupportItem[]
        | undefined;

      if (!responseText || !responseText.trim() || !sources?.length) {
        return { kind: 'empty' };
      }

      return {
        kind: 'grounded',
        text: responseText,
        sources,
        supports: groundingSupports ?? [],
        backendQueries: [
          ...(groundingMetadata?.webSearchQueries ?? []),
          ...(groundingMetadata?.retrievalQueries ?? []),
        ],
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        // A user abort and our own budget expiring are both aborts; only the
        // caller's signal means "cancelled".
        return signal.aborted ? { kind: 'cancelled' } : { kind: 'timeout' };
      }
      throw error;
    }
  }
}

/**
 * A tool to perform web searches using Google Search via the Gemini API.
 */
export class WebSearchTool extends BaseDeclarativeTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name = WEB_SEARCH_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super(
      WebSearchTool.Name,
      WEB_SEARCH_DISPLAY_NAME,
      WEB_SEARCH_DEFINITION.base.description!,
      Kind.Search,
      WEB_SEARCH_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  protected override validateToolParamValues(
    params: WebSearchToolParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    if (params.recency !== undefined && !isWebSearchRecency(params.recency)) {
      return `The 'recency' parameter must be one of: ${RECENCY_VALUES.join(', ')}.`;
    }
    if (params.limit !== undefined) {
      if (!Number.isInteger(params.limit) || params.limit < 1) {
        return "The 'limit' parameter must be a positive integer.";
      }
      if (params.limit > WEB_SEARCH_MAX_SOURCES) {
        return `The 'limit' parameter must be at most ${WEB_SEARCH_MAX_SOURCES}.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: WebSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<WebSearchToolParams, WebSearchToolResult> {
    return new WebSearchToolInvocation(
      this.context.config,
      params,
      messageBus ?? this.messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(WEB_SEARCH_DEFINITION, modelId);
  }
}
