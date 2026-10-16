/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `jfind`: semantic grep over the workspace. Describe behavior in plain
 * language, get the files and line ranges that implement it.
 *
 * Ported from oh-my-pi's `find` tool (kept distinct from a shell `find` by
 * name). The exploration cascade lives in `./cascade`; the judge is a small
 * Gemini model — flash-lite by default, configured as `omp.jfind.judgeModel`
 * — answering calibrated probability questions through structured JSON, so
 * one search costs a bounded, small number of judge-model tokens.
 */
import * as fs from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import type { Config } from '../../config/config.js';
import { getErrorMessage, isNodeError } from '../../utils/errors.js';
import { ToolErrorType } from '../tool-error.js';
import { JFIND_DISPLAY_NAME, JFIND_TOOL_NAME } from '../tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from '../tools.js';
import { runCascade, type CascadeResult, type FindHit } from './cascade.js';
import { GeminiJudge } from './judge.js';
import { rankedHeat } from './passages.js';
import { resolveSearchRoot, type SearchRoot } from './tree.js';

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

/** Cells in a rendered probability gauge. */
const GAUGE_CELLS = 6;

/**
 * Wall-clock budget for one `jfind` call. The cascade itself is three fast
 * waves against a small model; the generous ceiling is for quota backoff and
 * cold starts so a search is never killed mid-flight, and a stalled judge
 * fails instead of blocking the turn.
 */
const JFIND_TIMEOUT_MS = 60_000;

export interface JfindParams {
  query: string;
  grep_keywords?: string[];
  path?: string;
}

