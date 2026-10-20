/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { formatGrepResults, type GrepMatch } from './grep-utils.js';
import { parseFindPattern } from '../utils/findPattern.js';
import { expandHome } from '../utils/paths.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  availableLanguages,
  isLanguageKnown,
  isLanguageSupported,
  knownLanguages,
  searchAst,
  DEFAULT_AST_LIMIT,
  type AstMatch,
  type AstSearchResult,
} from './astGrepEngine.js';

const PARAM_PAT = 'pat';
const PARAM_PATH = 'path';
const PARAM_LANG = 'lang';
const PARAM_SKIP = 'skip';

/** Parameters for the AstGrep tool. */
export interface AstGrepParams {
  pat: string;
  path?: string;
  lang?: string;
  skip?: number;
}

/**
 * Object schema for the tool parameters. Registration and the shared
 * `ToolDefinition` entry are owned by the integrator; this export exists so
 * the declaration can be lifted into `definitions/` unchanged.
 */
export const AST_GREP_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    [PARAM_PAT]: {
      description:
        'AST pattern to search for, e.g. "rm -rf $DIR". Use $NAME to match one node and report the text bound to it; $_ matches one node without naming it.',
      type: 'string',
    },
    [PARAM_PATH]: {
      description:
        "Optional: file, directory or glob to search, e.g. 'src', 'scripts/deploy.sh' or 'scripts/*.sh'. Omitted searches the workspace root.",
      type: 'string',
    },
    [PARAM_LANG]: {
      description:
        'Optional: force the language instead of inferring it from the file extension. Only languages with an installed grammar can be searched; anything else is rejected.',
      type: 'string',
    },
    [PARAM_SKIP]: {
      description:
        'Optional: number of leading matches to drop. Use it to page through a result set a previous call truncated. Defaults to 0.',
      type: 'integer',
      minimum: 0,
    },
  },
  required: [PARAM_PAT],
};

function buildDescription(): string {
  const available = availableLanguages();
  const installed = new Set(available);
  const declared = knownLanguages().filter((name) => !installed.has(name));
  return [
    'Structural code search: parses each candidate file and matches the syntax tree instead of raw text, so a match is a real node and not a substring.',
    '',
    'Pattern grammar:',
    '- `$NAME` matches exactly one AST node and reports the text bound to NAME.',
    '- `$_` matches exactly one AST node without naming it.',
    '- Repeating a name requires identical text at every occurrence.',
    '- A metavariable must stand for a whole node, not part of a token.',
    '- `$$$` / `$$$NAME` (zero or more nodes) is NOT supported and is rejected.',
    '',
    `Languages with an installed grammar (usable today): ${available.join(', ')}.`,
    `Recognised but not searchable without a new grammar package: ${declared.join(', ')}.`,
    'A `lang` outside the first list is rejected rather than silently returning nothing.',
    'When `lang` is omitted the language is inferred per file from its extension.',
    '',
    'Returns up to 50 matches. Use `skip` to page further, or narrow `path`.',
  ].join('\n');
}

function toGrepMatches(result: AstSearchResult, root: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const match of result.matches) {
    const absolutePath = path.resolve(root, match.file);
    const lines = match.text.split('\n');
    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = lines[offset];
      if (line === undefined) {
        continue;
      }
      matches.push({
        filePath: match.file,
        absolutePath,
        lineNumber: match.startLine + offset,
        line,
        isContext: offset > 0,
      });
    }
  }
  return matches;
}

function renderMetavariables(matches: readonly AstMatch[]): string[] {
  const lines: string[] = [];
  for (const match of matches) {
    const names = Object.keys(match.metaVariables ?? {});
    if (names.length === 0) {
      continue;
    }
    const bindings = names
      .sort()
      .map((name) => `${name}=${match.metaVariables?.[name]}`)
      .join(', ');
    lines.push(`${match.file}:${match.startLine} ${bindings}`);
  }
  return lines;
}

function patternDiagnostics(result: AstSearchResult): string[] {
  return result.parseErrors.filter((entry) => entry.startsWith('pattern: '));
}

/**
 * Reports "nothing was searched" honestly instead of claiming the code does not
 * contain the pattern.
 */
function emptyResultMessage(
  result: AstSearchResult,
  root: string,
  pattern: string,
): string {
  const [first] = patternDiagnostics(result);
  if (first !== undefined) {
    return first.replace(/^pattern: /, '');
  }
  if (result.scannedFiles === 0) {
    return `No searchable files were found under ${root}, so pattern "${pattern}" was never evaluated. Searchable languages: ${availableLanguages().join(', ')}.`;
  }
  return `No matches found for pattern "${pattern}" under ${root}. ${result.scannedFiles} file(s) were parsed.`;
}

