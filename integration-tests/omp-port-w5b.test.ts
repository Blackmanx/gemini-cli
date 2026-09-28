/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w5b.responses');

describe('omp port: phased todos', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('renders phases, and refuses both forms at once', async () => {
    await rig.setup('omp port w5b', {
      settings: {
        tools: { core: ['write_todos', 'read_file'] },
        // write_todos still registers only on Gemini 2 models (a pre-existing
        // legacy gate), so the test has to name one.
        model: { name: 'gemini-2.5-flash' },
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'plan this in stages' });

    const calls = rig
      .readToolLogs()
      .filter((l) => l.toolRequest.name === 'write_todos');
    expect(calls.length, 'write_todos ran twice').toBe(2);

    // The phased call succeeds and the phase headings survive into the model.
    expect(calls[0]!.toolRequest.success, calls[0]!.toolRequest.error).toBe(
      true,
    );
    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');
    expect(history).toContain('Survey');
    expect(history).toContain('Change');
    expect(history).toContain('Update the failing assertion');

    // Both forms at once is ambiguous — one list, two renderings — so it is
    // refused rather than silently resolved in favour of one of them.
    expect(calls[1]!.toolRequest.success).toBe(false);
    expect(calls[1]!.toolRequest.error).toContain('not both');
  });
});
