/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getFilePriority, isLockFile } from './filePriority.js';
import { assignLockFilesToPlan } from './lockFiles.js';
import { orderCommitSteps, type CommitStep } from './topoSort.js';

export type { CommitStep } from './topoSort.js';

/** One commit in a split plan, ready for the user to review or apply. */
export interface ProposedStep {
  /** Stable identifier, unique within the plan. */
  id: string;
  /** Human readable name shown while the plan is reviewed. */
  label: string;
  /** Conventional-commit subject line. */
  message: string;
  /** Repository-relative paths staged by this commit. */
  files: string[];
}

/** A complete split-commit plan plus the changes deliberately held out of it. */
export interface SplitPlan {
  /** Commits in dependency order. */
  steps: ProposedStep[];
  /**
   * Changed files that no commit stages: lock files (which are attached to a
   * commit by rule after grouping, and listed here so the caller can say so)
   * and machine-generated artifacts.
   */
  excluded: string[];
}

type Bucket = 'source' | 'test' | 'docs' | 'style' | 'config';

const BUCKET_TYPE: Readonly<Record<Bucket, string>> = {
  source: 'refactor',
  test: 'test',
  docs: 'docs',
  style: 'style',
  config: 'chore',
};

const BUCKET_VERB: Readonly<Record<Bucket, string>> = {
  source: 'refactored',
  test: 'updated tests for',
  docs: 'updated documentation for',
  style: 'formatted',
  config: 'updated',
};

const BUCKET_LABEL: Readonly<Record<Bucket, string>> = {
  source: 'Source',
  test: 'Tests',
  docs: 'Documentation',
  style: 'Styles',
  config: 'Configuration',
};

const TEST_PATTERNS: readonly string[] = [
  '/test/',
  '/tests/',
  '/__tests__/',
  '_test.',
  '.test.',
  '.spec.',
  '_spec.',
];

const DOC_EXTENSIONS: Readonly<Record<string, true>> = {
  '.md': true,
  '.txt': true,
  '.rst': true,
  '.adoc': true,
};

const CONFIG_EXTENSIONS: Readonly<Record<string, true>> = {
  '.json': true,
  '.yaml': true,
  '.yml': true,
  '.toml': true,
  '.xml': true,
  '.ini': true,
  '.cfg': true,
};

const STYLE_EXTENSIONS: Readonly<Record<string, true>> = {
  '.css': true,
  '.scss': true,
  '.less': true,
  '.sass': true,
};

/** Directory segments whose contents are build or vendor output. */
const GENERATED_DIR_SEGMENTS: Readonly<Record<string, true>> = {
  node_modules: true,
  dist: true,
  build: true,
  out: true,
  vendor: true,
  coverage: true,
  target: true,
  __pycache__: true,
  '.next': true,
  '.nuxt': true,
};

/** Basename suffixes for generated code that carries no authorial intent. */
const GENERATED_SUFFIXES: readonly string[] = [
  '.min.js',
  '.min.css',
  '.generated.ts',
  '.generated.js',
  '.pb.go',
  '_pb2.py',
];

const MAX_SUBJECT_LENGTH = 72;
const SOURCE_ID_PREFIX = 'source:';

function splitPath(filePath: string): { dir: string; basename: string } {
  const segments = filePath.split('/');
  const basename = segments.pop() ?? filePath;
  return { dir: segments.join('/'), basename };
}

function extensionOf(basename: string): string {
  if (!basename.includes('.')) {
    return '';
  }
  return `.${basename.split('.').pop() ?? ''}`.toLowerCase();
}

