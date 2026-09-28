/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which side of an anchor line a gap insertion lands on.
 *
 * `before` / `after` carry the 1-based anchor in {@link HashlineOp.start};
 * `tail` appends after the final line and carries no anchor (`start === 0`).
 */
export type HashlineGap = 'before' | 'after' | 'tail';

/** One `[path#TAG]` section: a single file and the ops aimed at it. */
export interface HashlineSection {
  /** Path exactly as the model wrote it in the header. */
  path: string;
  /**
   * Four uppercase hex characters. Empty when the header carried no tag; the
   * applier refuses such a section rather than guessing at file content.
   */
  tag: string;
  /** Ops in source order. Every anchor is an ORIGINAL 1-based line number. */
  ops: HashlineOp[];
}

/**
 * A single hashline operation.
 *
 * `put` covers both an inline replacement (`body` non-empty) and a register
 * paste (`body` empty). The parser rejects an inline `PUT …:` with no body
 * rows, so `body.length === 0` unambiguously means "paste `register` (or the
 * anonymous register) at this anchor".
 */
export type HashlineOp =
  | {
      kind: 'put';
      /** First anchored line, or the gap anchor. `0` for a tail gap. */
      start: number;
      /** Last anchored line, inclusive. Equals `start` for a gap. */
      end: number;
      /** True for the `PUT N*:` / `PUT >N*:` block-anchor forms. */
      block: boolean;
      /** `+TEXT` rows, already stripped of the leading `+`. */
      body: string[];
      /** Register name from ` @name`; absent means the anonymous register. */
      register?: string;
      /** Present for `PUT <N`, `PUT >N` and `PUT >$`; absent for `PUT N.=M`. */
      gap?: HashlineGap;
    }
  | {
      kind: 'cut';
      start: number;
      end: number;
      block: boolean;
      /** Register name from ` @name`; absent means the anonymous register. */
      register?: string;
    }
  | { kind: 'remove' }
  | { kind: 'move'; destination: string };

/** The whole parsed input: one or more file sections. */
export interface ParsedHashlineInput {
  sections: HashlineSection[];
}
