/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w4.responses');

describe('omp port: post-edit diagnostics', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('does not let an unreachable language server fail a good edit', async () => {
    await rig.setup('omp port w4', {
      settings: { tools: { core: ['replace', 'read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    // A type error the edit removes. There is no language server installed
    // here, which is the interesting case.
    const file = join(rig.testDir!, 'broken.ts');
    writeFileSync(file, 'const x: number = "oops";\n');

    await rig.run({ args: 'fix the type error' });

    const edit = rig
      .readToolLogs()
      .find((l) => l.toolRequest.name === 'replace');
    expect(edit, 'replace ran').toBeTruthy();

    // The edit succeeded. A missing language server is not an edit error —
    // treating it as one would make every write fail on a machine with no
    // server installed.
    expect(
      edit!.toolRequest.success,
      `replace failed: ${edit!.toolRequest.error ?? '(no error)'}`,
    ).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('const x: number = 42;\n');
  });
});
