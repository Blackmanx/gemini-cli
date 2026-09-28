/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { coversLine, normalizeRanges } from './snapshots.js';
import type { LineRange, Snapshot } from './snapshots.js';
import type {
  HashlineOp,
  HashlineSection,
  ParsedHashlineInput,
} from './types.js';

/**
 * Every refusal this applier can produce, in one message.
 *
 * The applier never writes; it validates the whole input and then hands back
 * the intended writes. A caller that gets an exception back knows the
 * filesystem is untouched, which is the only reason it is safe to run at all.
 */
export class HashlineApplyError extends Error {
  constructor(readonly failures: string[]) {
    super(
      `hashline patch refused (${failures.length} problem(s)):\n- ${failures.join('\n- ')}`,
    );
    this.name = 'HashlineApplyError';
  }
}

/** What one file section would do if every check passed. */
export interface ApplyResult {
  files: Array<{ path: string; before: string; after: string }>;
  /** Files a `REM` op would delete, with the content they would hold. */
  removed?: Array<{ path: string; before: string }>;
  /** Files an `MV` op would rename, after that section's content edits. */
  moved?: Array<{ from: string; to: string; before: string; after: string }>;
}

/** Looks up the snapshot a section's `[path#TAG]` header refers to. */
export type SnapshotResolver = (
  path: string,
  tag: string,
) => Snapshot | undefined;

/** A content op placed in ORIGINAL line coordinates and checked. */
interface AnchoredOp {
  op: Extract<HashlineOp, { kind: 'put' | 'cut' }>;
  order: number;
  /** 0-based inclusive ORIGINAL lines this op rewrites or deletes. */
  span: [number, number] | null;
  /** 0-based ORIGINAL index this op inserts at; null for a span op. */
  insertAt: number | null;
  /** ORIGINAL 1-based lines this op claims, for the seen check. */
  touched: number[];
}

/** The anonymous register slot, boxed so `CUT` and `PUT` can share it. */
interface AnonymousRegister {
  value: string[] | undefined;
}

