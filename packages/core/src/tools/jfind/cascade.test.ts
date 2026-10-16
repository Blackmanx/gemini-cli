/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCascade } from './cascade.js';
import type { Judge } from './judge.js';
import type { JudgeRequest } from './questions.js';

/** The state JSON every request starts with, before the question lines. */
function parseState(prompt: string): Record<string, unknown> {
  const raw = prompt.slice(0, prompt.indexOf('\n\nQuestions:'));
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * A scripted judge that answers each phase by its state shape: filenames by
 * whether the name mentions "login", sketches by whether the verbatim sketch
 * carries `doLogin`, and verification by whether the file is the login file.
 */
const scriptedJudge: Judge = {
  async judge(request: JudgeRequest) {
    const state = parseState(request.prompt);
    const answers = new Map<string, number>();
    for (const key of request.keys) {
      let p = 0.1;
      if ('tree' in state) {
        const tree = String(state['tree']);
        const line = tree
          .split('\n')
          .find((candidate) => candidate.includes(` ${key} `));
        p = (line ?? '').includes('login.ts') ? 0.9 : 0.1;
      } else if ('files' in state) {
        const passages = state['passages'] as Record<string, [string, string]>;
        const sketch = passages[key][1] ?? '';
        p = sketch.includes('doLogin') ? 0.9 : 0.1;
      } else {
        const rel = String(state['file'] ?? '');
        p = rel.includes('login') ? 0.9 : 0.1;
      }
      answers.set(key, p);
    }
    return { answers, inputTokens: 77, outputTokens: 13 };
  },
};

const failingJudge: Judge = {
  async judge(): Promise<never> {
    throw new Error('judge down');
  },
};

describe('runCascade', () => {
  let dir: string;

  const searchRoot = (): { path: string; type: 'directory' } => ({
    path: dir,
    type: 'directory',
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-cascade-'));
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'src', 'login.ts'),
      'export function doLogin(user: string) {\n' +
        '  const session = createSession(user);\n' +
        '  return session;\n' +
        '}\n',
    );
    await fs.writeFile(
      path.join(dir, 'src', 'noise.ts'),
      'export const noise = 1;\n',
    );
    await fs.writeFile(
      path.join(dir, 'package.json'),
      '{\n  "name": "fixture"\n}\n',
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports the implementation file with its verified ranges and spend', async () => {
    const result = await runCascade({
      root: searchRoot(),
      query: 'doLogin session',
      extraKeywords: [],
      judge: scriptedJudge,
      ignore: [],
      includeHidden: false,
    });

    expect(result.threshold).toBe(0.2);
    expect(result.keywords).toEqual(['dologin', 'session']);
    expect(result.stats.listed).toBe(3);

    // Only the login file survives sketch routing and verification.
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit.rel).toBe('src/login.ts');
    expect(hit.contentScore).toBe(0.9);
    expect(hit.nameScore).toBe(0.9);
    expect(hit.ranges).toHaveLength(1);
    expect(hit.ranges[0].start).toBe(1);
    expect(hit.ranges[0].snippet).toContain('doLogin');

    // One request per wave over this fixture, none of them failing.
    expect(result.stats.errors).toBe(0);
    expect(result.stats.requests).toBe(3);
    expect(result.stats.failures).toEqual([]);
    // Token spend is aggregated from every wave.
    expect(result.stats.inputTokens).toBe(231);
    expect(result.stats.outputTokens).toBe(39);
    expect(result.stats.judged).toBeGreaterThan(0);
    expect(result.stats.windowsJudged).toBeGreaterThan(0);
  });

  it('degrades a dead judge to an empty result instead of throwing', async () => {
    const result = await runCascade({
      root: searchRoot(),
      query: 'doLogin session',
      extraKeywords: [],
      judge: failingJudge,
      ignore: [],
      includeHidden: false,
    });

    expect(result.hits).toEqual([]);
    expect(result.stats.requests).toBeGreaterThan(0);
    expect(result.stats.errors).toBe(result.stats.requests);
    expect(result.stats.failures.length).toBeGreaterThan(0);
    expect(result.stats.failures[0]).toContain('judge down');
  });
});