/** True for build output, vendored dependencies and generated sources. */
function isGeneratedFile(filePath: string): boolean {
  const { basename } = splitPath(filePath);
  for (const segment of filePath.split('/')) {
    if (GENERATED_DIR_SEGMENTS[segment] === true) {
      return true;
    }
  }
  const lowerBasename = basename.toLowerCase();
  for (const suffix of GENERATED_SUFFIXES) {
    if (lowerBasename.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a changed file the way omp's mechanical fallback does: tests first,
 * then docs, config, styles, and everything else as source.
 */
function classifyFile(filePath: string): Bucket {
  const lowerPath = filePath.toLowerCase();
  for (const pattern of TEST_PATTERNS) {
    if (lowerPath.includes(pattern)) {
      return 'test';
    }
  }
  const ext = extensionOf(splitPath(filePath).basename);
  if (DOC_EXTENSIONS[ext] === true) {
    return 'docs';
  }
  if (CONFIG_EXTENSIONS[ext] === true) {
    return 'config';
  }
  if (STYLE_EXTENSIONS[ext] === true) {
    return 'style';
  }
  return 'source';
}

/**
 * Commit scope derived from a group key (a source directory, or a bucket
 * name): at most two path segments, matching conventional-commit rules.
 */
function scopeFor(groupKey: string): string {
  const segments = groupKey.split('/').filter((segment) => segment !== '');
  const chosen = segments.length > 2 ? segments.slice(-2) : segments;
  const joined = chosen.join('-').toLowerCase();
  const sanitized = joined.replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
  return sanitized === '' ? 'repo' : sanitized;
}

/** Trim a subject to the conventional-commit line limit on a word boundary. */
function clampSubject(subject: string): string {
  if (subject.length <= MAX_SUBJECT_LENGTH) {
    return subject;
  }
  const clipped = subject.slice(0, MAX_SUBJECT_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return trimmed.replace(/[.,;:]+$/, '');
}

/** omp's fallback summary: the first file plus a count of the rest. */
function describeFiles(bucket: Bucket, files: string[]): string {
  const first = splitPath(files[0]).basename;
  if (files.length === 1) {
    return `${BUCKET_VERB[bucket]} ${first}`;
  }
  return `${BUCKET_VERB[bucket]} ${first} and ${files.length - 1} other${
    files.length === 2 ? '' : 's'
  }`;
}

/** A group of files that will become one commit. */
interface GroupDraft {
  /** Stable id; also the conventional-commit step identifier. */
  id: string;
  /** Which class of change this group represents. */
  bucket: Bucket;
  /** Source directory, or the bucket name for non-source groups. */
  groupKey: string;
  /** Files staged by the group. */
  files: string[];
}

/** Stable step id: `source:<dir>` for code, the bucket name otherwise. */
function draftId(bucket: Bucket, groupKey: string): string {
  return bucket === 'source'
    ? `${SOURCE_ID_PREFIX}${groupKey || 'root'}`
    : bucket;
}

/** Highest {@link getFilePriority} among a step's files. */
function topPriority(files: string[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const file of files) {
    const priority = getFilePriority(file);
    if (priority > best) {
      best = priority;
    }
  }
  return best;
}

function buildDrafts(plannableFiles: string[]): GroupDraft[] {
  const groups = new Map<string, { bucket: Bucket; files: string[] }>();
  for (const file of plannableFiles) {
    const bucket = classifyFile(file);
    const groupKey = bucket === 'source' ? splitPath(file).dir : bucket;
    const existing = groups.get(groupKey);
    if (existing === undefined) {
      groups.set(groupKey, { bucket, files: [file] });
    } else {
      existing.files.push(file);
    }
  }

  const drafts: GroupDraft[] = [];
  for (const [groupKey, group] of groups) {
    drafts.push({
      id: draftId(group.bucket, groupKey),
      bucket: group.bucket,
      groupKey,
      files: group.files,
    });
  }
  return drafts;
}

/**
 * Source commit that covers `dir`: an exact directory match, else the
 * nearest enclosing source directory. Returns `undefined` when the directory
 * holds no source of its own.
 */
function findSourceIdForDir(
  sourceIdByDir: Map<string, string>,
  dir: string,
): string | undefined {
  const segments = dir.split('/');
  for (let end = segments.length; end > 0; end -= 1) {
    const candidate = segments.slice(0, end).join('/');
    const sourceId = sourceIdByDir.get(candidate);
    if (sourceId !== undefined) {
      return sourceId;
    }
  }
  return undefined;
}

function buildSteps(drafts: GroupDraft[]): CommitStep[] {
  const sourceIdByDir = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.bucket === 'source') {
      sourceIdByDir.set(draft.groupKey, draft.id);
    }
  }
  const sourceIds = [...sourceIdByDir.values()];

  const steps: CommitStep[] = drafts.map((draft) => {
    const dependsOn: string[] = [];
    if (draft.bucket === 'test') {
      // A test that lands before the code it exercises cannot be reverted on
      // its own, so every source commit precedes the test commit.
      dependsOn.push(...sourceIds);
    } else if (draft.bucket === 'style') {
      for (const file of draft.files) {
        const sourceId = findSourceIdForDir(sourceIdByDir, splitPath(file).dir);
        if (sourceId !== undefined && !dependsOn.includes(sourceId)) {
          dependsOn.push(sourceId);
        }
      }
    }
    return {
      id: draft.id,
      label:
        draft.bucket === 'source'
          ? `Source in ${draft.groupKey === '' ? 'the repository root' : draft.groupKey}`
          : BUCKET_LABEL[draft.bucket],
      files: draft.files,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    };
  });

  steps.sort((left, right) => {
    const rank = topPriority(right.files) - topPriority(left.files);
    if (rank !== 0) {
      return rank;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return steps;
}

function toProposedStep(step: CommitStep, draft: GroupDraft): ProposedStep {
  const scope = scopeFor(draft.groupKey);
  const subject = `${BUCKET_TYPE[draft.bucket]}(${scope}): ${describeFiles(
    draft.bucket,
    step.files,
  )}`;
  return {
    id: step.id,
    label: step.label,
    message: clampSubject(subject),
    files: step.files,
  };
}

/**
 * Build a split-commit plan from a changed-file list without consulting a
 * model.
 *
 * The grouping rule is mechanical and stable, so the same diff always yields
 * the same plan:
 *   1. lock files and generated artifacts are held back into
 *      {@link SplitPlan.excluded};
 *   2. every remaining file is classified as source, test, docs, style or
 *      config, and each non-source class becomes a single commit — tests,
 *      docs and stylesheets are never interleaved into the code they describe,
 *      because a commit that edits both is a commit nobody can revert;
 *   3. source files are grouped by their containing directory, so a module
 *      lands in one commit instead of being shredded across its own files;
 *   4. groups are ranked by their highest-priority file
 *      ({@link getFilePriority}) and then by id, so implementation source
 *      leads the plan and tests trail it;
 *   5. tests depend on the source they cover, styles depend on the source in
 *      the same directory, and the result is ordered with
 *      {@link orderCommitSteps};
 *   6. the held-back lock files are attached to a commit by
 *      {@link assignLockFilesToPlan}.
 *
 * @param changedFiles Repository-relative paths. Duplicates and input order
 *   are normalized away, so the output depends only on the set of paths.
 * @throws Error if the dependency graph were cyclic, which this grouping
 *   cannot produce.
 */
export function buildCommitPlan(changedFiles: string[]): SplitPlan {
  const uniqueFiles = [...new Set(changedFiles)].sort();

  const lockFiles: string[] = [];
  const generatedFiles: string[] = [];
  const plannableFiles: string[] = [];
  for (const file of uniqueFiles) {
    if (isLockFile(file)) {
      lockFiles.push(file);
    } else if (isGeneratedFile(file)) {
      generatedFiles.push(file);
    } else {
      plannableFiles.push(file);
    }
  }

  const drafts = buildDrafts(plannableFiles);
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
  const steps = orderCommitSteps(buildSteps(drafts));

  const filesByDir = new Map<string, string[]>();
  for (const file of uniqueFiles) {
    const { dir } = splitPath(file);
    const bucketForDir = filesByDir.get(dir);
    if (bucketForDir === undefined) {
      filesByDir.set(dir, [file]);
    } else {
      bucketForDir.push(file);
    }
  }
  const withLockFiles = assignLockFilesToPlan(lockFiles, steps, filesByDir);

  return {
    steps: withLockFiles.flatMap((step) => {
      const draft = draftById.get(step.id);
      if (draft === undefined) {
        return [];
      }
      return [toProposedStep(step, draft)];
    }),
    excluded: [...lockFiles, ...generatedFiles].sort(),
  };
}
