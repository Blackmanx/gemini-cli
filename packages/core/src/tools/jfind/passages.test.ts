/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  mergeHeat,
  type HeatRange,
  type Passage,
  plainContent,
  selectWindows,
  sketch,
  windows,
} from './passages.js';

function makePassages(count: number, score: (i: number) => number): Passage[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 10 + 1,
    end: i * 10 + 5,
    text: `L${i * 10 + 1}| placeholder\n`,
    score: score(i),
  }));
}

describe('windows', () => {
  it('tags every line with its original number and stays inside the byte budget', () => {
    const text = 'one\ntwo\nthree\nfour\n';
    const result = windows(text, 30, [], []);
    expect(result.length).toBeGreaterThan(1);
    for (const passage of result) {
      expect(Buffer.byteLength(passage.text)).toBeLessThanOrEqual(30);
      // Line ids are 1-based and contiguous across the window.
      const ids = [...passage.text.matchAll(/^L(\d+)\| /gm)].map((m) => m[1]);
      expect(Number(ids[0])).toBe(passage.start);
      expect(Number(ids[ids.length - 1])).toBe(passage.end);
    }
    // Every source line lands in exactly one window, in file order.
    expect(result.map((p) => p.start)).toEqual([1, 4]);
    expect(result[1].end).toBe(4);
  });

  it('ranks windows by weighted keyword occurrences', () => {
    const text = 'alpha\nalpha beta\nbeta\ngamma\n';
    const scored = windows(text, 30, ['alpha', 'beta'], [1, 1]);
    const byStart = new Map(scored.map((p) => [p.start, p.score]));
    // Window 1 holds the alpha-dense lines, window 2 the beta-only tail.
    expect(byStart.get(1)).toBeGreaterThan(byStart.get(3)!);
    expect(byStart.get(3)).toBeGreaterThan(0);
    expect(byStart.get(1)).toBeCloseTo(Math.log1p(2) + Math.log1p(1));
    expect(byStart.get(3)).toBeCloseTo(Math.log1p(1));
  });
});

describe('selectWindows', () => {
  it('keeps the strongest windows when scores differ', () => {
    const passages = makePassages(6, (i) => (i === 2 ? 5 : i === 4 ? 3 : 1));
    const selected = selectWindows(passages, 2);
    expect(selected.map((p) => p.start)).toEqual([21, 41]);
    // File order is restored after rank selection.
    expect(selected[0].start).toBeLessThan(selected[1].start);
  });

  it('spreads an all-zero file across its length instead of its opening bytes', () => {
    const passages = makePassages(9, () => 0);
    const selected = selectWindows(passages, 3);
    expect(selected).toHaveLength(3);
    const starts = selected.map((p) => p.start);
    expect(starts[0]).toBe(1);
    expect(starts[2]).toBe(81);
    expect(new Set(starts).size).toBe(3);
  });
});

describe('plainContent', () => {
  it('strips the generated L<n>| tags while preserving the source lines', () => {
    const [passage] = windows('alpha\nbravo\n', 100, [], []);
    expect(plainContent(passage)).toBe('alpha\nbravo\n');
  });
});

describe('sketch', () => {
  it('stays within the byte budget and keeps keyword lines over noise', () => {
    const text = Array.from({ length: 40 }, (_, i) =>
      i === 21 ? 'handlePaymentRetry(attempt)' : `const filler${i} = ${i};`,
    ).join('\n');
    const [passage] = windows(text, 4096, ['payment'], [1]);
    const out = sketch(passage, ['payment'], [1], 96);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(96);
    expect(out).toContain('handlePaymentRetry');
    // Sketch lines are prefixed with their real line number.
    expect(out).toMatch(/^\d+: /m);
  });
});

describe('mergeHeat', () => {
  const range = (start: number, end: number, p: number): HeatRange => ({
    start,
    end,
    p,
    snippet: '',
  });

  it('merges touching spans keeping the max probability and never bridges a gap', () => {
    const merged = mergeHeat(
      [range(1, 2, 0.9), range(3, 4, 0.5), range(6, 8, 0.7)],
      0.2,
    );
    expect(merged).toEqual([
      { start: 1, end: 4, p: 0.9, snippet: '' },
      { start: 6, end: 8, p: 0.7, snippet: '' },
    ]);
  });

  it('drops ranges below the threshold', () => {
    expect(mergeHeat([range(1, 2, 0.1)], 0.2)).toEqual([]);
  });
});
