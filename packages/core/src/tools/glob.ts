/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import fs from 'node:fs';
import path from 'node:path';
import { glob, escape } from 'glob';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type PolicyUpdateOptions,
  type ToolConfirmationOutcome,
  type ExecuteOptions,
} from './tools.js';
import {
  expandHome,
  shortenPath,
  makeRelative,
  resolveToRealPath,
} from '../utils/paths.js';
import { type Config } from '../config/config.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../config/constants.js';
import { ToolErrorType } from './tool-error.js';
import { GLOB_TOOL_NAME, GLOB_DISPLAY_NAME } from './tool-names.js';
import { buildPatternArgsPattern } from '../policy/utils.js';
import { getErrorMessage } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import { GLOB_DEFINITION } from './definitions/coreTools.js';
import { parseFindPattern } from '../utils/findPattern.js';
import { formatGroupedPaths } from '../utils/groupedPaths.js';
import { looksLikeInternalUrl } from '../internal-urls/parse.js';
import { internalUrlRouter } from '../internal-urls/router.js';

/** Hard default cap on files returned by one `glob` call. */
export const DEFAULT_GLOB_LIMIT = 200;
import { resolveToolDeclaration } from './definitions/resolver.js';

// Subset of 'Path' interface provided by 'glob' that we can implement for testing
export interface GlobPath {
  fullpath(): string;
  mtimeMs?: number;
}

/**
 * Sorts file entries based on recency and then alphabetically.
 * Recent files (modified within recencyThresholdMs) are listed first, newest to oldest.
 * Older files are listed after recent ones, sorted alphabetically by path.
 */
export function sortFileEntries(
  entries: GlobPath[],
  nowTimestamp: number,
  recencyThresholdMs: number,
): GlobPath[] {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const mtimeA = a.mtimeMs ?? 0;
    const mtimeB = b.mtimeMs ?? 0;
    const aIsRecent = nowTimestamp - mtimeA < recencyThresholdMs;
    const bIsRecent = nowTimestamp - mtimeB < recencyThresholdMs;

    if (aIsRecent && bIsRecent) {
      return mtimeB - mtimeA;
    } else if (aIsRecent) {
      return -1;
    } else if (bIsRecent) {
      return 1;
    } else {
      return a.fullpath().localeCompare(b.fullpath());
    }
  });
  return sortedEntries;
}

/**
 * Parameters for the GlobTool
 */
export interface GlobToolParams {
  /**
   * The glob pattern to match files against
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory)
   */
  dir_path?: string;

  /**
   * Whether the search should be case-sensitive (optional, defaults to false)
   */
  case_sensitive?: boolean;

  /**
   * Whether to respect .gitignore patterns (optional, defaults to true)
   */
  respect_git_ignore?: boolean;

  /**
   * Whether to respect .geminiignore patterns (optional, defaults to true)
   */
  respect_gemini_ignore?: boolean;

  /**
   * Maximum number of files to return (optional, defaults to 200). Results are
   * paged by file, so a narrow pattern or a larger limit walks the rest.
   */
  limit?: number;

  /**
   * Number of files to skip before this page (optional, defaults to 0).
   */
  skip?: number;
}

