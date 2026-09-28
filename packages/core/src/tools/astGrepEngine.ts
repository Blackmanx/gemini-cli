/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import ignorePkg, { type Ignore } from 'ignore';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import picomatch from 'picomatch';
import { loadWasmBinary } from '../utils/fileUtils.js';
import { initializeShellParsers } from '../utils/shell-utils.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * `ignore` ships a CommonJS build whose default export is the factory
 * function itself, but whose typings resolve to the module namespace under
 * `nodenext`. The call is therefore narrowed through a guard instead of being
 * asserted, so a bundler that hands over a real namespace fails loudly at the
 * first search instead of silently filtering nothing.
 */
const ignoreModule: unknown = ignorePkg;

function isIgnoreFactory(value: unknown): value is () => Ignore {
  return typeof value === 'function';
}

function createIgnore(base?: Ignore, patterns?: readonly string[]): Ignore {
  if (!isIgnoreFactory(ignoreModule)) {
    throw new Error('the `ignore` package did not export a filter factory');
  }
  const filter = base === undefined ? ignoreModule() : ignoreModule().add(base);
  return patterns === undefined ? filter : filter.add(patterns);
}

/** Matches returned when the caller does not ask for a specific limit. */
export const DEFAULT_AST_LIMIT = 50;

/** Hard cap on diagnostics (parse errors, unsupported languages) per result. */
export const PARSE_ERROR_LIMIT = 20;

/** A single structural match inside one file. */
export interface AstMatch {
  /** Path relative to the search root, or the basename for a single-file search. */
  readonly file: string;
  /** 1-based line of the first character of the match. */
  readonly startLine: number;
  /** 1-based tree-sitter column of the first character of the match. */
  readonly startColumn: number;
  /** 1-based line of the last character of the match. */
  readonly endLine: number;
  /** 1-based tree-sitter column just past the last character of the match. */
  readonly endColumn: number;
  /** Exact source text of the matched node. */
  readonly text: string;
  /**
   * Metavariable bindings for this match, keyed by the name used in the
   * pattern without its leading `$`. Absent when the pattern binds nothing.
   */
  readonly metaVariables?: Record<string, string>;
}

/** Input for one {@link searchAst} call. */
export interface AstSearchOptions {
  /** The ast-grep pattern, e.g. `rm -rf $DIR`. */
  readonly pattern: string;
  /** File or directory to search. A directory is walked recursively. */
  readonly root: string;
  /** Force a language instead of inferring it per file from the extension. */
  readonly lang?: string;
  /** Maximum matches to return after `skip`. Defaults to 50. */
  readonly limit?: number;
  /** Number of leading matches to drop. Defaults to 0. */
  readonly skip?: number;
  readonly signal?: AbortSignal;
  /**
   * Walk into `node_modules`. Off by default; the tool turns it on when the
   * caller's search path names that directory.
   */
  readonly includeNodeModules?: boolean;

  /**
   * Glob matched against each candidate's path relative to `root`, in the
   * recursive-wildcard form produced by `parseFindPattern`. A single star
   * stays within one path segment; a double star recurses. Omit to accept
   * every file.
   */
  readonly glob?: string;
}

/** Outcome of one {@link searchAst} call. */
export interface AstSearchResult {
  readonly matches: AstMatch[];
  /** Non-fatal diagnostics, capped at {@link PARSE_ERROR_LIMIT}. */
  readonly parseErrors: string[];
  /** True when more matches existed than `skip + limit`. */
  readonly truncated: boolean;
  /** Files actually parsed with a grammar. */
  readonly scannedFiles: number;
  /** Languages that work today, i.e. have an installed grammar. */
  readonly supportedLanguages: string[];
}

// --- language table ---------------------------------------------------------

/**
 * One row of the language table. Adding a grammar is a one-line change: add
 * its WASM package to `dependencies`, then replace `loadWasm: null` with a
 * loader shaped like {@link loadBashGrammarWasm}.
 */
interface LanguageSpec {
  /** Canonical name accepted by `lang` and reported back to the caller. */
  readonly language: string;
  readonly aliases: readonly string[];
  /** Lower-case extensions (with the leading dot) that imply this language. */
  readonly extensions: readonly string[];
  /** Exact basenames for extension-less files such as `.bashrc`. */
  readonly filenames: readonly string[];
  /** `null` means the language is declared but has no grammar installed. */
  readonly loadWasm: (() => Promise<Uint8Array>) | null;
}

