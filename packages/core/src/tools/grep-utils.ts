/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'node:fs/promises';
import { debugLogger } from '../utils/debugLogger.js';
import { MAX_LINE_LENGTH_TEXT_FILE } from '../utils/constants.js';
import type { GrepResult } from './tools.js';

/**
 * Result object for a single grep match
 */
export interface GrepMatch {
  filePath: string;
  absolutePath: string;
  lineNumber: number;
  line: string;
  isContext?: boolean;
}

/**
 * Groups matches by their file path and ensures they are sorted by line number.
 */
export function groupMatchesByFile(
  allMatches: GrepMatch[],
): Record<string, GrepMatch[]> {
  const groups: Record<string, GrepMatch[]> = {};

  for (const match of allMatches) {
    if (!groups[match.filePath]) {
      groups[match.filePath] = [];
    }
    groups[match.filePath].push(match);
  }

  for (const filePath in groups) {
    groups[filePath].sort((a, b) => a.lineNumber - b.lineNumber);
  }

  return groups;
}

/**
 * Reads the content of a file and splits it into lines.
 * Returns null if the file cannot be read.
 */
export async function readFileLines(
  absolutePath: string,
): Promise<string[] | null> {
  try {
    const content = await fsPromises.readFile(absolutePath, 'utf8');
    return content.split(/\r?\n/);
  } catch (err) {
    debugLogger.warn(`Failed to read file for context: ${absolutePath}`, err);
    return null;
  }
}

/**
 * Automatically enriches grep results with surrounding context if the match count is low
 * and no specific context was requested. This optimization can enable the agent
 * to skip turns that would be spent reading files after grep calls.
 */
export async function enrichWithAutoContext(
  matchesByFile: Record<string, GrepMatch[]>,
  matchCount: number,
  params: {
    names_only?: boolean;
    context?: number;
    before?: number;
    after?: number;
  },
): Promise<void> {
  const { names_only, context, before, after } = params;

  if (
    matchCount >= 1 &&
    matchCount <= 3 &&
    !names_only &&
    context === undefined &&
    before === undefined &&
    after === undefined
  ) {
    const contextLines = matchCount === 1 ? 50 : 15;
    for (const filePath in matchesByFile) {
      const fileMatches = matchesByFile[filePath];
      if (fileMatches.length === 0) continue;

      const fileLines = await readFileLines(fileMatches[0].absolutePath);

      if (fileLines) {
        const newFileMatches: GrepMatch[] = [];
        const seenLines = new Set<number>();

        // Sort matches to process them in order
        fileMatches.sort((a, b) => a.lineNumber - b.lineNumber);

        for (const match of fileMatches) {
          const startLine = Math.max(0, match.lineNumber - 1 - contextLines);
          const endLine = Math.min(
            fileLines.length,
            match.lineNumber - 1 + contextLines + 1,
          );

          for (let i = startLine; i < endLine; i++) {
            const lineNum = i + 1;
            if (!seenLines.has(lineNum)) {
              newFileMatches.push({
                absolutePath: match.absolutePath,
                filePath: match.filePath,
                lineNumber: lineNum,
                line: fileLines[i],
                isContext: lineNum !== match.lineNumber,
              });
              seenLines.add(lineNum);
            } else if (lineNum === match.lineNumber) {
              const existing = newFileMatches.find(
                (m) => m.lineNumber === lineNum,
              );
              if (existing) {
                existing.isContext = false;
              }
            }
          }
        }
        matchesByFile[filePath] = newFileMatches.sort(
          (a, b) => a.lineNumber - b.lineNumber,
        );
      }
    }
  }
}

/**
 * Number of matching FILES rendered per `skip` page. Matches omp's grep page
 * size, so a large result set is walked one page at a time instead of being
 * silently truncated.
 */
export const GREP_SKIP_PAGE_FILES = 20;

/**
 * Formats the grep results for the LLM, including optional context.
 */