class GlobToolInvocation extends BaseToolInvocation<
  GlobToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: GlobToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.dir_path) {
      const searchDir = path.resolve(
        this.config.getTargetDir(),
        this.params.dir_path || '.',
      );
      const relativePath = makeRelative(searchDir, this.config.getTargetDir());
      description += ` within ${shortenPath(relativePath)}`;
    }
    return description;
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return {
      argsPattern: buildPatternArgsPattern(this.params.pattern),
    };
  }

  /**
   * Glob inside an internal URL's backing directory.
   *
   * The router owns what a scheme may expose, so this asks for a real
   * directory and then matches against it. A scheme with no local backing
   * (a virtual or remote one) is told to use `grep` over the URL instead,
   * rather than being reported as an empty result.
   */
  private async globInternalUrl(dirPath: string): Promise<ToolResult> {
    const router = internalUrlRouter();
    if (router === undefined) {
      const message = `No internal URL router is installed; ${dirPath} cannot be searched.`;
      return {
        llmContent: message,
        returnDisplay: 'Internal URLs unavailable.',
        error: {
          message,
          type: ToolErrorType.GLOB_EXECUTION_ERROR,
        },
      };
    }
    let root: string;
    try {
      root = router.locate(dirPath, { cwd: this.config.getTargetDir() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: message,
        returnDisplay: 'Internal URL is not searchable with glob.',
        error: { message, type: ToolErrorType.GLOB_EXECUTION_ERROR },
      };
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      const message = `${dirPath} is not a directory; use read_file on the file itself.`;
      return {
        llmContent: message,
        returnDisplay: 'Not a directory.',
        error: { message, type: ToolErrorType.SEARCH_PATH_NOT_A_DIRECTORY },
      };
    }
    const parsed = parseFindPattern(this.params.pattern, root);
    const base = parsed.base === '' ? root : path.resolve(root, parsed.base);
    // When the pattern names a file that actually exists, match it literally.
    // Otherwise `file[1].txt` is a character class meaning `file1.txt`, and
    // the file the user meant - the one on disk with brackets in its name - is
    // not found.
    const literal = path.resolve(root, this.params.pattern);
    const pattern = fs.existsSync(literal) ? escape(literal) : parsed.pattern;
    const entries = (await glob(pattern, {
      cwd: base,
      withFileTypes: true,
      nodir: true,
      stat: true,
      nocase: !this.params.case_sensitive,
      dot: true,
      follow: false,
    })) as GlobPath[];
    const limit = Math.max(1, this.params.limit ?? DEFAULT_GLOB_LIMIT);
    const skip = Math.max(0, this.params.skip ?? 0);
    const relative = entries
      .map((entry) => path.relative(root, entry.fullpath()))
      .sort();
    const page = relative.slice(skip, skip + limit);
    if (page.length === 0) {
      return {
        llmContent: `No files matching "${this.params.pattern}" under ${dirPath}.`,
        returnDisplay: 'No files found',
      };
    }
    return {
      llmContent: `Found ${page.length} file(s) matching "${this.params.pattern}" under ${dirPath}:\n${formatGroupedPaths(page)}`,
      returnDisplay: `Found ${page.length} matching file(s)`,
    };
  }

  async execute({ abortSignal: signal }: ExecuteOptions): Promise<ToolResult> {
    // `glob` over an internal URL (e.g. `local://`) walks that scheme's tree
    // instead of the workspace, so the scratch space is searchable with the
    // same tool the model already uses.
    if (this.params.dir_path && looksLikeInternalUrl(this.params.dir_path)) {
      return this.globInternalUrl(this.params.dir_path);
    }
    try {
      const workspaceContext = this.config.getWorkspaceContext();
      const workspaceDirectories = workspaceContext.getDirectories();

      // If a specific path is provided, resolve it and check if it's within workspace
      let searchDirectories: readonly string[];
      if (this.params.dir_path) {
        let searchDirAbsolute: string;
        try {
          searchDirAbsolute = resolveToRealPath(
            path.resolve(
              this.config.getTargetDir(),
              expandHome(this.params.dir_path),
            ),
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            llmContent: errMsg,
            returnDisplay: 'Path resolution failed.',
            error: {
              message: errMsg,
              type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
            },
          };
        }
        const validationError = this.config.validatePathAccess(
          searchDirAbsolute,
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
        searchDirectories = [searchDirAbsolute];
      } else {
        // Search across all workspace directories
        searchDirectories = workspaceDirectories;
      }

      // Get centralized file discovery service
      const fileDiscovery = this.config.getFileService();

      // Collect entries from all search directories
      const allEntries: GlobPath[] = [];
      for (const searchDir of searchDirectories) {
        // omp's find-pattern rules: a pattern with no glob characters, or
        // with the glob in its first segment, still searches recursively.
        // Without this, `*.ts` silently only matches the top level.
        const parsed = parseFindPattern(this.params.pattern, searchDir);
        let base =
          parsed.base === '' ? searchDir : path.resolve(searchDir, parsed.base);
        let pattern = parsed.pattern;
        // Check the pattern the USER typed, not the parsed one: parsing may
        // prefix `**/` for a recursive search, and the prefixed path does not
        // exist even when the file they named does. Checking the parsed
        // pattern is what made `file[1].txt` - a real file with brackets in
        // its name - unfindable, because the character class was never
        // escaped.
        const literalPath = path.resolve(searchDir, this.params.pattern);
        if (
          fs.existsSync(literalPath) &&
          !this.params.pattern.includes('*') &&
          !this.params.pattern.includes('?')
        ) {
          // A path with no wildcards that exists is a literal. The base moves
          // back to the search directory with it: parsing may have rooted the
          // search at `src/app` for a pattern that starts there, and globbing
          // the full path from that narrower base would look one level too
          // deep and find nothing.
          base = searchDir;
          pattern = escape(this.params.pattern.replace(/\\/g, '/'));
        }

        const entries = (await glob(pattern, {
          cwd: base,
          withFileTypes: true,
          nodir: true,
          stat: true,
          nocase: !this.params.case_sensitive,
          dot: true,
          ignore: this.config.getFileExclusions().getGlobExcludes(),
          follow: false,
          signal,
        })) as GlobPath[];

        allEntries.push(...entries);
      }

      let realTargetDir = this.config.getTargetDir();
      try {
        realTargetDir = resolveToRealPath(realTargetDir);
      } catch {
        // Ignore and use raw targetDir
      }

      const relativePaths = allEntries.map((p) => {
        let realFullPath = p.fullpath();
        try {
          realFullPath = resolveToRealPath(realFullPath);
        } catch {
          // Ignore and use raw fullpath
        }
        return path.relative(realTargetDir, realFullPath);
      });

      const { filteredPaths, ignoredCount } =
        fileDiscovery.filterFilesWithReport(relativePaths, {
          respectGitIgnore:
            this.params?.respect_git_ignore ??
            this.config.getFileFilteringOptions().respectGitIgnore ??
            DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
          respectGeminiIgnore:
            this.params?.respect_gemini_ignore ??
            this.config.getFileFilteringOptions().respectGeminiIgnore ??
            DEFAULT_FILE_FILTERING_OPTIONS.respectGeminiIgnore,
        });

      const filteredAbsolutePaths = new Set(
        filteredPaths.map((p) => path.resolve(this.config.getTargetDir(), p)),
      );

      const filteredEntries = allEntries.filter((entry) =>
        filteredAbsolutePaths.has(entry.fullpath()),
      );

      if (!filteredEntries || filteredEntries.length === 0) {
        let message = `No files found matching pattern "${this.params.pattern}"`;
        if (searchDirectories.length === 1) {
          message += ` within ${searchDirectories[0]}`;
        } else {
          message += ` within ${searchDirectories.length} workspace directories`;
        }
        if (ignoredCount > 0) {
          message += ` (${ignoredCount} files were ignored)`;
        }
        return {
          llmContent: message,
          returnDisplay: `No files found`,
        };
      }

      // Set filtering such that we first show the most recent files
      const oneDayInMs = 24 * 60 * 60 * 1000;
      const nowTimestamp = new Date().getTime();

      // Sort the filtered entries using the new helper function
      const sortedEntries = sortFileEntries(
        filteredEntries,
        nowTimestamp,
        oneDayInMs,
      );

      // Page by file: `skip` walks past an already-shown page and `limit`
      // caps it, so a huge match set is never silently truncated.
      const limit = Math.max(1, this.params.limit ?? DEFAULT_GLOB_LIMIT);
      const skip = Math.max(0, this.params.skip ?? 0);
      const sortedRelativePaths = sortedEntries.map((entry) => {
        let realFullPath = entry.fullpath();
        try {
          realFullPath = resolveToRealPath(realFullPath);
        } catch {
          // Ignore and use raw fullpath
        }
        return path.relative(realTargetDir, realFullPath);
      });
      const totalFileCount = sortedRelativePaths.length;
      const pagePaths = sortedRelativePaths.slice(skip, skip + limit);
      const hasMore = pagePaths.length < totalFileCount - skip;

      // A prefix-folded tree costs far fewer tokens than a flat list of deep
      // paths and reads more like the directory the model asked about.
      const fileListDescription = formatGroupedPaths(pagePaths);
      const fileCount = pagePaths.length;

      let resultMessage = `Found ${fileCount} file(s) matching "${this.params.pattern}"`;
      if (searchDirectories.length === 1) {
        resultMessage += ` within ${searchDirectories[0]}`;
      } else {
        resultMessage += ` across ${searchDirectories.length} workspace directories`;
      }
      if (skip > 0) {
        resultMessage += ` (showing ${fileCount} of ${totalFileCount} after skipping the first ${skip})`;
      } else if (totalFileCount > fileCount) {
        resultMessage += ` (showing ${fileCount} of ${totalFileCount})`;
      }
      if (ignoredCount > 0) {
        resultMessage += ` (${ignoredCount} additional files were ignored)`;
      }
      resultMessage += `, sorted by modification time (newest first):\n${fileListDescription}`;
      if (hasMore) {
        resultMessage += `\n\nMore files match. Call glob again with skip=${
          skip + fileCount
        } to continue, or narrow the pattern.`;
      }

      return {
        llmContent: resultMessage,
        returnDisplay: `Found ${fileCount} matching file(s)`,
      };
    } catch (error) {
      debugLogger.warn(`GlobLogic execute Error`, error);
      const errorMessage = getErrorMessage(error);
      const rawError = `Error during glob search operation: ${errorMessage}`;
      return {
        llmContent: rawError,
        returnDisplay: `Error: An unexpected error occurred.`,
        error: {
          message: rawError,
          type: ToolErrorType.GLOB_EXECUTION_ERROR,
        },
      };
    }
  }
}

/**
 * Implementation of the Glob tool logic
 */
export class GlobTool extends BaseDeclarativeTool<GlobToolParams, ToolResult> {
  static readonly Name = GLOB_TOOL_NAME;
  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      GlobTool.Name,
      GLOB_DISPLAY_NAME,
      GLOB_DEFINITION.base.description!,
      Kind.Search,
      GLOB_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  /**
   * Validates the parameters for the tool.
   */
  protected override validateToolParamValues(
    params: GlobToolParams,
  ): string | null {
    // An internal URL has no workspace path to validate; the router owns
    // whether it exists and what it may expose.
    if (params.dir_path && looksLikeInternalUrl(params.dir_path)) {
      return this.validatePatternOnly(params);
    }
    let searchDirAbsolute: string;
    try {
      searchDirAbsolute = resolveToRealPath(
        path.resolve(
          this.config.getTargetDir(),
          expandHome(params.dir_path || '.'),
        ),
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }

    const validationError = this.config.validatePathAccess(
      searchDirAbsolute,
      'read',
    );
    if (validationError) {
      return validationError;
    }

    const targetDir = searchDirAbsolute || this.config.getTargetDir();
    try {
      if (!fs.existsSync(targetDir)) {
        return `Search path does not exist ${targetDir}`;
      }
      if (!fs.statSync(targetDir).isDirectory()) {
        return `Search path is not a directory: ${targetDir}`;
      }
    } catch (e: unknown) {
      return `Error accessing search path: ${e}`;
    }

    return this.validatePatternOnly(params);
  }

  /**
   * The checks that hold for every search root, filesystem or `scheme://`.
   * Split out because an internal URL has no workspace path to validate.
   */
  private validatePatternOnly(params: GlobToolParams): string | null {
    if (
      !params.pattern ||
      typeof params.pattern !== 'string' ||
      params.pattern.trim() === ''
    ) {
      return "The 'pattern' parameter cannot be empty.";
    }

    if (
      params.limit !== undefined &&
      (!Number.isInteger(params.limit) || params.limit < 1)
    ) {
      return 'limit must be an integer greater than or equal to 1.';
    }

    if (
      params.skip !== undefined &&
      (!Number.isInteger(params.skip) || params.skip < 0)
    ) {
      return 'skip must be an integer greater than or equal to 0.';
    }

    return null;
  }

  protected createInvocation(
    params: GlobToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<GlobToolParams, ToolResult> {
    return new GlobToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(GLOB_DEFINITION, modelId);
  }
}
