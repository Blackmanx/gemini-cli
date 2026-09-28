/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rule importers for foreign agent configuration formats.
 *
 * Every importer is a pure read: it parses a well-known on-disk format into
 * {@link DiscoveredRule} and never mutates settings or the filesystem. A file
 * whose frontmatter is malformed is skipped with a logged warning rather than
 * aborting the importer, because one hand-edited rule must not cost the user
 * every other rule in the same directory.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { debugLogger } from '../utils/debugLogger.js';
import { isRecord } from '../utils/markdownUtils.js';
import type { DiscoveredRule } from './types.js';

/** A leading `---` fenced block, closed by a `---` line. */
const FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?/;

/** Raised when a frontmatter block is present but is not usable YAML. */
class MalformedFrontmatterError extends Error {}

/** A rule file after frontmatter stripping. */
interface ParsedRuleFile {
  data: Record<string, unknown>;
  body: string;
}

/** Everything an importer decides about one file beyond its frontmatter. */
interface RuleFileSpec {
  /** Absolute path of the markdown file. */
  filePath: string;
  /** Rule name, after the importer's filename suffix is stripped. */
  name: string;
  /** Importer id; becomes the rule's `source` and id prefix. */
  source: string;
  /**
   * `alwaysApply` used when the file carries no `alwaysApply` frontmatter.
   * Formats whose files are unconditional context (`.clinerules`, `CLAUDE.md`,
   * `copilot-instructions.md`) pass `true`; glob-scoped formats (Cursor MDC,
   * Copilot `*.instructions.md`) pass `false`.
   */
  defaultAlwaysApply: boolean;
  /**
   * Globs the importer resolved itself, e.g. GitHub's `applyTo`. When present
   * (including as an empty array) it wins over frontmatter `globs`.
   */
  globs?: string[];
  /** Description used when the file declares none. */
  fallbackDescription?: string;
}

/**
 * Read a UTF-8 text file, resolving to `undefined` when it is absent or
 * unreadable. Discovery treats both the same way: nothing to contribute.
 */
export async function readTextFileIfPresent(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Normalise a frontmatter field that foreign tools spell either as a YAML list
 * or as a comma-separated string.
 */
function parseGlobField(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) =>
    typeof entry === 'string'
      ? entry
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [],
  );
}

/** Normalise a boolean frontmatter field, tolerating quoted `"true"`/`"false"`. */
function parseBooleanField(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

/**
 * Split a rule file into its frontmatter mapping and its body. A file with no
 * frontmatter block is all body. A block that is not a YAML mapping throws
 * {@link MalformedFrontmatterError} so the caller can skip just this file.
 */
function parseRuleFile(content: string, filePath: string): ParsedRuleFile {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return { data: {}, body: content.trim() };
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(match[1] ?? '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MalformedFrontmatterError(
      `${filePath}: invalid YAML frontmatter (${reason})`,
    );
  }

  if (parsed === undefined || parsed === null) {
    return { data: {}, body: (match[2] ?? '').trim() };
  }
  if (!isRecord(parsed)) {
    throw new MalformedFrontmatterError(
      `${filePath}: frontmatter is not a key/value mapping`,
    );
  }
  return { data: parsed, body: (match[2] ?? '').trim() };
}

/**
 * Read one file into a rule. A file whose frontmatter is malformed is logged
 * and skipped; `load()` cannot carry a note, so the log is the whole channel.
 */
async function readRuleFile(
  spec: RuleFileSpec,
): Promise<DiscoveredRule | undefined> {
  const content = await readTextFileIfPresent(spec.filePath);
  if (content === undefined) {
    return undefined;
  }

  let parsed: ParsedRuleFile;
  try {
    parsed = parseRuleFile(content, spec.filePath);
  } catch (error) {
    if (!(error instanceof MalformedFrontmatterError)) {
      throw error;
    }
    debugLogger.warn(`[discovery] Skipped rule: ${error.message}`);
    return undefined;
  }

  if (parseBooleanField(parsed.data['enabled']) === false) {
    return undefined;
  }

  const declared = parsed.data['description'];
  const description =
    typeof declared === 'string' && declared.length > 0
      ? declared
      : spec.fallbackDescription;

  return {
    name: spec.name,
    path: spec.filePath,
    content: parsed.body,
    globs: spec.globs ?? parseGlobField(parsed.data['globs']),
    alwaysApply:
      parseBooleanField(parsed.data['alwaysApply']) ?? spec.defaultAlwaysApply,
    ...(description !== undefined && { description }),
    source: spec.source,
    id: `rule:${spec.source}:${spec.name}`,
  };
}

/**
 * List files directly in `dir` (optionally recursing) whose name satisfies
 * `matches`. Returns absolute paths in a stable order; an unreadable directory
 * simply contributes nothing.
 */
async function listFiles(
  dir: string,
  matches: (name: string) => boolean,
  recursive: boolean,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        found.push(...(await listFiles(entryPath, matches, recursive)));
      }
      continue;
    }
    if (entry.isFile() && matches(entry.name)) {
      found.push(entryPath);
    }
  }
  return found;
}

/**
 * Cursor: `.cursor/rules/*.mdc` (and `.md`), each with a YAML frontmatter block
 * carrying `description`, `globs` and `alwaysApply`.
 *
 * A Cursor rule is inlined only when the author set `alwaysApply: true`;
 * everything else stays in the rulebook behind its globs, because Cursor itself
 * only injects glob-matched rules for the files being edited.
 */
