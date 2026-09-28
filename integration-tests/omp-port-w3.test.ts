/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w3.responses');

/**
 * The tag in the fixture is `fileHash('alpha\nbravo\ncharlie\n')`, so the
 * patch is anchored to exactly the content the model was shown.
 */
const ANCHORED_PATCH = '[notes.txt#4F07]\nPUT 2.=2:\n+BRAVO\n';
const STALE_PATCH = '[notes.txt#0000]\nPUT 2.=2:\n+BRAVO\n';

describe('omp port: hashline edit', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('applies an edit anchored to the content that was read', async () => {
    await rig.setup('omp port w3', {
      settings: { tools: { core: ['read_file', 'hashline_edit'] } },
      fakeResponsesPath: RESPONSES,
    });

    const file = join(rig.testDir!, 'notes.txt');
    writeFileSync(file, 'alpha\nbravo\ncharlie\n');

    await rig.run({ args: 'read the notes, then fix line 2' });

    const logs = rig.readToolLogs();
    const read = logs.find((l) => l.toolRequest.name === 'read_file');
    expect(read, 'read_file ran').toBeTruthy();
    expect(read!.toolRequest.success, read!.toolRequest.error).toBe(true);

    // The patch was the one the fixture sent — anchored to the read content.
    const edit = logs.find((l) => l.toolRequest.name === 'hashline_edit');
    expect(edit, 'hashline_edit ran').toBeTruthy();
    expect(edit!.toolRequest.args).toContain('4F07');
    expect(ANCHORED_PATCH).toContain('4F07');
    expect(STALE_PATCH).toContain('0000');

    // Surface the tool's own verdict so a failure says why, not just that.
    expect(
      edit!.toolRequest.success,
      `hashline_edit failed: ${edit!.toolRequest.error ?? '(no error)'}`,
    ).toBe(true);

    // The file on disk is the proof that the anchored edit applied.
    expect(readFileSync(file, 'utf8')).toBe('alpha\nBRAVO\ncharlie\n');
  });
});
