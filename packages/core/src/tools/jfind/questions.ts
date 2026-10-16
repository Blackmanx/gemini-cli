/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The three request shapes the cascade sends to the judge, as a `state` JSON
 * blob plus one probability question per entry.
 *
 * Ported from oh-my-pi's `tools/jfind/questions.ts`. The upstream judge API
 * takes a state object plus native noul questions; a Gemini judge instead
 * gets the same state rendered into one prompt and answers through structured
 * JSON (`{items: [{k, p}]}` — see `judge.ts`), so the questions here are the
 * instruction lines that ride alongside the state. State keys stay in
 * alphabetical order so the wire bytes are stable (and cacheable) across
 * identical searches.
 */
import { type FileEntry, renderTree } from './tree.js';
import { type Passage, plainContent } from './passages.js';

/** One judgment request: a prompt (state + questions) and the keys it must be answered for. */
export interface JudgeRequest {
  prompt: string;
  keys: string[];
}

const TASK =
  'Semantic grep over a source tree: locate files whose content matches the search description. Entries are judged by name, size, position in the tree, and (for folders) a sample of what they contain.';

const TREE_FORMAT =
  '`tree` is a directory listing. Lines starting with # are headers: `# dir/` is a folder; more #s means deeper nesting under the header above; a header may fold several levels (`# a/b/c/`). Every judgeable entry carries a tag like e017 right after the #s: files as `e017 name (size)`. Untagged header lines are only structure.';

const FILE_CRITERIA = {
  // Generated implementation is still implementation. File provenance must
  // not itself be negative evidence for source-code searches.
  no: 'The file is unrelated by name and location; generated executable implementation can still be relevant.',
  yes: 'A file at this path plausibly contains code, text, or data matching the search.',
};

const FOLDER_CRITERIA = {
  no: "Nothing about the folder's name, location, or sampled contents suggests it holds a match.",
  yes: 'The folder plausibly contains, at any depth, at least one file matching the search.',
};

const SKETCH_CRITERIA = {
  no: 'Unrelated code; mere mentions, declarations, call sites, tests or configuration without implementation.',
  yes: 'Likely substantive implementation, definition or explanation of any part of the requested behavior. A matching helper for one step counts. Excerpts omit most source: favor recall.',
};

const PASSAGE_CRITERIA = {
  no: 'This passage only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.',
  yes: 'This passage contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.',
};

/** Question key of the `i`th entry in a filename batch. */
export function entryKey(i: number): string {
  return `e${String(i).padStart(3, '0')}`;
}

/** Question key of the `k`th passage in a sketch or verification batch. */
export function passageKey(k: number): string {
  return `p${String(k).padStart(2, '0')}`;
}

/** The state JSON followed by one instruction line per key, in key order. */
function buildRequest(
  state: Record<string, unknown>,
  questions: Record<string, string>,
): JudgeRequest {
  const keys = Object.keys(questions);
  const list = keys.map((key) => `- ${key}: ${questions[key]}`);
  return {
    prompt: `${JSON.stringify(state)}\n\nQuestions:\n${list.join('\n')}\n\nReturn one calibrated probability per question key.`,
    keys,
  };
}

/** One probability question per file over a shared tree-rendered listing of the batch. */
export function nameBatch(
  project: string,
  query: string,
  entries: readonly FileEntry[],
): JudgeRequest {
  const questions: Record<string, string> = {};
  entries.forEach((entry, i) => {
    const key = entryKey(i);
    const name = entry.rel.slice(entry.rel.lastIndexOf('/') + 1);
    questions[key] =
      `Is the file tagged ${key} ("${name}") likely to contain what this search is looking for: "${query}"? ` +
      'Judge by its name, size, and place in `tree`; apply `criteria.file`.';
  });
  return buildRequest(
    {
      criteria: { file: FILE_CRITERIA, folder: FOLDER_CRITERIA },
      format: TREE_FORMAT,
      project,
      search: query,
      task: TASK,
      tree: renderTree(entries, entryKey),
    },
    questions,
  );
}

/** One sketch card: the file it came from and its budgeted verbatim lines. */
export interface SketchCard {
  fileKey: string;
  rel: string;
  sketch: string;
}

/**
 * Mixed-file packing of sketch cards: one state ingestion pays for many
 * independent small cards instead of rereading a whole file to discover its
 * useful spans.
 */
export function sketchBatch(
  query: string,
  cards: readonly SketchCard[],
): JudgeRequest {
  const files: Record<string, string> = {};
  const passages: Record<string, [string, string]> = {};
  const questions: Record<string, string> = {};
  cards.forEach((card, k) => {
    const key = passageKey(k);
    files[card.fileKey] = card.rel;
    passages[key] = [card.fileKey, card.sketch];
    questions[key] =
      `Could passage ${key} implement a requested step of search? Apply \`criteria\`.`;
  });
  return buildRequest(
    { criteria: SKETCH_CRITERIA, files, passages, search: query },
    questions,
  );
}

/** Verification of complete passages from one file, judged independently. */
export function passageBatch(
  query: string,
  rel: string,
  passages: readonly Passage[],
): JudgeRequest {
  const entries: Record<string, string> = {};
  const questions: Record<string, string> = {};
  passages.forEach((passage, k) => {
    const key = passageKey(k);
    entries[key] = plainContent(passage);
    questions[key] =
      `Does \`passages.${key}\` (file "${rel}") substantively implement, define, or explain part of "${query}"? Apply \`criteria\`.`;
  });
  return buildRequest(
    { criteria: PASSAGE_CRITERIA, file: rel, passages: entries, search: query },
    questions,
  );
}
