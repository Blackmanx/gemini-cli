/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HashlineGap,
  HashlineOp,
  HashlineSection,
  ParsedHashlineInput,
} from './types.js';

/**
 * A parse failure carrying the exact spot it happened at.
 *
 * Nothing is applied until the whole input has parsed, so this is the only
 * place a model is told a patch is malformed. Naming the file, the input line
 * and the reason is the difference between a model fixing one character and a
 * model abandoning the edit.
 */
export class HashlineParseError extends Error {
  constructor(
    message: string,
    readonly sectionPath: string | undefined,
    readonly inputLine: number,
  ) {
    const where =
      sectionPath === undefined
        ? `hashline input line ${inputLine}`
        : `${sectionPath} (hashline input line ${inputLine})`;
    super(`${where}: ${message}`);
    this.name = 'HashlineParseError';
  }
}

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';

const TAG_PATTERN = /^[0-9A-F]{4}$/;
const LINE_NUMBER_PATTERN = /^[1-9]\d*$/;
const REGISTER_SUFFIX_PATTERN = / @([A-Za-z0-9_-]+)$/;

/** Raised for every `*` form until block boundaries can be resolved exactly. */
const BLOCK_UNSUPPORTED =
  'block anchors (`*`) are not supported: a wrong block boundary silently ' +
  'corrupts a file, so use an explicit line range (`N.=M`) or a gap ' +
  '(`<N`, `>N`, `>$`) instead';

/** Where a `PUT`/`CUT` locator points, before the file has been consulted. */
interface Locator {
  start: number;
  end: number;
  gap?: HashlineGap;
}

/** A `PUT …:` that is still waiting for its `+` body rows. */
interface PendingBody {
  section: HashlineSection;
  op: Extract<HashlineOp, { kind: 'put' }>;
  inputLine: number;
}

function parseLineNumber(
  digits: string,
  inputLine: number,
  sectionPath: string,
): number {
  if (!LINE_NUMBER_PATTERN.test(digits)) {
    throw new HashlineParseError(
      `line number "${digits}" must be a positive integer with no leading zero`,
      sectionPath,
      inputLine,
    );
  }
  return Number.parseInt(digits, 10);
}

/** Split `[path]` / `[path#TAG]` apart; undefined for a line that is not one. */
function readSectionHeader(
  raw: string,
  inputLine: number,
): { path: string; tag: string } | undefined {
  if (!raw.startsWith('[') || !raw.endsWith(']') || raw.length < 3) {
    return undefined;
  }
  const inner = raw.slice(1, -1);
  const separator = inner.lastIndexOf('#');
  if (separator === -1) {
    return { path: inner, tag: '' };
  }
  const path = inner.slice(0, separator);
  const tag = inner.slice(separator + 1);
  if (path === '') {
    throw new HashlineParseError(
      `section header "${raw}" has no path before the #`,
      undefined,
      inputLine,
    );
  }
  if (!TAG_PATTERN.test(tag)) {
    throw new HashlineParseError(
      `tag "${tag}" is not four uppercase hex characters; copy the [path#TAG] header from the read that showed you this file`,
      undefined,
      inputLine,
    );
  }
  return { path, tag };
}

/** Resolve the locator half of a `PUT` or `CUT` line. */
function readLocator(
  raw: string,
  inputLine: number,
  sectionPath: string,
): Locator {
  if (raw === '>$') {
    return { start: 0, end: 0, gap: 'tail' };
  }
  if (raw.includes('*')) {
    throw new HashlineParseError(BLOCK_UNSUPPORTED, sectionPath, inputLine);
  }
  const gapMatch = /^([<>])(\d+)$/.exec(raw);
  if (gapMatch !== null) {
    const line = parseLineNumber(gapMatch[2], inputLine, sectionPath);
    return {
      start: line,
      end: line,
      gap: gapMatch[1] === '<' ? 'before' : 'after',
    };
  }
  const rangeMatch = /^(\d+)\.=(\d+)$/.exec(raw);
  if (rangeMatch === null) {
    throw new HashlineParseError(
      `"${raw}" is not a locator; expected N.=M, <N, >N or >$`,
      sectionPath,
      inputLine,
    );
  }
  const start = parseLineNumber(rangeMatch[1], inputLine, sectionPath);
  const end = parseLineNumber(rangeMatch[2], inputLine, sectionPath);
  if (end < start) {
    throw new HashlineParseError(
      `range ${start}.=${end} ends before it starts`,
      sectionPath,
      inputLine,
    );
  }
  return { start, end };
}