export async function formatGrepResults(
  allMatches: GrepMatch[],
  params: {
    pattern: string;
    names_only?: boolean;
    include_pattern?: string;
    // Context params to determine if auto-context should be skipped
    context?: number;
    before?: number;
    after?: number;
    // Number of matching FILES already shown by the caller.
    skip?: number;
  },
  searchLocationDescription: string,
  totalMaxMatches: number,
): Promise<{ llmContent: string; returnDisplay: GrepResult }> {
  const { pattern, names_only, include_pattern } = params;

  if (allMatches.length === 0) {
    const noMatchMsg = `No matches found for pattern "${pattern}" ${searchLocationDescription}${include_pattern ? ` (filter: "${include_pattern}")` : ''}.`;
    return {
      llmContent: noMatchMsg,
      returnDisplay: {
        summary: 'No matches found',
        matches: [],
      },
    };
  }

  const grouped = groupMatchesByFile(allMatches);
  // A file can appear with context lines only when every one of its real
  // matches was dropped by exclude_pattern. Such files have nothing to show.
  for (const filePath of Object.keys(grouped)) {
    if (!grouped[filePath].some((m) => !m.isContext)) {
      delete grouped[filePath];
    }
  }
  // Page by FILE so a large result set can be walked with `skip` instead of
  // being cut off. Files are ordered deterministically so paging is stable.
  const allFilePaths = Object.keys(grouped).sort();
  const skip = Math.max(0, params.skip ?? 0);
  const pageFilePaths = skip > 0 ? allFilePaths.slice(skip) : allFilePaths;
  const shownFilePaths =
    skip > 0 ? pageFilePaths.slice(0, GREP_SKIP_PAGE_FILES) : pageFilePaths;
  const hasMoreFiles = shownFilePaths.length < pageFilePaths.length;
  const matchesByFile: Record<string, GrepMatch[]> = {};
  for (const filePath of shownFilePaths) {
    matchesByFile[filePath] = grouped[filePath];
  }

  const pageMatches = shownFilePaths.flatMap((p) => grouped[p]);
  const matchesOnly = pageMatches.filter((m) => !m.isContext);
  const matchCount = matchesOnly.length; // Count actual matches, not context lines
  const matchTerm = matchCount === 1 ? 'match' : 'matches';
  const totalFileCount = allFilePaths.length;
  const pageNote =
    skip > 0
      ? ` (showing ${shownFilePaths.length} of ${totalFileCount} files with matches, after skipping the first ${skip})`
      : '';
  const nextPageHint = hasMoreFiles
    ? `\nMore files with matches remain: call grep again with skip=${
        skip + shownFilePaths.length
      } to continue.`
    : '';

  // If the result count is low and Gemini didn't request before/after lines of context
  // add a small amount anyways to enable the agent to avoid one or more extra turns
  // reading the matched files. This optimization reduces turns count by ~10% in SWEBench.
  await enrichWithAutoContext(matchesByFile, matchCount, params);

  const wasTruncated = matchCount >= totalMaxMatches;

  if (names_only) {
    const filePaths = shownFilePaths;
    let llmContent = `Found ${filePaths.length} files with matches for pattern "${pattern}" ${searchLocationDescription}${
      include_pattern ? ` (filter: "${include_pattern}")` : ''
    }${
      wasTruncated
        ? ` (results limited to ${totalMaxMatches} matches for performance)`
        : ''
    }${pageNote}:\n`;
    llmContent += filePaths.join('\n');
    return {
      llmContent: (llmContent.trim() + nextPageHint).trim(),
      returnDisplay: {
        summary: `Found ${filePaths.length} files${wasTruncated ? ' (limited)' : ''}`,
        matches: [],
      },
    };
  }

  let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${pattern}" ${searchLocationDescription}${include_pattern ? ` (filter: "${include_pattern}")` : ''}`;

  if (wasTruncated) {
    llmContent += ` (results limited to ${totalMaxMatches} matches for performance)`;
  }
  if (skip > 0) {
    llmContent += pageNote;
  }
  if (hasMoreFiles) {
    llmContent += ` (more files remain; call grep again with skip=${
      skip + shownFilePaths.length
    } to continue)`;
  }

  llmContent += `:\n---\n`;

  for (const filePath in matchesByFile) {
    llmContent += `File: ${filePath}\n`;
    matchesByFile[filePath].forEach((match) => {
      // If isContext is undefined, assume it's a match (false)
      const separator = match.isContext ? '-' : ':';
      // trimEnd to avoid double newlines if line has them, but we want to preserve indentation
      let lineContent = match.line.trimEnd();
      const graphemes = Array.from(lineContent);
      if (graphemes.length > MAX_LINE_LENGTH_TEXT_FILE) {
        lineContent =
          graphemes.slice(0, MAX_LINE_LENGTH_TEXT_FILE).join('') +
          '... [truncated]';
      }
      llmContent += `L${match.lineNumber}${separator} ${lineContent}\n`;
    });
    llmContent += '---\n';
  }

  return {
    llmContent: (llmContent.trim() + nextPageHint).trim(),
    returnDisplay: {
      summary: `Found ${matchCount} ${matchTerm}${wasTruncated ? ' (limited)' : ''}`,
      matches: pageMatches
        .filter((m) => !m.isContext)
        .map((m) => ({
          filePath: m.filePath,
          absolutePath: m.absolutePath,
          lineNumber: m.lineNumber,
          line: m.line,
        })),
    },
  };
}