/** Split content into real lines, remembering whether it ended with a newline. */
function splitContent(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (content === '') {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = content.endsWith('\n');
  const parts = content.split('\n');
  if (trailingNewline) {
    parts.pop();
  }
  return { lines: parts, trailingNewline };
}

function joinContent(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return '';
  }
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/** Render a line list as `4`, `7-9`, `12,15-16` for use in a refusal. */
function formatRanges(lines: number[]): string {
  const unique: number[] = [];
  for (const line of lines) {
    if (!unique.includes(line)) {
      unique.push(line);
    }
  }
  unique.sort((left, right) => left - right);
  if (unique.length === 0) {
    return '';
  }
  const parts: string[] = [];
  let start = unique[0];
  let end = unique[0];
  for (let index = 1; index <= unique.length; index += 1) {
    const current = unique[index];
    if (current === end + 1) {
      end = current;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    start = current ?? end;
    end = start;
  }
  return parts.join(',');
}

/**
 * The single most valuable rule in the port: an edit may only touch lines the
 * model was actually shown. A read that returned a window, a grep hit or a
 * folded summary leaves the rest of the file as a guess, and an edit built on
 * a guess is how a file gets silently mangled.
 */
function unseenMessage(
  sectionPath: string,
  tag: string,
  unseen: number[],
): string {
  const ranges = formatRanges(unseen);
  return (
    `${sectionPath}#${tag}: this edit anchors to line(s) ${ranges} that this tag never ` +
    `displayed (the read showed a partial range, a search hit, or a folded summary). ` +
    `Re-read them in full with a ranged read like \`${sectionPath}:${ranges}\`, which mints ` +
    'a fresh tag, then re-issue the edit against that tag.'
  );
}

/** Bounds-check and seen-check one inclusive ORIGINAL line range. */
function anchorSpan(
  start: number,
  end: number,
  order: number,
  lineCount: number,
  seenRanges: LineRange[],
  sectionPath: string,
  tag: string,
  failures: string[],
): { span: [number, number]; touched: number[] } | undefined {
  if (start < 1 || end > lineCount) {
    failures.push(
      `${sectionPath}#${tag}: op ${order + 1} covers lines ${start}-${end}, but the tagged snapshot has ${lineCount} line(s). Re-read the file for fresh line numbers.`,
    );
    return undefined;
  }
  const touched: number[] = [];
  const unseen: number[] = [];
  for (let line = start; line <= end; line += 1) {
    touched.push(line);
    if (!coversLine(seenRanges, line)) {
      unseen.push(line);
    }
  }
  if (unseen.length > 0) {
    failures.push(unseenMessage(sectionPath, tag, unseen));
  }
  return { span: [start - 1, end - 1], touched };
}

/**
 * Place one op in ORIGINAL line coordinates and run the bounds and seen checks.
 * Returns undefined when the op is out of bounds and must not be applied.
 */
function anchorOp(
  op: Extract<HashlineOp, { kind: 'put' | 'cut' }>,
  order: number,
  lineCount: number,
  seenRanges: LineRange[],
  sectionPath: string,
  tag: string,
  failures: string[],
): AnchoredOp | undefined {
  const base = { op, order };
  if (op.kind === 'cut') {
    const placed = anchorSpan(
      op.start,
      op.end,
      order,
      lineCount,
      seenRanges,
      sectionPath,
      tag,
      failures,
    );
    if (placed === undefined) {
      return undefined;
    }
    return {
      ...base,
      span: placed.span,
      insertAt: null,
      touched: placed.touched,
    };
  }
  if (op.gap === 'tail') {
    return { ...base, span: null, insertAt: lineCount, touched: [] };
  }
  if (op.gap !== undefined) {
    const placed = anchorSpan(
      op.start,
      op.start,
      order,
      lineCount,
      seenRanges,
      sectionPath,
      tag,
      failures,
    );
    if (placed === undefined) {
      return undefined;
    }
    return {
      ...base,
      span: null,
      insertAt: op.gap === 'before' ? op.start - 1 : op.start,
      touched: placed.touched,
    };
  }
  const placed = anchorSpan(
    op.start,
    op.end,
    order,
    lineCount,
    seenRanges,
    sectionPath,
    tag,
    failures,
  );
  if (placed === undefined) {
    return undefined;
  }
  return {
    ...base,
    span: placed.span,
    insertAt: null,
    touched: placed.touched,
  };
}

/**
 * Two ops that would rewrite the same ORIGINAL line have no well-defined
 * combined result, so they are refused.
 *
 * Not every shared line is a conflict, though, and refusing those would break
 * the format's own move idiom (`CUT 2.=3` then `PUT >3`). A span op claims the
 * lines it replaces or deletes; a gap op claims only an insertion point. So:
 *
 * - two spans conflict when they intersect;
 * - a gap conflicts with a span only when the insertion point falls strictly
 *   inside the lines that span deletes, where the result would depend on which
 *   op ran first;
 * - two gaps never conflict; they compose in source order.
 */
function rejectOverlaps(
  anchored: AnchoredOp[],
  sectionPath: string,
  tag: string,
  failures: string[],
): void {
  for (let left = 0; left < anchored.length; left += 1) {
    for (let right = left + 1; right < anchored.length; right += 1) {
      const first = anchored[left];
      const second = anchored[right];
      const shared = sharedClaims(first, second);
      if (shared === null) {
        continue;
      }
      failures.push(
        `${sectionPath}#${tag}: ops ${first.order + 1} and ${second.order + 1} both claim line(s) ${formatRanges(shared)}. Two ops in one section cannot rewrite the same original line; split the change so each region is claimed once.`,
      );
    }
  }
}

/**
 * Whether an insertion point falls on or inside a span's rewritten lines.
 * The span's own first line counts: inserting there would be immediately
 * rewritten by the span, so which op "won" would decide the result.
 */
function landsInsideSpan(position: number, span: [number, number]): boolean {
  return span[0] <= position && position <= span[1];
}

/**
 * The original lines two ops fight over, or null when they compose cleanly.
 *
 * Two spans conflict where they intersect. A gap conflicts with a span only
 * when its insertion point lands strictly inside the lines that span deletes,
 * because that is the one case where the result depends on which op runs
 * first. Two gaps, and a gap at either edge of a span, compose in source
 * order — that is what makes `CUT 2.=3` followed by `PUT >3` work.
 */
function sharedClaims(first: AnchoredOp, second: AnchoredOp): number[] | null {
  if (first.span !== null && second.span !== null) {
    if (first.span[0] > second.span[1] || second.span[0] > first.span[1]) {
      return null;
    }
  } else if (first.span !== null && second.insertAt !== null) {
    if (!landsInsideSpan(second.insertAt, first.span)) {
      return null;
    }
  } else if (first.insertAt !== null && second.span !== null) {
    if (!landsInsideSpan(first.insertAt, second.span)) {
      return null;
    }
  } else {
    return null;
  }
  const shared: number[] = [];
  for (const line of first.touched) {
    if (second.touched.includes(line) && !shared.includes(line)) {
      shared.push(line);
    }
  }
  for (const line of second.touched) {
    if (first.touched.includes(line) && !shared.includes(line)) {
      shared.push(line);
    }
  }
  return shared.length === 0 ? null : shared;
}

/**
 * Resolve one section's registers in source order.
 *
 * `CUT` captures ORIGINAL lines, so a capture is unaffected by anything else in
 * the section and a paste can be resolved before any content is spliced. Named
 * registers persist for the whole input; the anonymous register holds the most
 * recent unnamed `CUT` and is consumed by the next unnamed paste.
 */
function resolveRegisters(
  anchored: AnchoredOp[],
  lines: string[],
  named: Map<string, string[]>,
  anonymous: AnonymousRegister,
  sectionPath: string,
  tag: string,
  failures: string[],
  bodies: Map<number, string[]>,
): void {
  for (const entry of anchored) {
    const op = entry.op;
    if (op.kind === 'cut') {
      const captured = lines.slice(op.start - 1, op.end);
      if (op.register === undefined) {
        anonymous.value = captured;
      } else {
        named.set(op.register, captured);
      }
      continue;
    }
    if (op.body.length > 0) {
      continue;
    }
    const source =
      op.register === undefined ? anonymous.value : named.get(op.register);
    if (source === undefined || source.length === 0) {
      const label =
        op.register === undefined
          ? 'the anonymous register'
          : `@${op.register}`;
      failures.push(
        `${sectionPath}#${tag}: op ${entry.order + 1} pastes ${label}, which holds no lines. CUT the lines first — in this input, or in an earlier one if the register is named.`,
      );
      continue;
    }
    bodies.set(entry.order, source);
  }
}

/** A replacement or deletion placed at its first ORIGINAL line index. */
interface Placement {
  end: number;
  body: string[];
}

/**
 * Fold every op into the result in one pass over the ORIGINAL lines.
 *
 * Splicing from the end backwards would be shorter, but it is wrong as soon
 * as one op deletes lines that shift where a later op lands: `CUT 2.=3` then
 * `PUT >3` would put the pasted lines back inside the range being deleted.
 * Walking the original lines once and emitting each op where its anchor
 * actually falls makes the anchors mean the same thing the model read, with
 * no index arithmetic to get wrong. Returns null when nothing was placed.
 */
function composeContent(
  anchored: AnchoredOp[],
  bodies: Map<number, string[]>,
  lines: string[],
  lineCount: number,
  trailingNewline: boolean,
  sectionPath: string,
  tag: string,
  failures: string[],
): string | null {
  const placements = new Map<number, Placement>();
  const gaps = new Map<number, Array<{ order: number; body: string[] }>>();
  for (const entry of anchored) {
    const op = entry.op;
    if (op.block) {
      // The parser refuses `*` outright; this guards a hand-built parse.
      failures.push(
        `${sectionPath}#${tag}: op ${entry.order + 1} uses a block anchor, which this applier cannot resolve. Re-issue it as an explicit line range.`,
      );
      continue;
    }
    let body: string[];
    const pasted = bodies.get(entry.order);
    if (pasted !== undefined) {
      body = pasted;
    } else if (op.kind === 'put' && op.body.length > 0) {
      body = op.body;
    } else if (op.kind === 'cut') {
      body = [];
    } else {
      // An unresolved paste already produced a failure; never emit a hole.
      continue;
    }
    if (entry.insertAt !== null) {
      const existing = gaps.get(entry.insertAt);
      if (existing === undefined) {
        gaps.set(entry.insertAt, [{ order: entry.order, body }]);
      } else {
        existing.push({ order: entry.order, body });
      }
      continue;
    }
    if (entry.span !== null) {
      placements.set(entry.span[0], { end: entry.span[1], body });
    }
  }
  if (placements.size === 0 && gaps.size === 0) {
    return null;
  }
  for (const queue of gaps.values()) {
    queue.sort((left, right) => left.order - right.order);
  }
  const out: string[] = [];
  let index = 0;
  while (index <= lineCount) {
    const queued = gaps.get(index);
    if (queued !== undefined) {
      for (const gap of queued) {
        for (const line of gap.body) {
          out.push(line);
        }
      }
    }
    if (index === lineCount) {
      break;
    }
    const placement = placements.get(index);
    if (placement !== undefined) {
      for (const line of placement.body) {
        out.push(line);
      }
      index = placement.end + 1;
      continue;
    }
    out.push(lines[index]);
    index += 1;
  }
  return joinContent(out, trailingNewline);
}

/**
 * Validate and resolve a parsed hashline patch into concrete writes.
 *
 * Every rule here exists because the alternative is corrupting a file the
 * model never actually read:
 *
 * - An untagged or unknown tag is refused. Editing a file whose content
 *   cannot be identified is exactly the failure this format exists to stop,
 *   and a plain string-replace applier performs it silently.
 * - An op touching a line outside `seenRanges` is refused with a re-read
 *   instruction. This is the rule that turns "the line may have moved" from a
 *   corruption into a one-line retry.
 * - Overlapping ops in one section are refused, because two ops claiming the
 *   same original line have no well-defined combined result.
 * - A byte-identical result is refused as a no-op, so a looping model is told
 *   its change was already there instead of burning a turn on a silent no-op.
 * - All sections are validated before anything is written. This function
 *   returns writes instead of performing them, so a caller that throws on this
 *   error is guaranteed to have touched no file.
 */
export function applyHashlineInput(
  parsed: ParsedHashlineInput,
  resolve: SnapshotResolver,
): ApplyResult {
  const failures: string[] = [];
  const result: ApplyResult = { files: [], removed: [], moved: [] };
  const named = new Map<string, string[]>();
  const anonymous: AnonymousRegister = { value: undefined };
  const claimed = new Set<string>();

  for (const section of parsed.sections) {
    if (section.tag === '') {
      failures.push(
        `${section.path}: the section header has no [#TAG]. Every hashline edit must name the four-hex tag of a version of the file that was actually read; without it there is no way to tell current content from stale content. Re-read ${section.path} and use the [path#TAG] header it returns.`,
      );
      continue;
    }
    if (claimed.has(section.path)) {
      failures.push(
        `${section.path}#${section.tag}: this path is already edited by an earlier section of the same patch. Edit each file in exactly one section so the two sections cannot disagree about the same bytes.`,
      );
      continue;
    }
    claimed.add(section.path);

    const snapshot = resolve(section.path, section.tag);
    if (snapshot === undefined) {
      failures.push(
        `${section.path}#${section.tag}: unknown or stale tag. The file changed since this tag was minted, or it was never read at this version. Re-read ${section.path} and re-issue the edit with the fresh [path#TAG] header.`,
      );
      continue;
    }
    failures.push(...applySection(section, snapshot, named, anonymous, result));
  }

  if (failures.length > 0) {
    throw new HashlineApplyError(failures);
  }
  return result;
}

/** Validate one section and record its writes; returns that section's failures. */
function applySection(
  section: HashlineSection,
  snapshot: Snapshot,
  named: Map<string, string[]>,
  anonymous: AnonymousRegister,
  result: ApplyResult,
): string[] {
  const failures: string[] = [];
  const { path, tag } = section;
  const { lines, trailingNewline } = splitContent(snapshot.content);
  const lineCount = lines.length;
  const seenRanges = normalizeRanges(snapshot.seenRanges);

  const anchored: AnchoredOp[] = [];
  for (let order = 0; order < section.ops.length; order += 1) {
    const op = section.ops[order];
    if (op.kind !== 'put' && op.kind !== 'cut') {
      continue;
    }
    const placed = anchorOp(
      op,
      order,
      lineCount,
      seenRanges,
      path,
      tag,
      failures,
    );
    if (placed !== undefined) {
      anchored.push(placed);
    }
  }
  rejectOverlaps(anchored, path, tag, failures);

  const bodies = new Map<number, string[]>();
  resolveRegisters(
    anchored,
    lines,
    named,
    anonymous,
    path,
    tag,
    failures,
    bodies,
  );
  const composed = composeContent(
    anchored,
    bodies,
    lines,
    lineCount,
    trailingNewline,
    path,
    tag,
    failures,
  );

  let finalContent = snapshot.content;
  if (composed !== null) {
    finalContent = composed;
    if (composed === snapshot.content) {
      // Refuse rather than write an identical file: an empty write costs a
      // turn, hides a stale line number, and reads as success when it is not.
      const described: string[] = [];
      for (const entry of anchored) {
        if (entry.op.kind !== 'put') {
          continue;
        }
        const verb = entry.op.body.length === 0 ? 'pastes' : 'replaces';
        described.push(`op ${entry.order + 1} ${verb} the text it targets`);
      }
      failures.push(
        `${path}#${tag}: the result is byte-identical to the snapshot, so there is nothing to write; ${described.join(', ')}. Either the change is already applied, or the body was copied from the current content instead of the intended replacement.`,
      );
      finalContent = snapshot.content;
    } else {
      result.files.push({
        path,
        before: snapshot.content,
        after: finalContent,
      });
    }
  }

  for (const op of section.ops) {
    if (op.kind === 'remove') {
      result.removed?.push({ path, before: finalContent });
      continue;
    }
    if (op.kind === 'move') {
      result.moved?.push({
        from: path,
        to: op.destination,
        before: snapshot.content,
        after: finalContent,
      });
    }
  }
  return failures;
}