const JFIND_PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Plain-language description of the behavior, text, or concept to locate. Not a regex; quoted phrases match whole words.',
    },
    grep_keywords: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional verbatim terms likely to appear in matching code (identifiers, strings). Omit or pass [] when unsure.',
    },
    path: {
      type: 'string',
      description:
        'Optional directory or file to scope the search; defaults to the workspace root. Line-range selectors are not supported.',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const JFIND_DESCRIPTION =
  'Semantic search: describe a behavior in plain language and get the files and line ranges that implement it. ' +
  'Use FIRST when you do not know where something is; use grep_search when you know the exact string or regex, ' +
  'and glob when you know the file name. ' +
  'query is plain language, not a regex. Scope to a known subsystem with path when the workspace is large. ' +
  'Returns hits strongest first as `path:start-end p snippet`, where p is an absolute 0-1 relevance probability: ' +
  'below ~0.4 is weak evidence, so widen the query or fall back to grep before concluding absence.';

/** `0.91`, `0.00` — two decimals, the unit the cascade thresholds on. */
function formatP(value: number): string {
  return value.toFixed(2);
}

/** `1204`, `41204` — plain grouped counts for the stats footer. */
function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** `512 B`, `3.4 KB`, … */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** `840ms`, `6.3s`, `1m12s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** A six-cell text gauge: `0.91 ██████`, `0.42 ███░░░`. */
function gauge(p: number): string {
  const filled = Math.max(
    0,
    Math.min(GAUGE_CELLS, Math.round(p * GAUGE_CELLS)),
  );
  return `${formatP(p)} ${'█'.repeat(filled)}${'░'.repeat(GAUGE_CELLS - filled)}`;
}

/** `src/auth.ts:40-58` or `src/auth.ts:40` for a single-line span. */
function formatRange(rel: string, start: number, end: number): string {
  return `${rel}:${start === end ? String(start) : `${start}-${end}`}`;
}

function statsFooter(
  result: CascadeResult,
  elapsedMs: number,
  judgeModel: string,
): string {
  const { stats } = result;
  const tokens = stats.inputTokens + stats.outputTokens;
  return (
    `listed ${formatCount(stats.listed)} · judged ${formatCount(stats.judged)} · ` +
    `read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ` +
    `${stats.requests} requests · ${formatCount(tokens)} judge tokens (${judgeModel}) · ` +
    `${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`
  );
}

/** The model-facing report: hits with strongest ranges first, then the spend. */
function buildReport(
  query: string,
  scope: string,
  result: CascadeResult,
  elapsedMs: number,
  judgeModel: string,
): string {
  const { hits, threshold, stats } = result;
  const where = scope === '' ? '' : ` in ${scope}`;
  const out: string[] = [];
  if (hits.length === 0) {
    out.push(`no hits for "${query}"${where} (τ ${formatP(threshold)})`);
  } else {
    out.push(
      `${hits.length} hit(s) for "${query}"${where} (τ ${formatP(threshold)}), strongest first`,
      '',
    );
    for (const hit of hits) {
      const coverage = hit.truncated
        ? `${hit.linesSeen} lines judged, partial`
        : `${hit.linesSeen} lines judged`;
      out.push(`${hit.rel}  ${formatP(hit.contentScore)}  ${coverage}`);
      for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
        out.push(
          `  ${formatRange(hit.rel, range.start, range.end)}  ${formatP(range.p)}  ${range.snippet}`,
        );
      }
    }
  }
  out.push('', statsFooter(result, elapsedMs, judgeModel));
  if (stats.failures.length > 0) {
    out.push(
      `${stats.errors} of ${stats.requests} judge requests failed:`,
      ...stats.failures.map((failure) => `  ${failure}`),
    );
  }
  return out.join('\n');
}

/** The user-facing display: gauge bars per hit and range, plus the spend. */
function buildDisplay(
  query: string,
  hits: readonly FindHit[],
  result: CascadeResult,
  elapsedMs: number,
  judgeModel: string,
): string {
  const out: string[] = [];
  if (hits.length === 0) {
    out.push(`jfind: no hits for "${query}"`);
  } else {
    out.push(`jfind: "${query}" — ${hits.length} hit(s), strongest first`);
    for (const hit of hits) {
      out.push(`${gauge(hit.contentScore)} ${hit.rel}`);
      for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
        out.push(
          `  ${gauge(range.p)} ${formatRange(hit.rel, range.start, range.end)}`,
        );
      }
    }
  }
  const { stats } = result;
  out.push(
    `${stats.requests} requests · ${formatCount(
      stats.inputTokens + stats.outputTokens,
    )} judge tokens (${judgeModel}) · ${formatDuration(elapsedMs)}`,
  );
  if (stats.failures.length > 0) {
    out.push(`${stats.errors} of ${stats.requests} judge requests failed`);
  }
  return out.join('\n');
}

function errorResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: `Error: ${message}`,
    error: { message, type },
  };
}

class JfindToolInvocation extends BaseToolInvocation<JfindParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: JfindParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const scope = this.params.path ? ` in ${this.params.path}` : '';
    return `find "${this.params.query}"${scope}`;
  }

  private async resolveRoot(): Promise<SearchRoot> {
    return resolveSearchRoot(
      this.params.path ?? '',
      this.config.getTargetDir(),
    );
  }

  async execute({ abortSignal: signal }: ExecuteOptions): Promise<ToolResult> {
    const started = performance.now();
    let root: SearchRoot;
    try {
      root = await this.resolveRoot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(message, ToolErrorType.PATH_NOT_IN_WORKSPACE);
    }

    const timeout = AbortSignal.timeout(JFIND_TIMEOUT_MS);
    const judgeModel = this.config.getJfindJudgeModel();
    const judge = new GeminiJudge(this.config, judgeModel);
    let result: CascadeResult;
    try {
      result = await runCascade({
        root,
        query: this.params.query.trim(),
        extraKeywords: this.params.grep_keywords ?? [],
        judge,
        ignore: this.config.getFileExclusions().getGlobExcludes(),
        includeHidden: false,
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        return errorResult(
          `jfind timed out after ${formatDuration(JFIND_TIMEOUT_MS)}`,
          ToolErrorType.GREP_EXECUTION_ERROR,
        );
      }
      throw error;
    }

    const elapsedMs = performance.now() - started;
    const scope =
      root.path === path.resolve(this.config.getTargetDir())
        ? ''
        : path.relative(this.config.getTargetDir(), root.path) || root.path;
    const llmContent = buildReport(
      this.params.query.trim(),
      scope,
      result,
      elapsedMs,
      judgeModel,
    );
    // Every judge request failing means the model saw nothing usable; flag it
    // as an error so a dead judge cannot masquerade as "no results".
    const allFailed =
      result.stats.requests > 0 &&
      result.stats.errors === result.stats.requests;
    return {
      llmContent,
      returnDisplay: buildDisplay(
        this.params.query.trim(),
        result.hits,
        result,
        elapsedMs,
        judgeModel,
      ),
      ...(allFailed
        ? {
            error: {
              message: `all ${result.stats.requests} judge requests failed`,
              type: ToolErrorType.GREP_EXECUTION_ERROR,
            },
          }
        : {}),
    };
  }
}

export class JfindTool extends BaseDeclarativeTool<JfindParams, ToolResult> {
  static readonly Name = JFIND_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      JfindTool.Name,
      JFIND_DISPLAY_NAME,
      JFIND_DESCRIPTION,
      Kind.Search,
      JFIND_PARAMETER_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: JfindParams,
  ): string | null {
    if (params.query.trim().length === 0) {
      return 'query must be a non-empty description';
    }
    if (params.path) {
      let resolved: string;
      try {
        resolved = path.resolve(this.config.getTargetDir(), params.path);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      const validationError = this.config.validatePathAccess(resolved, 'read');
      if (validationError) return validationError;
      let stats: Stats;
      try {
        stats = fs.statSync(resolved);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return `Path does not exist: ${params.path}`;
        }
        return `Failed to access path: ${getErrorMessage(error)}`;
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        return `Path is neither a file nor a directory: ${params.path}`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: JfindParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<JfindParams, ToolResult> {
    return new JfindToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}

// Exported for tests and declaration checks.
export { JFIND_PARAMETER_SCHEMA, JFIND_DESCRIPTION };