function loadBashGrammarWasm(): Promise<Uint8Array> {
  return loadWasmBinary(
    () =>
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore resolved by esbuild-plugin-wasm during bundling
      import('tree-sitter-bash/tree-sitter-bash.wasm?binary'),
    'tree-sitter-bash/tree-sitter-bash.wasm',
  );
}

const LANGUAGE_TABLE: readonly LanguageSpec[] = [
  {
    language: 'bash',
    aliases: ['sh', 'shell', 'zsh'],
    extensions: ['.sh', '.bash', '.zsh', '.bashrc', '.zshrc'],
    filenames: ['.bashrc', '.bash_profile', '.zshrc', '.profile'],
    loadWasm: loadBashGrammarWasm,
  },
  {
    language: 'c',
    aliases: [],
    extensions: ['.c', '.h'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'cpp',
    aliases: ['c++'],
    extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'css',
    aliases: [],
    extensions: ['.css', '.scss'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'go',
    aliases: ['golang'],
    extensions: ['.go'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'html',
    aliases: [],
    extensions: ['.htm', '.html'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'java',
    aliases: [],
    extensions: ['.java'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'javascript',
    aliases: ['js', 'mjs', 'cjs'],
    extensions: ['.cjs', '.js', '.mjs'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'json',
    aliases: [],
    extensions: ['.json'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'markdown',
    aliases: ['md'],
    extensions: ['.markdown', '.md'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'python',
    aliases: ['py'],
    extensions: ['.py'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'ruby',
    aliases: ['rb'],
    extensions: ['.rb'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'rust',
    aliases: ['rs'],
    extensions: ['.rs'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'tsx',
    aliases: [],
    extensions: ['.tsx'],
    filenames: [],

    loadWasm: null,
  },
  {
    language: 'typescript',
    aliases: ['ts'],
    extensions: ['.cts', '.mts', '.ts'],
    filenames: [],
    loadWasm: null,
  },
  {
    language: 'yaml',
    aliases: ['yml'],
    extensions: ['.yaml', '.yml'],
    filenames: [],
    loadWasm: null,
  },
];

const LANGUAGE_BY_NAME: Record<string, LanguageSpec> = {};
const LANGUAGE_BY_EXTENSION: Record<string, LanguageSpec> = {};
const LANGUAGE_BY_FILENAME: Record<string, LanguageSpec> = {};

for (const spec of LANGUAGE_TABLE) {
  LANGUAGE_BY_NAME[spec.language] = spec;
  for (const alias of spec.aliases) {
    LANGUAGE_BY_NAME[alias] = spec;
  }
  for (const extension of spec.extensions) {
    LANGUAGE_BY_EXTENSION[extension] = spec;
  }
  for (const filename of spec.filenames) {
    LANGUAGE_BY_FILENAME[filename] = spec;
  }
}

/** Canonical languages that have a grammar WASM installed and can be parsed. */
export function availableLanguages(): string[] {
  return LANGUAGE_TABLE.filter((spec) => spec.loadWasm !== null).map(
    (spec) => spec.language,
  );
}

/** Every language name the engine recognises, installed or not. */
export function knownLanguages(): string[] {
  return LANGUAGE_TABLE.map((spec) => spec.language);
}

/** True when `lang` names a language the table knows, installed or not. */
export function isLanguageKnown(lang: string): boolean {
  return LANGUAGE_BY_NAME[lang.trim().toLowerCase()] !== undefined;
}

/** True when `lang` names a language whose grammar is actually installed. */
export function isLanguageSupported(lang: string): boolean {
  const spec = LANGUAGE_BY_NAME[lang.trim().toLowerCase()];
  return spec !== undefined && spec.loadWasm !== null;
}

function languageForFile(filePath: string): LanguageSpec | undefined {
  const base = path.basename(filePath).toLowerCase();
  const byBasename = LANGUAGE_BY_FILENAME[base];
  if (byBasename !== undefined) {
    return byBasename;
  }
  const extension = path.extname(base);
  if (extension.length === 0) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[extension];
}

// --- grammar loading --------------------------------------------------------

/**
 * Runtime cache keyed by language name: the WASM grammar is loaded and the
 * parser allocated once per process.
 */
const parserCache = new Map<string, Promise<Parser>>();

/**
 * `Parser.init` installs a process-global WASM runtime and is not re-entrant.
 * `initializeShellParsers()` performs that single init; this only adds a
 * grammar to the already-initialised runtime.
 */
function getParser(spec: LanguageSpec): Promise<Parser> {
  const cached = parserCache.get(spec.language);
  if (cached !== undefined) {
    return cached;
  }
  const loadWasm = spec.loadWasm;
  if (loadWasm === null) {
    return Promise.reject(
      new Error(
        `language "${spec.language}" has no tree-sitter grammar installed`,
      ),
    );
  }
  const pending = (async () => {
    await initializeShellParsers();
    const language = await Language.load(await loadWasm());
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  parserCache.set(spec.language, pending);
  const forget = (): void => {
    if (parserCache.get(spec.language) === pending) {
      parserCache.delete(spec.language);
    }
  };
  pending.then(forget, forget);
  return pending;
}

// --- pattern compilation ----------------------------------------------------

const PLACEHOLDER_PREFIX = '__astg_v1_';
const PLACEHOLDER_SUFFIX = '__';
const METAVARIABLE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)/;

/** A pattern the engine could not turn into a matcher. */
class AstPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AstPatternError';
  }
}

interface RawMetavariable {
  /** The literal text in the pattern, e.g. `$DIR`. */
  readonly raw: string;
  /** The name without the `$`, e.g. `DIR`. */
  readonly name: string;
  /** Stand-in identifier substituted into the text before parsing. */
  readonly placeholder: string;
}

interface PatternScanSuccess {
  readonly ok: true;
  readonly substituted: string;
  readonly variables: readonly RawMetavariable[];
}

interface PatternScanFailure {
  readonly ok: false;
  readonly reason: string;
}

type PatternScan = PatternScanSuccess | PatternScanFailure;

/**
 * Rewrite ast-grep metavariables into identifiers the target grammar accepts.
 *
 * `$$` and `$(` stay literal (the pid and command-substitution operators in
 * bash). `$$$` is rejected: matching zero-or-more nodes needs a real pattern
 * engine, and pretending otherwise is worse than saying no.
 */
function scanMetavariables(pattern: string): PatternScan {
  if (pattern.includes('$$$')) {
    return {
      ok: false,
      reason:
        '`$$$` / `$$$NAME` (zero-or-more-node metavariables) is not supported; use `$NAME` for a single node',
    };
  }

  const variables: RawMetavariable[] = [];
  const byName = new Map<string, RawMetavariable>();
  let substituted = '';
  let index = 0;

  while (index < pattern.length) {
    if (pattern[index] !== '$') {
      substituted += pattern[index];
      index += 1;
      continue;
    }

    const rest = pattern.slice(index);
    if (rest.startsWith('$$') || rest.startsWith('$(')) {
      substituted += rest.slice(0, 2);
      index += 2;
      continue;
    }

    const nameMatch = METAVARIABLE_PATTERN.exec(rest);
    if (nameMatch === null) {
      substituted += '$';
      index += 1;
      continue;
    }

    const name = nameMatch[1];
    const existing = byName.get(name);
    if (existing !== undefined) {
      // A repeated name must match identical code, so it must map to the same
      // placeholder and be compared by the binder.
      substituted += existing.placeholder;
    } else {
      const created: RawMetavariable = {
        raw: `$${name}`,
        name: name === '_' ? `anonymous_${variables.length}` : name,
        placeholder: `${PLACEHOLDER_PREFIX}${variables.length}_${name}${PLACEHOLDER_SUFFIX}`,
      };
      byName.set(name, created);
      variables.push(created);
      substituted += created.placeholder;
    }
    index += nameMatch[0].length;
  }

  return { ok: true, substituted, variables };
}

/** A compiled pattern node: mirrors the shape the matcher walks. */
interface PatternNode {
  readonly type: string;
  /** Metavariable name when this node IS the binding, otherwise null. */
  readonly metavariable: string | null;
  /** True when this node or any descendant binds a metavariable. */
  readonly hasMetavariable: boolean;
  readonly text: string;
  readonly children: readonly PatternNode[];
}

/** Comments are extras in tree-sitter; they never take part in matching. */
function isMatchableChild(node: Node | null): node is Node {
  return node !== null && !node.isExtra;
}

function significantChildCount(node: Node): number {
  let count = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    if (isMatchableChild(node.child(index))) {
      count += 1;
    }
  }
  return count;
}

function significantChildAt(node: Node, wanted: number): Node | null {
  let seen = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!isMatchableChild(child)) {
      continue;
    }
    if (seen === wanted) {
      return child;
    }
    seen += 1;
  }
  return null;
}

function buildPatternNode(
  node: Node,
  placeholders: Record<string, string>,
  bound: Set<string>,
): PatternNode {
  const text = node.text;
  const metavariable = placeholders[text];
  if (metavariable !== undefined) {
    bound.add(text);
    return {
      type: node.type,
      metavariable,
      hasMetavariable: true,
      text,
      children: [],
    };
  }

  const children: PatternNode[] = [];
  let hasMetavariable = false;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (!isMatchableChild(child)) {
      continue;
    }
    const built = buildPatternNode(child, placeholders, bound);
    hasMetavariable = hasMetavariable || built.hasMetavariable;
    children.push(built);
  }

  return {
    type: node.type,
    metavariable: null,
    hasMetavariable,
    text,
    children,
  };
}

function compilePattern(
  spec: LanguageSpec,
  parser: Parser,
  pattern: string,
): PatternNode {
  const scan = scanMetavariables(pattern);
  if (!scan.ok) {
    throw new AstPatternError(scan.reason);
  }

  const tree = parser.parse(scan.substituted);
  if (tree === null) {
    throw new AstPatternError(
      `could not parse the pattern for ${spec.language}`,
    );
  }
  if (tree.rootNode.hasError) {
    tree.delete();
    throw new AstPatternError(
      `pattern is not valid ${spec.language} code: ${pattern}`,
    );
  }

  const placeholders: Record<string, string> = {};
  for (const variable of scan.variables) {
    placeholders[variable.placeholder] = variable.name;
  }
  const bound = new Set<string>();
  const parsed = buildPatternNode(tree.rootNode, placeholders, bound);
  tree.delete();

  const unbound = scan.variables.filter(
    (variable) => !bound.has(variable.placeholder),
  );
  if (unbound.length > 0) {
    throw new AstPatternError(
      `${unbound
        .map((variable) => variable.raw)
        .join(', ')} must stand for a whole AST node, not part of a token`,
    );
  }

  // A one-statement pattern parses to a whole translation unit
  // (`program > command`), which would only ever match a file containing
  // nothing else. Step down to the statement so the pattern means what the
  // caller wrote; a multi-statement pattern keeps matching whole units.
  const onlyChild =
    parsed.children.length === 1 ? parsed.children[0] : undefined;
  return onlyChild ?? parsed;
}

// --- matching ---------------------------------------------------------------

function normalizeSource(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function matchPattern(
  pattern: PatternNode,
  target: Node,
  bindings: Record<string, string>,
): boolean {
  if (pattern.metavariable !== null) {
    const existing = bindings[pattern.metavariable];
    if (existing === undefined) {
      bindings[pattern.metavariable] = target.text;
      return true;
    }
    return existing === target.text;
  }
  if (pattern.type !== target.type) {
    return false;
  }
  // A pattern subtree with no bindings is fully literal: text equality is both
  // necessary and sufficient, and keeps the common case cheap.
  if (!pattern.hasMetavariable) {
    return normalizeSource(pattern.text) === normalizeSource(target.text);
  }
  if (significantChildCount(target) !== pattern.children.length) {
    return false;
  }
  for (let index = 0; index < pattern.children.length; index += 1) {
    const patternChild = pattern.children[index];
    const targetChild = significantChildAt(target, index);
    if (patternChild === undefined || targetChild === null) {
      return false;
    }
    if (!matchPattern(patternChild, targetChild, bindings)) {
      return false;
    }
  }
  return true;
}

function toMatch(
  target: Node,
  file: string,
  bindings: Record<string, string>,
): AstMatch {
  const names = Object.keys(bindings);
  return {
    file,
    startLine: target.startPosition.row + 1,
    startColumn: target.startPosition.column + 1,
    endLine: target.endPosition.row + 1,
    endColumn: target.endPosition.column + 1,
    text: target.text,
    ...(names.length > 0 ? { metaVariables: { ...bindings } } : {}),
  };
}

/** Depth-first sweep that tries the pattern at every node of a given type. */
function collectMatches(
  root: Node,
  pattern: PatternNode,
  file: string,
  budget: number,
  out: AstMatch[],
): void {
  const cursor = root.walk();
  let finished = false;
  while (!finished && out.length < budget) {
    if (cursor.nodeType === pattern.type) {
      const bindings: Record<string, string> = {};
      if (matchPattern(pattern, cursor.currentNode, bindings)) {
        out.push(toMatch(cursor.currentNode, file, bindings));
      }
    }
    if (cursor.gotoFirstChild()) {
      continue;
    }
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        finished = true;
        break;
      }
    }
  }
  cursor.delete();
}

// --- file walking -----------------------------------------------------------

interface CandidateFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface DirectoryFrame {
  readonly dir: string;
  readonly ignoreFilter: Ignore;
}

function baseIgnoreFilter(includeNodeModules: boolean): Ignore {
  const patterns = ['.git/'];
  if (!includeNodeModules) {
    patterns.push('node_modules/');
  }
  return createIgnore(undefined, patterns);
}

async function readIgnoreFile(directory: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(directory, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
}

function isIgnored(ignoreFilter: Ignore, relativePath: string): boolean {
  return (
    ignoreFilter.ignores(relativePath) ||
    ignoreFilter.ignores(`${relativePath}/`)
  );
}

/** Depth-first, name-sorted walk of a directory, honouring nested `.gitignore`. */
async function* walkDirectory(
  root: string,
  includeNodeModules: boolean,
): AsyncGenerator<CandidateFile> {
  const stack: DirectoryFrame[] = [
    { dir: root, ignoreFilter: baseIgnoreFilter(includeNodeModules) },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(frame.dir, { withFileTypes: true });
    } catch (error) {
      debugLogger.debug(`ast-grep: cannot read directory ${frame.dir}`, error);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    // The frame's filter is final once its own `.gitignore` has been folded in,
    // so children may share it; a directory with its own file gets a child copy.
    const gitignore = await readIgnoreFile(frame.dir);
    const childFilter =
      gitignore === null
        ? frame.ignoreFilter
        : createIgnore(frame.ignoreFilter, [gitignore]);

    const subdirectories: string[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(frame.dir, entry.name);
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join('/');
      if (isIgnored(childFilter, relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        subdirectories.push(absolutePath);
      } else if (entry.isFile()) {
        yield { absolutePath, relativePath };
      }
    }

    // Reversed so the LIFO stack pops them back in sorted order.
    for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
      const subdirectory = subdirectories[index];
      if (subdirectory !== undefined) {
        stack.push({ dir: subdirectory, ignoreFilter: childFilter });
      }
    }
  }
}

async function* iterateCandidateFiles(
  root: string,
  includeNodeModules: boolean,
  glob: string | undefined,
): AsyncGenerator<CandidateFile> {
  let stats;
  try {
    stats = await fs.stat(root);
  } catch {
    return;
  }
  if (stats.isFile()) {
    yield { absolutePath: root, relativePath: path.basename(root) };
    return;
  }
  for await (const file of walkDirectory(root, includeNodeModules)) {
    if (
      glob !== undefined &&
      !picomatch.isMatch(file.relativePath, glob, { dot: true })
    ) {
      continue;
    }
    yield file;
  }
}

// --- public search ----------------------------------------------------------

const PARSE_TIMEOUT_MICROS = 10_000_000; // 10 seconds

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_AST_LIMIT;
  }
  return Math.max(1, Math.floor(limit));
}

function clampSkip(skip: number | undefined): number {
  if (skip === undefined) {
    return 0;
  }
  return Math.max(0, Math.floor(skip));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSource(
  parser: Parser,
  source: string,
  relativePath: string,
): { readonly tree: Tree | null; readonly timedOut: boolean } {
  const deadline = performance.now() + PARSE_TIMEOUT_MICROS / 1000;
  let timedOut = false;
  const tree = parser.parse(source, null, {
    progressCallback: () => {
      if (performance.now() > deadline) {
        timedOut = true;
        return true;
      }
      return undefined;
    },
  });
  if (timedOut) {
    debugLogger.debug(`ast-grep: parse timeout for ${relativePath}`);
  }
  return { tree, timedOut };
}

/** Parser plus compiled pattern for one language, compiled at most once. */
interface CompiledSearch {
  readonly parser: Parser;
  readonly pattern: PatternNode;
}

/**
 * Structural search over the tree under `root`.
 *
 * Never throws for a bad pattern: a pattern that does not parse, uses an
 * unsupported feature, or names a language without a grammar comes back in
 * `parseErrors` with an empty `matches` list.
 */
export async function searchAst(
  options: AstSearchOptions,
): Promise<AstSearchResult> {
  const limit = clampLimit(options.limit);
  const skip = clampSkip(options.skip);
  const budget = skip + limit + 1;
  const diagnostics: string[] = [];
  const seenDiagnostics = new Set<string>();
  const unsupported = new Map<string, number>();
  const matches: AstMatch[] = [];
  let scannedFiles = 0;

  const finish = (): AstSearchResult => {
    const unsupportedLines = Array.from(unsupported.entries()).map(
      ([language, count]) =>
        `language "${language}" has no tree-sitter grammar installed; skipped ${count} file(s)`,
    );
    const room = Math.max(0, PARSE_ERROR_LIMIT - unsupportedLines.length);
    return {
      matches: matches.slice(skip, skip + limit),
      parseErrors: [...unsupportedLines, ...diagnostics.slice(0, room)],
      truncated: matches.length > skip + limit,
      scannedFiles,
      supportedLanguages: availableLanguages(),
    };
  };

  let forcedSpec: LanguageSpec | undefined;
  if (options.lang !== undefined) {
    const requested = LANGUAGE_BY_NAME[options.lang.trim().toLowerCase()];
    if (requested === undefined) {
      diagnostics.push(
        `pattern: unknown language "${options.lang}"; known languages: ${knownLanguages().join(', ')}`,
      );
      return finish();
    }
    if (requested.loadWasm === null) {
      diagnostics.push(
        `pattern: language "${requested.language}" has no tree-sitter grammar installed; available: ${availableLanguages().join(', ')}`,
      );
      return finish();
    }
    forcedSpec = requested;
  }

  const compiledByLanguage = new Map<string, Promise<CompiledSearch>>();

  for await (const file of iterateCandidateFiles(
    options.root,
    options.includeNodeModules === true,
    options.glob,
  )) {
    if (options.signal?.aborted === true) {
      throw new Error('Aborted: Signal');
    }

    const spec = forcedSpec ?? languageForFile(file.relativePath);
    if (spec === undefined) {
      continue;
    }
    if (spec.loadWasm === null) {
      unsupported.set(spec.language, (unsupported.get(spec.language) ?? 0) + 1);
      continue;
    }

    let compiled: CompiledSearch;
    try {
      const pending = compiledByLanguage.get(spec.language);
      if (pending === undefined) {
        const created = getParser(spec).then((parser) => ({
          parser,
          pattern: compilePattern(spec, parser, options.pattern),
        }));
        compiledByLanguage.set(spec.language, created);
        compiled = await created;
      } else {
        compiled = await pending;
      }
    } catch (error) {
      const message = `pattern: ${describeError(error)}`;
      if (!seenDiagnostics.has(message)) {
        seenDiagnostics.add(message);
        diagnostics.push(message);
      }
      continue;
    }

    let source: string;
    try {
      source = await fs.readFile(file.absolutePath, 'utf8');
    } catch (error) {
      debugLogger.debug(`ast-grep: cannot read ${file.absolutePath}`, error);
      continue;
    }

    const { tree, timedOut } = parseSource(
      compiled.parser,
      source,
      file.relativePath,
    );
    if (tree === null) {
      diagnostics.push(`${file.relativePath}: could not be parsed`);
      continue;
    }
    scannedFiles += 1;
    if (timedOut) {
      diagnostics.push(`${file.relativePath}: parse timed out`);
    } else if (tree.rootNode.hasError) {
      diagnostics.push(
        `${file.relativePath}: parse error (syntax tree contains error nodes)`,
      );
    }

    collectMatches(
      tree.rootNode,
      compiled.pattern,
      file.relativePath,
      budget,
      matches,
    );
    tree.delete();

    if (matches.length >= budget) {
      break;
    }
  }

  return finish();
}