class AstGrepToolInvocation extends BaseToolInvocation<
  AstGrepParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: AstGrepParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return `AST search for pattern "${this.params.pat}"`;
  }

  override async execute(options: ExecuteOptions): Promise<ToolResult> {
    const targetDir = this.config.getTargetDir();
    const rawPath = this.params.path?.trim() ?? '';
    const { base, pattern: glob } = parseFindPattern(
      expandHome(rawPath.length > 0 ? rawPath : '.'),
      targetDir,
    );
    const root = path.resolve(targetDir, base.length > 0 ? base : '.');
    const skip = Math.max(0, Math.floor(this.params.skip ?? 0));

    let result: AstSearchResult;
    try {
      result = await searchAst({
        pattern: this.params.pat,
        root,
        lang: this.params.lang,
        limit: DEFAULT_AST_LIMIT,
        skip,
        glob,
        signal: options.abortSignal,
        includeNodeModules: rawPath.includes('node_modules'),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        llmContent: `AST search failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type: ToolErrorType.GREP_EXECUTION_ERROR },
      };
    }

    if (result.matches.length === 0) {
      const message = emptyResultMessage(result, root, this.params.pat);
      const isBadPattern = patternDiagnostics(result).length > 0;
      const details = result.parseErrors
        .filter((entry) => entry !== `pattern: ${message}`)
        .join('\n');
      return {
        llmContent: details.length > 0 ? `${message}\n${details}` : message,
        returnDisplay: message,
        error: isBadPattern
          ? { message, type: ToolErrorType.INVALID_TOOL_PARAMS }
          : undefined,
      };
    }

    const { llmContent, returnDisplay } = await formatGrepResults(
      toGrepMatches(result, root),
      // `context: 0` disables the auto-context pass: the match text already
      // spans the whole node, and the line numbers are the match's own.
      { pattern: this.params.pat, context: 0 },
      `under ${root}`,
      DEFAULT_AST_LIMIT + 1,
    );

    const sections = [llmContent];
    const metavariables = renderMetavariables(result.matches);
    if (metavariables.length > 0) {
      sections.push(`---\nMetavariables:\n${metavariables.join('\n')}`);
    }
    if (result.truncated) {
      sections.push(
        `Result limit of ${DEFAULT_AST_LIMIT} reached after skipping ${skip}. Narrow \`path\` or raise \`skip\` by ${DEFAULT_AST_LIMIT} to see more.`,
      );
    }
    if (result.parseErrors.length > 0) {
      sections.push(
        `Parse issues (${result.parseErrors.length} shown, cap 20):\n${result.parseErrors.join('\n')}`,
      );
    }

    return {
      llmContent: sections.join('\n'),
      returnDisplay,
    };
  }
}

/** Structural (`Kind.Search`) code search over the tree-sitter grammars. */
export class AstGrepTool extends BaseDeclarativeTool<
  AstGrepParams,
  ToolResult
> {
  static readonly Name = 'ast_grep';
  static readonly DisplayName = 'AST Grep';

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      AstGrepTool.Name,
      AstGrepTool.DisplayName,
      buildDescription(),
      Kind.Search,
      AST_GREP_PARAMETERS_JSON_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: AstGrepParams,
  ): string | null {
    if (typeof params.pat !== 'string' || params.pat.trim().length === 0) {
      return '`pat` must be a non-empty AST pattern.';
    }
    if (params.path !== undefined) {
      if (typeof params.path !== 'string' || params.path.trim().length === 0) {
        return '`path` must be a non-empty file, directory or glob when given.';
      }
    }
    if (params.skip !== undefined) {
      if (!Number.isInteger(params.skip) || params.skip < 0) {
        return '`skip` must be an integer greater than or equal to 0.';
      }
    }
    if (params.lang !== undefined) {
      const requested = params.lang.trim().toLowerCase();
      if (!isLanguageKnown(requested)) {
        return `Unknown language "${params.lang}". Known languages: ${knownLanguages().join(', ')}.`;
      }
      if (!isLanguageSupported(requested)) {
        return `Language "${requested}" has no tree-sitter grammar installed, so it cannot be searched. Available: ${availableLanguages().join(', ')}.`;
      }
    }
    return this.validateSearchPath(params.path);
  }

  /**
   * A pattern problem is a bad call and is reported as an error; a missing
   * grammar is a missing call and is left to the scan to explain.
   */
  private validateSearchPath(rawPath: string | undefined): string | null {
    const targetDir = this.config.getTargetDir();
    const trimmed = rawPath?.trim() ?? '';
    let base: string;
    try {
      // The glob half of `path` is matched against candidate files, not
      // resolved as a path, so only the base half is checked for existence.
      base = parseFindPattern(
        trimmed.length > 0 ? trimmed : '.',
        targetDir,
      ).base;
    } catch (error) {
      return getErrorMessage(error);
    }
    const absolute = path.resolve(targetDir, base.length > 0 ? base : '.');

    const accessError = this.config.validatePathAccess(absolute, 'read');
    if (accessError) {
      return accessError;
    }

    try {
      if (!fs.existsSync(absolute)) {
        return `Search path does not exist: ${absolute}`;
      }
    } catch (error) {
      return `Error accessing search path: ${getErrorMessage(error)}`;
    }
    return null;
  }

  protected createInvocation(
    params: AstGrepParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<AstGrepParams, ToolResult> {
    return new AstGrepToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
