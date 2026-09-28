/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w7c.responses');

describe('omp port: checkpoint and rewind', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('rewinds once and refuses a second rewind', async () => {
    await rig.setup('omp port w7c', {
      settings: { tools: { core: ['checkpoint', 'rewind_context'] } },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'explore, then collapse' });

    const calls = rig
      .readToolLogs()
      .filter(
        (l) =>
          l.toolRequest.name === 'checkpoint' ||
          l.toolRequest.name === 'rewind_context',
      );

    const checkpoint = calls.filter((l) => l.toolRequest.name === 'checkpoint');
    const rewinds = calls.filter(
      (l) => l.toolRequest.name === 'rewind_context',
    );

    expect(checkpoint.length, 'checkpoint ran once').toBe(1);
    expect(
      checkpoint[0]!.toolRequest.success,
      checkpoint[0]!.toolRequest.error,
    ).toBe(true);

    expect(rewinds.length, 'rewind ran twice').toBe(2);
    expect(rewinds[0]!.toolRequest.success, rewinds[0]!.toolRequest.error).toBe(
      true,
    );

    // The second rewind is refused. The context it would collapse has already
    // been discarded, so a "successful" second rewind would be a lie.
    expect(rewinds[1]!.toolRequest.success).toBe(false);
    expect(rewinds[1]!.toolRequest.error).toContain('already been completed');
  });
});