function readPutOp(
  body: string,
  inputLine: number,
  sectionPath: string,
): Extract<HashlineOp, { kind: 'put' }> {
  let rest = body;
  let register: string | undefined;
  const registerMatch = REGISTER_SUFFIX_PATTERN.exec(rest);
  if (registerMatch !== null) {
    register = registerMatch[1];
    rest = rest.slice(0, registerMatch.index);
  }
  const takesBody = rest.endsWith(':');
  if (takesBody) {
    rest = rest.slice(0, -1);
  }
  const locator = readLocator(rest, inputLine, sectionPath);
  if (takesBody && register !== undefined) {
    throw new HashlineParseError(
      'a register paste takes no body: drop the `:` and the `+` rows',
      sectionPath,
      inputLine,
    );
  }
  if (!takesBody && locator.gap === undefined && register === undefined) {
    throw new HashlineParseError(
      'a PUT over a line range with no `:` body must name a register: `PUT N.=M @name` pastes @name, or write `PUT N.=M:` with `+` rows',
      sectionPath,
      inputLine,
    );
  }
  return {
    kind: 'put',
    start: locator.start,
    end: locator.end,
    block: false,
    body: [],
    register,
    gap: locator.gap,
  };
}

function readCutOp(
  body: string,
  inputLine: number,
  sectionPath: string,
): Extract<HashlineOp, { kind: 'cut' }> {
  if (body.endsWith(':')) {
    throw new HashlineParseError(
      'CUT takes no body; remove the trailing `:`',
      sectionPath,
      inputLine,
    );
  }
  let register: string | undefined;
  const registerMatch = REGISTER_SUFFIX_PATTERN.exec(body);
  if (registerMatch !== null) {
    register = registerMatch[1];
    body = body.slice(0, registerMatch.index);
  }
  const locator = readLocator(body, inputLine, sectionPath);
  if (locator.gap !== undefined) {
    throw new HashlineParseError(
      'CUT needs a line range (`CUT N.=M`); a gap has nothing to capture',
      sectionPath,
      inputLine,
    );
  }
  return {
    kind: 'cut',
    start: locator.start,
    end: locator.end,
    block: false,
    register,
  };
}

function readMoveOp(
  body: string,
  inputLine: number,
  sectionPath: string,
): Extract<HashlineOp, { kind: 'move' }> {
  let destination = body.trim();
  if (
    destination.length >= 2 &&
    destination.startsWith('"') &&
    destination.endsWith('"')
  ) {
    destination = destination.slice(1, -1);
  }
  if (destination === '') {
    throw new HashlineParseError(
      'MV needs a destination path',
      sectionPath,
      inputLine,
    );
  }
  return { kind: 'move', destination };
}

/** A body row that is not `+TEXT` is the single most common model mistake. */
function rejectBodyRow(
  raw: string,
  inputLine: number,
  sectionPath: string,
): never {
  if (raw.startsWith('-')) {
    throw new HashlineParseError(
      `body rows are \`+TEXT\` final content, never removed lines; write "+${raw}" if the line really starts with a dash`,
      sectionPath,
      inputLine,
    );
  }
  if (raw.startsWith('@@')) {
    throw new HashlineParseError(
      'body rows are `+TEXT` final content, never a unified diff; write the complete replacement lines with a leading `+`',
      sectionPath,
      inputLine,
    );
  }
  throw new HashlineParseError(
    `expected a \`+\` body row or the start of the next op, got "${raw}"`,
    sectionPath,
    inputLine,
  );
}

/**
 * Whether a line can only be the start of the next op rather than a stray
 * body row, so an open `PUT …:` body closes on it instead of swallowing it.
 */
function startsNewOp(trimmed: string): boolean {
  if (trimmed === BEGIN_PATCH || trimmed === END_PATCH) {
    return true;
  }
  for (const keyword of ['PUT', 'CUT', 'REM', 'MV']) {
    if (trimmed === keyword || trimmed.startsWith(`${keyword} `)) {
      return true;
    }
  }
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}

function countOps(section: HashlineSection, kind: 'remove' | 'move'): number {
  let total = 0;
  for (const op of section.ops) {
    if (op.kind === kind) {
      total += 1;
    }
  }
  return total;
}

/**
 * Parse a complete hashline patch into sections and ops.
 *
 * Nothing is applied here: this function is purely syntactic, and it throws
 * on the first malformed line rather than skipping it. A patch that is
 * understood in patches is understood exactly the way the model meant.
 */
