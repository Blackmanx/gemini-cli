/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import path from 'node:path';
import fs from 'node:fs';
import {
  makeRelative,
  shortenPath,
  resolveDefensiveToolPath,
  resolveToRealPath,
} from '../utils/paths.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
  type PolicyUpdateOptions,
  type ToolConfirmationOutcome,
  type ExecuteOptions,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { buildFilePathArgsPattern } from '../policy/utils.js';

import type { PartListUnion } from '@google/genai';
import {
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import type { Config } from '../config/config.js';
import { FileOperation } from '../telemetry/metrics.js';
import { getProgrammingLanguage } from '../telemetry/telemetry-utils.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { READ_FILE_TOOL_NAME, READ_FILE_DISPLAY_NAME } from './tool-names.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { READ_FILE_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import {
  discoverJitContext,
  appendJitContext,
  appendJitContextToParts,
} from './jit-context.js';
import {
  splitPathAndSelector,
  resolveTailSelector,
  sliceLinesForSelector,
  selToOffsetLimit,
  type ParsedSelector,
  type ResolvedSelector,
} from '../utils/readSelectors.js';
import { buildDirectoryTree } from '../utils/directoryTree.js';
import { looksLikeInternalUrl } from '../internal-urls/parse.js';
import { internalUrlRouter } from '../internal-urls/router.js';
import {
  looksLikeSqlitePath,
  parseSqliteSelector,
  readSqlite,
} from '../utils/sqliteReader.js';

/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
  /**
   * The path to the file to read
   */
  file_path: string;

  /**
   * The line number to start reading from (optional, 1-based)
   */
  start_line?: number;

  /**
   * The line number to end reading at (optional, 1-based, inclusive)
   */
  end_line?: number;

  /**
   * Return the file exactly as stored: no truncation notice, no auto-context.
   * `raw` also wins over any line selector in `file_path`.
   */
  raw?: boolean;
}

/**
 * Apply a line selector to already-resolved content.
 *
 * `:-N` needs the line count, which the router already has in memory, so the
 * tail is pinned without a second read.
 */
function applySelectorToResource(
  content: string,
  selector: ParsedSelector,
): string {
  if (selector.kind !== 'lines' && selector.kind !== 'tail') return content;
  const totalLines = content.length === 0 ? 0 : content.split('\n').length;
  const resolved =
    selector.kind === 'tail'
      ? resolveTailSelector(selector, totalLines)
      : selector;
  return sliceLinesForSelector(content, resolved);
}

class ReadFileToolInvocation extends BaseToolInvocation<
  ReadFileToolParams,
  ToolResult
> {
  private readonly resolvedPath: string;
  /** Path with any trailing line selector peeled off. */
  private readonly barePath: string;
  private readonly selector: ParsedSelector;
  constructor(
    private config: Config,
    params: ReadFileToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
    const split = splitPathAndSelector(this.params.file_path);
    this.barePath = split.path;
    this.selector = params.raw ? { kind: 'raw' } : split.selector;
    const sanitizedPath = resolveDefensiveToolPath(
      this.barePath,
      this.config.getTargetDir(),
    );
    try {
      this.resolvedPath = resolveToRealPath(
        path.resolve(this.config.getTargetDir(), sanitizedPath),
      );
    } catch {
      this.resolvedPath = path.resolve(
        this.config.getTargetDir(),
        sanitizedPath,
      );
    }
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.resolvedPath,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  override toolLocations(): ToolLocation[] {
    return [
      {
        path: this.resolvedPath,
        line: this.params.start_line,
      },
    ];
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return {
      argsPattern: buildFilePathArgsPattern(this.params.file_path),
    };
  }

  /**
   * Serve an internal `scheme://` URL through the router.
   *
   * A discrete value (a JSON-path extraction) is returned verbatim; a document
   * honours line selectors so `read local://notes.md:10-20` behaves exactly
   * like the filesystem path form.
   */
  private async readInternalUrl(href: string): Promise<ToolResult> {
    const router = internalUrlRouter();
    if (router === undefined) {
      const message = `No internal URL router is installed; ${href} cannot be read.`;
      return {
        llmContent: message,
        returnDisplay: 'Internal URLs unavailable.',
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    try {
      const resource = router.resolve(href, {
        cwd: this.config.getTargetDir(),
      });
      const text =
        resource.shape === 'value'
          ? resource.content
          : this.selector.kind === 'lines' || this.selector.kind === 'tail'
            ? applySelectorToResource(resource.content, this.selector)
            : resource.content;
      const header = [
        `URL: ${resource.url}`,
        resource.contentType ? `Content-Type: ${resource.contentType}` : '',
        resource.notes?.length ? `Notes: ${resource.notes.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        llmContent: `${header}\n\n${text}`,
        returnDisplay: text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: message,
        returnDisplay: 'Internal URL read failed.',
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
  }

  async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const sanitizedPath = resolveDefensiveToolPath(
      this.barePath,
      this.config.getTargetDir(),
    );
    let targetPathToRead = this.resolvedPath;

    // An internal URL (local://, cfg://, omp://, …) is served by the router,
    // not the filesystem. It is dispatched before path validation because a
    // URL target has no workspace-relative path to validate.
    if (looksLikeInternalUrl(this.params.file_path)) {
      return this.readInternalUrl(this.params.file_path);
    }
    try {
      targetPathToRead = resolveToRealPath(
        path.resolve(this.config.getTargetDir(), sanitizedPath),
      );
    } catch {
      targetPathToRead = path.resolve(
        this.config.getTargetDir(),
        sanitizedPath,
      );
    }

    const validationError = this.config.validatePathAccess(
      targetPathToRead,
      'read',
    );
    if (validationError) {
      return {
        llmContent: validationError,
        returnDisplay: 'Path not in workspace.',
        error: {
          message: validationError,
          type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
        },
      };
    }

    // A directory is readable through the same tool: render a shallow,
    // recency-sorted tree instead of erroring out and forcing a second tool.
    if (fs.existsSync(targetPathToRead)) {
      let isDirectory = false;
      try {
        isDirectory = (await fs.promises.stat(targetPathToRead)).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        const tree = await buildDirectoryTree(targetPathToRead);
        return {
          llmContent: `Directory listing for ${makeRelative(targetPathToRead, this.config.getTargetDir()) || '.'}:\n\n${tree}`,
          returnDisplay: tree,
        };
      }
    }

    // A `.sqlite` / `.db` path may carry a table, row or query selector, so
    // it is dispatched before the generic text path.
    if (
      this.selector.kind === 'none' &&
      looksLikeSqlitePath(this.params.file_path)
    ) {
      const sqliteTarget = parseSqliteSelector(this.params.file_path);
      if (sqliteTarget) {
        const absoluteDb = path.resolve(
          this.config.getTargetDir(),
          sqliteTarget.filePath,
        );
        const sqliteValidation = this.config.validatePathAccess(
          absoluteDb,
          'read',
        );
        if (sqliteValidation) {
          return {
            llmContent: sqliteValidation,
            returnDisplay: 'Path not in workspace.',
            error: {
              message: sqliteValidation,
              type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
            },
          };
        }
        try {
          const rendered = readSqlite(absoluteDb, sqliteTarget.selector);
          return { llmContent: rendered, returnDisplay: rendered };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            llmContent: message,
            returnDisplay: 'SQLite read failed.',
            error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
          };
        }
      }
    }

    // A path-embedded selector (`:50-120`, `:-60`, `:raw:5-9`) takes
    // precedence over the explicit start_line/end_line params.
    let startLine = this.params.start_line;
    let endLine = this.params.end_line;
    if (this.selector.kind === 'tail' || this.selector.kind === 'lines') {
      let resolved: ResolvedSelector =
        this.selector.kind === 'lines' ? this.selector : { kind: 'none' };
      if (this.selector.kind === 'tail') {
        // `:-N` needs the file's length before it can be pinned to absolute
        // lines, so the text is read once here and then re-read for the slice.
        let totalLines = Number.NaN;
        try {
          const text = await fs.promises.readFile(targetPathToRead, 'utf8');
          totalLines = text.length === 0 ? 0 : text.split('\n').length;
        } catch {
          totalLines = Number.NaN;
        }
        if (!Number.isNaN(totalLines)) {
          resolved = resolveTailSelector(this.selector, totalLines);
        }
      }
      if (resolved.kind === 'lines') {
        const { offset, limit } = selToOffsetLimit(resolved);
        startLine = offset;
        endLine = limit === undefined ? undefined : (offset ?? 1) + limit - 1;
      }
    }

    const result = await processSingleFileContent(
      targetPathToRead,
      this.config.getTargetDir(),
      this.config.getFileSystemService(),
      startLine,
      endLine,
    );

    if (result.error) {
      return {
        llmContent: result.llmContent,
        returnDisplay: result.returnDisplay || 'Error reading file',
        error: {
          message: result.error,
          type: result.errorType,
        },
      };
    }

    let llmContent: PartListUnion;
    if (result.isTruncated) {
      const [start, end] = result.linesShown!;
      const total = result.originalLineCount!;

      llmContent = `
IMPORTANT: The file content has been truncated.
Status: Showing lines ${start}-${end} of ${total} total lines.
Action: To read more of the file, you can use the 'start_line' and 'end_line' parameters in a subsequent 'read_file' call. For example, to read the next section of the file, use start_line: ${
        end + 1
      }.

--- FILE CONTENT (truncated) ---
${result.llmContent}`;
    } else {
      llmContent = result.llmContent || '';
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(targetPathToRead);
    const programming_language = getProgrammingLanguage({
      file_path: targetPathToRead,
    });
    logFileOperation(
      this.config,
      new FileOperationEvent(
        READ_FILE_TOOL_NAME,
        FileOperation.READ,
        lines,
        mimetype,
        path.extname(targetPathToRead),
        programming_language,
      ),
    );

    // Discover JIT subdirectory context for the accessed file path
    const jitContext = await discoverJitContext(this.config, targetPathToRead);
    if (jitContext) {
      if (typeof llmContent === 'string') {
        llmContent = appendJitContext(llmContent, jitContext);
      } else {
        llmContent = appendJitContextToParts(llmContent, jitContext);
      }
    }

    const displayResultSummary = result.isTruncated
      ? `${result.linesShown![0]}-${result.linesShown![1]} of ${result.originalLineCount}`
      : lines !== undefined
        ? `${lines} lines`
        : undefined;

    return {
      llmContent,
      display: {
        name: READ_FILE_DISPLAY_NAME,
        description: this.getDescription(),
        resultSummary: displayResultSummary,
        result: { type: 'text', text: result.returnDisplay || '' },
      },
      returnDisplay: result.returnDisplay || '',
    };
  }
}

/**
 * Implementation of the ReadFile tool logic
 */
export class ReadFileTool extends BaseDeclarativeTool<
  ReadFileToolParams,
  ToolResult
> {
  static readonly Name = READ_FILE_TOOL_NAME;
  private readonly fileDiscoveryService: FileDiscoveryService;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ReadFileTool.Name,
      READ_FILE_DISPLAY_NAME,
      READ_FILE_DEFINITION.base.description!,
      Kind.Read,
      READ_FILE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
    this.fileDiscoveryService = new FileDiscoveryService(
      config.getTargetDir(),
      config.getFileFilteringOptions(),
    );
  }

  protected override validateToolParamValues(
    params: ReadFileToolParams,
  ): string | null {
    if (params.file_path.trim() === '') {
      return "The 'file_path' parameter must be non-empty.";
    }

    const sanitizedPath = resolveDefensiveToolPath(
      params.file_path,
      this.config.getTargetDir(),
    );

    let resolvedPath: string;
    try {
      resolvedPath = resolveToRealPath(
        path.resolve(this.config.getTargetDir(), sanitizedPath),
      );
    } catch (err) {
      return `Failed to resolve path: ${err instanceof Error ? err.message : String(err)}`;
    }

    const validationError = this.config.validatePathAccess(
      resolvedPath,
      'read',
    );
    if (validationError) {
      return validationError;
    }

    if (
      params.start_line !== undefined &&
      params.end_line !== undefined &&
      params.start_line > params.end_line
    ) {
      return 'start_line cannot be greater than end_line';
    }

    const fileFilteringOptions = this.config.getFileFilteringOptions();
    if (
      this.fileDiscoveryService.shouldIgnoreFile(
        sanitizedPath,
        fileFilteringOptions,
      ) ||
      this.fileDiscoveryService.shouldIgnoreFile(
        resolvedPath,
        fileFilteringOptions,
      )
    ) {
      return `File path '${resolvedPath}' is ignored by configured ignore patterns.`;
    }

    return null;
  }

  protected createInvocation(
    params: ReadFileToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ReadFileToolParams, ToolResult> {
    return new ReadFileToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(READ_FILE_DEFINITION, modelId);
  }
}