export async function loadCursorRules(
  targetDir: string,
): Promise<DiscoveredRule[]> {
  const filePaths = await listFiles(
    path.resolve(targetDir, '.cursor', 'rules'),
    (name) => name.endsWith('.mdc') || name.endsWith('.md'),
    false,
  );

  const rules: DiscoveredRule[] = [];
  for (const filePath of filePaths) {
    const rule = await readRuleFile({
      filePath,
      name: path.basename(filePath).replace(/\.(mdc|md)$/, ''),
      source: 'cursor',
      defaultAlwaysApply: false,
      fallbackDescription: 'Cursor rule',
    });
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

/** Walk up from `startDir` looking for a `.clinerules` entry. */
async function findClineRules(
  startDir: string,
): Promise<{ filePath: string; isDirectory: boolean } | undefined> {
  let current = path.resolve(startDir);
  for (;;) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const found = entries.find((entry) => entry.name === '.clinerules');
    if (found) {
      return {
        filePath: path.join(current, '.clinerules'),
        isDirectory: found.isDirectory(),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Cline: `.clinerules` as either a single file or a directory of `*.md`.
 *
 * Cline injects its rules file unconditionally, so every file it owns is an
 * always-apply rule. Frontmatter `alwaysApply: false` still downgrades one, and
 * frontmatter `enabled: false` still drops it.
 */
export async function loadClineRules(
  targetDir: string,
): Promise<DiscoveredRule[]> {
  const found = await findClineRules(targetDir);
  if (!found) {
    return [];
  }

  const filePaths = found.isDirectory
    ? await listFiles(found.filePath, (name) => name.endsWith('.md'), false)
    : [found.filePath];

  const rules: DiscoveredRule[] = [];
  for (const filePath of filePaths) {
    const rule = await readRuleFile({
      filePath,
      name: found.isDirectory
        ? path.basename(filePath).replace(/\.md$/, '')
        : 'clinerules',
      source: 'cline',
      defaultAlwaysApply: true,
      fallbackDescription: 'Cline rules',
    });
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

/**
 * GitHub: `.github/copilot-instructions.md` plus
 * `.github/instructions/` recursively, taking every `.instructions.md` file.
 *
 * `copilot-instructions.md` is repository-wide, so it is always applied. An
 * `*.instructions.md` file is always applied only when its `applyTo` covers
 * every file; otherwise it is scoped to the `applyTo` globs, which GitHub
 * documents as one comma-separated string but which is often written as a YAML
 * list. A file with no `applyTo` is reported in the log so the user knows it
 * is unscoped rather than glob-matched.
 */
export async function loadGitHubRules(
  targetDir: string,
): Promise<DiscoveredRule[]> {
  const githubDir = path.resolve(targetDir, '.github');
  const rules: DiscoveredRule[] = [];

  const repoWide = await readRuleFile({
    filePath: path.join(githubDir, 'copilot-instructions.md'),
    name: 'copilot-instructions',
    source: 'github',
    defaultAlwaysApply: true,
    globs: [],
    fallbackDescription: 'GitHub Copilot repository-wide instructions',
  });
  if (repoWide) {
    rules.push(repoWide);
  }

  const instructionFiles = await listFiles(
    path.join(githubDir, 'instructions'),
    (name) => name.endsWith('.instructions.md'),
    true,
  );

  for (const filePath of instructionFiles) {
    const content = await readTextFileIfPresent(filePath);
    if (content === undefined) {
      continue;
    }

    let parsed: ParsedRuleFile;
    try {
      parsed = parseRuleFile(content, filePath);
    } catch (error) {
      if (!(error instanceof MalformedFrontmatterError)) {
        throw error;
      }
      debugLogger.warn(`[discovery] Skipped rule: ${error.message}`);
      continue;
    }

    if (parseBooleanField(parsed.data['enabled']) === false) {
      continue;
    }

    const name = path.basename(filePath).replace(/\.instructions\.md$/, '');
    const applyTo = parseGlobField(parsed.data['applyTo']);
    // GitHub treats "*", "**" and "**/*" as matching every file.
    const alwaysApply = applyTo.some(
      (glob) => glob === '*' || glob === '**' || glob === '**/*',
    );
    if (applyTo.length === 0) {
      const message = `${filePath} has no applyTo; loaded unscoped.`;
      debugLogger.warn(`[discovery] ${message}`);
    }

    const declared = parsed.data['description'];
    rules.push({
      name,
      path: filePath,
      content: parsed.body,
      globs: alwaysApply ? [] : applyTo,
      alwaysApply,
      description:
        typeof declared === 'string' && declared.length > 0
          ? declared
          : applyTo.length === 0
            ? 'GitHub Copilot instructions without applyTo metadata'
            : `GitHub Copilot instructions for ${applyTo.join(', ')}`,
      source: 'github',
      id: `rule:github:${name}`,
    });
  }

  return rules;
}

/**
 * Claude Code: `.claude/CLAUDE.md`, the unconditional project memory file that
 * Claude Code itself injects on every request.
 */
export async function loadClaudeRules(
  targetDir: string,
): Promise<DiscoveredRule[]> {
  const rule = await readRuleFile({
    filePath: path.resolve(targetDir, '.claude', 'CLAUDE.md'),
    name: 'claude',
    source: 'claude',
    defaultAlwaysApply: true,
    globs: [],
    fallbackDescription: 'Claude Code project instructions',
  });
  return rule ? [rule] : [];
}
