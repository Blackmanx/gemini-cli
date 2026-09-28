/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w7.responses');

describe('omp port: memory tools', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('retains, recalls, and reports an empty recall as a plain answer', async () => {
    await rig.setup('omp port w7', {
      settings: {
        tools: { core: ['retain', 'recall', 'reflect', 'write_file'] },
        useMemory: true,
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'remember something' });

    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');
    const logs = rig.readToolLogs();
    const byName = (name: string) =>
      logs.filter((l) => l.toolRequest.name === name);

    const retain = byName('retain');
    expect(retain.length, 'retain ran once').toBe(1);
    expect(retain[0]!.toolRequest.success, retain[0]!.toolRequest.error).toBe(
      true,
    );
    expect(history).toContain('1 memory stored');

    // The retained fact comes back, stem-matched from "backups" to "backup".
    const recall = byName('recall');
    expect(recall.length, 'recall ran twice').toBe(2);
    for (const call of recall) {
      expect(call.toolRequest.success, call.toolRequest.error).toBe(true);
    }
    expect(history).toContain('Found 1 relevant memory');
    expect(history).toContain('The nightly job runs backups to cold storage.');

    // An empty recall is a normal answer, not an error the model gets punished
    // for — it must not be reported as a failed tool call.
    expect(history).toContain('No relevant memories found.');

    const reflect = byName('reflect');
    expect(reflect.length, 'reflect ran once').toBe(1);
    expect(reflect[0]!.toolRequest.success, reflect[0]!.toolRequest.error).toBe(
      true,
    );
    expect(history).toContain(
      'Nothing in the memory bank bears on that question',
    );
  });
});
