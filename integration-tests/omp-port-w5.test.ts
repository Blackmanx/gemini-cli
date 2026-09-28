/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w5.responses');

describe('omp port: subagent fan-out', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('runs a tasks[] batch as one call and names every branch', async () => {
    await rig.setup('omp port w5', {
      settings: { tools: { core: ['invoke_agent', 'read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'fan out' });

    const calls = rig
      .readToolLogs()
      .filter((l) => l.toolRequest.name === 'invoke_agent');

    // A batch is ONE tool call, not one call per subagent.
    expect(calls.length, 'a batch is a single tool call').toBe(1);
    expect(calls[0]!.toolRequest.args).toContain('"tasks"');
    expect(calls[0]!.toolRequest.success, calls[0]!.toolRequest.error).toBe(
      true,
    );

    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');

    // Every branch is named, whatever its outcome. A branch that failed must
    // still be visible rather than silently missing from the summary, and the
    // failure count must be honest — reporting 2/2 when neither branch ran
    // would be the worst possible summary.
    expect(history).toContain('### no_such_agent');
    expect(history).toContain('### also_missing');
    expect(history).toMatch(
      /Ran 2 subagents in parallel; 0 succeeded, 2 failed/,
    );
    expect(history).toContain("Subagent 'no_such_agent' not found.");
  });
});