export function parseHashlineInput(input: string): ParsedHashlineInput {
  const rawLines = input.split('\n');
  const sections: HashlineSection[] = [];
  let current: HashlineSection | undefined;
  let pending: PendingBody | undefined;
  let sawBegin = false;
  let sawEnd = false;

  const commitBody = (): void => {
    if (pending === undefined) {
      return;
    }
    const body = pending;
    pending = undefined;
    if (body.op.body.length === 0) {
      throw new HashlineParseError(
        '`PUT …:` needs at least one `+` body row; use `CUT N.=M` to delete lines',
        body.section.path,
        body.inputLine,
      );
    }
    body.section.ops.push(body.op);
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const inputLine = index + 1;
    const raw = rawLines[index].replace(/\r$/, '');

    if (pending !== undefined) {
      if (raw.startsWith('+')) {
        pending.op.body.push(raw.slice(1));
        continue;
      }
      if (raw.trim() !== '' && !startsNewOp(raw.trim())) {
        rejectBodyRow(raw.trim(), inputLine, pending.section.path);
      }
      commitBody();
    }

    const trimmed = raw.trim();
    if (trimmed === '') {
      continue;
    }
    if (sawEnd) {
      throw new HashlineParseError(
        `unexpected content after ${END_PATCH}`,
        current?.path,
        inputLine,
      );
    }
    if (trimmed === BEGIN_PATCH) {
      if (sawBegin) {
        throw new HashlineParseError(
          `duplicate ${BEGIN_PATCH}`,
          current?.path,
          inputLine,
        );
      }
      sawBegin = true;
      continue;
    }
    if (trimmed === END_PATCH) {
      if (!sawBegin) {
        throw new HashlineParseError(
          `${END_PATCH} without ${BEGIN_PATCH}`,
          current?.path,
          inputLine,
        );
      }
      sawEnd = true;
      continue;
    }

    const header = readSectionHeader(trimmed, inputLine);
    if (header !== undefined) {
      current = { path: header.path, tag: header.tag, ops: [] };
      sections.push(current);
      continue;
    }

    const section = current;
    if (section === undefined) {
      throw new HashlineParseError(
        `line "${trimmed}" appears before any [path#TAG] section header`,
        undefined,
        inputLine,
      );
    }
    const sectionPath = section.path;

    if (trimmed.startsWith('PUT')) {
      if (!trimmed.startsWith('PUT ')) {
        throw new HashlineParseError(
          'expected a single space after PUT',
          sectionPath,
          inputLine,
        );
      }
      const op = readPutOp(trimmed.slice(4), inputLine, sectionPath);
      if (trimmed.endsWith(':')) {
        pending = { section, op, inputLine };
        continue;
      }
      section.ops.push(op);
      continue;
    }
    if (trimmed.startsWith('CUT')) {
      if (!trimmed.startsWith('CUT ')) {
        throw new HashlineParseError(
          'expected a single space after CUT',
          sectionPath,
          inputLine,
        );
      }
      section.ops.push(readCutOp(trimmed.slice(4), inputLine, sectionPath));
      continue;
    }
    if (trimmed === 'REM') {
      section.ops.push({ kind: 'remove' });
      continue;
    }
    if (trimmed.startsWith('MV')) {
      if (!trimmed.startsWith('MV ')) {
        throw new HashlineParseError(
          'expected a single space after MV',
          sectionPath,
          inputLine,
        );
      }
      section.ops.push(readMoveOp(trimmed.slice(3), inputLine, sectionPath));
      continue;
    }
    if (trimmed.startsWith('+')) {
      throw new HashlineParseError(
        `body row "${trimmed}" has no \`PUT …:\` op above it to attach to`,
        sectionPath,
        inputLine,
      );
    }
    rejectBodyRow(trimmed, inputLine, sectionPath);
  }
  commitBody();

  if (sections.length === 0) {
    throw new HashlineParseError(
      'no [path#TAG] section found; a hashline patch is one or more "[path#TAG]" headers followed by ops',
      undefined,
      rawLines.length,
    );
  }
  const lastLine = rawLines.length;
  for (const section of sections) {
    if (section.ops.length === 0) {
      throw new HashlineParseError(
        `section for ${section.path} has no operations`,
        section.path,
        lastLine,
      );
    }
    const removals = countOps(section, 'remove');
    const moves = countOps(section, 'move');
    if (removals > 1) {
      throw new HashlineParseError(
        `section for ${section.path} has ${removals} REM ops; a file can only be removed once`,
        section.path,
        lastLine,
      );
    }
    if (moves > 1) {
      throw new HashlineParseError(
        `section for ${section.path} has ${moves} MV ops; a file can only be moved once`,
        section.path,
        lastLine,
      );
    }
    if (removals === 1 && moves === 1) {
      throw new HashlineParseError(
        `section for ${section.path} both removes and moves the file; pick one`,
        section.path,
        lastLine,
      );
    }
  }
  return { sections };
}
