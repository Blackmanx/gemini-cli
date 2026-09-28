/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w3.responses');

describe('omp port: coordination and code intelligence tools', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('registers wait and lsp, and lsp reports server state without one installed', async () => {
    await rig.setup('omp port w3', {
      settings: {
        tools: { core: ['wait', 'lsp', 'glob'] },
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'check the new tools' });

    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');
    const logs = rig.readToolLogs();

    // The wait barrier is registered and takes no parameters at all.
    const waitCall = logs.find((l) => l.toolRequest.name === 'wait');
    expect(waitCall, 'wait tool is registered').toBeTruthy();
    // Nothing is pending, so it must answer rather than hang.
    expect(waitCall!.toolRequest.success, waitCall!.toolRequest.error).toBe(
      true,
    );
    expect(history).toMatch(/nothing to wait for|Nothing to wait for/i);

    // `lsp status` answers even with no language server configured, rather
    // than failing: the model must be able to tell "none installed" apart
    // from "broken".
    const lspCalls = logs.filter((l) => l.toolRequest.name === 'lsp');
    expect(lspCalls.length, 'lsp ran twice').toBe(2);
    for (const call of lspCalls) {
      expect(call.toolRequest.success, call.toolRequest.error).toBe(true);
    }
    expect(history).toMatch(/No language servers are configured/i);

    // `lsp diagnostics` with file "*" runs the project's own type checker, so
    // it works with no language server at all.
    expect(history).toMatch(
      /No recognised project root|cargo check|tsc --noEmit/i,
    );
  });
});
