/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w2.responses');

/** Pull one tool's rendered output out of the logged request history. */
function toolOutput(history: string, tool: string): string {
  const match = history.match(
    new RegExp(`"name":"${tool}","response":\\{"output":"(.*?)"\\}\\]`),
  );
  return match?.[1] ?? '';
}

describe('omp port: internal URLs', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('writes and reads local://, and reads cfg:// and omp://', async () => {
    await rig.setup('omp port w2', {
      settings: {
        tools: { core: ['read_file', 'write_file'] },
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'exercise the internal URLs' });

    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');

    const logs = rig.readToolLogs();
    const readCalls = logs.filter((l) => l.toolRequest.name === 'read_file');
    const writeCalls = logs.filter((l) => l.toolRequest.name === 'write_file');

    // 1. A writable scheme accepts a write through the same tool.
    const localWrite = writeCalls.find((c) =>
      c.toolRequest.args.includes('local://notes.md'),
    );
    expect(localWrite, 'local:// was written to').toBeTruthy();
    expect(localWrite!.toolRequest.success).toBe(true);
    expect(localWrite!.toolRequest.error).toBeUndefined();

    // 2. The written file reads back, and a line selector still applies.
    expect(readCalls.length).toBe(4);
    const localRead = toolOutput(history, 'read_file');
    expect(localRead).toContain('line two');
    expect(localRead).toContain('line three');
    expect(localRead).not.toContain('line one');

    // 3. cfg:// answers a dotted settings key with the effective settings.
    expect(history).toContain('cfg://tools');
    expect(history).toContain('"read_file"');

    // 4. omp:// serves the harness's own documentation.
    expect(history).toContain('omp://index.md');

    // 5. A missing local:// target fails loudly instead of reading nothing.
    const missing = readCalls.find((c) =>
      c.toolRequest.args.includes('local://missing.md'),
    );
    expect(missing?.toolRequest.success).toBe(false);
  });
});
