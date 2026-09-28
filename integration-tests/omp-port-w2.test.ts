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

  it('writes, reads, globs, greps and edits through a scheme:// URL', async () => {
    await rig.setup('omp port w2', {
      settings: {
        tools: {
          core: ['read_file', 'write_file', 'glob', 'grep_search', 'replace'],
        },
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'exercise the internal URLs' });

    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');

    const logs = rig.readToolLogs();
    const callsFor = (name: string) =>
      logs.filter((l) => l.toolRequest.name === name);
    const readCalls = callsFor('read_file');

    // 1. A writable scheme accepts a write through the same tool.
    const localWrite = callsFor('write_file').find((c) =>
      c.toolRequest.args.includes('local://notes.md'),
    );
    expect(localWrite, 'local:// was written to').toBeTruthy();
    expect(localWrite!.toolRequest.success).toBe(true);

    // 2. The written file reads back, and a line selector still applies.
    const localRead = toolOutput(history, 'read_file');
    expect(localRead).toContain('line two');
    expect(localRead).toContain('line three');
    expect(localRead).not.toContain('line one');

    // 3. glob walks the scheme's own tree, not the workspace.
    const globCall = callsFor('glob')[0];
    expect(globCall, 'glob ran once').toBeTruthy();
    expect(
      globCall!.toolRequest.success,
      `glob failed: ${globCall!.toolRequest.error ?? '(no error)'}`,
    ).toBe(true);
    expect(globCall!.toolRequest.args).toContain('local://');
    const globOut = toolOutput(history, 'glob');
    expect(globOut).toContain('notes.md');

    // 4. grep searches the scheme's tree and reports a real line.
    const grepCall = callsFor('grep_search')[0];
    expect(grepCall, 'grep ran once').toBeTruthy();
    expect(
      grepCall!.toolRequest.success,
      `grep failed: ${grepCall!.toolRequest.error ?? '(no error)'}`,
    ).toBe(true);
    const grepOut = toolOutput(history, 'grep_search');
    expect(grepOut).toContain('L2:');
    expect(grepOut).toContain('line two');

    // 5. edit writes through the same URL, and the change is durable.
    const editCall = callsFor('replace')[0];
    expect(editCall, 'edit ran once').toBeTruthy();
    expect(
      editCall!.toolRequest.success,
      `edit failed: ${editCall!.toolRequest.error ?? '(no error)'}`,
    ).toBe(true);

    // 6. cfg:// answers a dotted settings key; omp:// serves the docs.
    expect(history).toContain('cfg://tools');
    expect(history).toContain('"read_file"');
    expect(history).toContain('omp://index.md');

    // 7. A missing local:// target fails loudly instead of reading nothing.
    const missing = readCalls.find((c) =>
      c.toolRequest.args.includes('local://missing.md'),
    );
    expect(missing?.toolRequest.success).toBe(false);

    // 8. agent:// addresses a sibling subagent. With none running it says so
    // plainly rather than returning an empty document, and a message to an
    // agent that does not exist fails instead of vanishing.
    expect(history).toContain('No agents are running.');
    const ghostWrite = callsFor('write_file').find((c) =>
      c.toolRequest.args.includes('agent://a1'),
    );
    expect(
      ghostWrite,
      'a message to a missing agent was attempted',
    ).toBeTruthy();
    expect(ghostWrite!.toolRequest.success).toBe(false);
    expect(ghostWrite!.toolRequest.error).toContain('no such agent');

    // 9. xd:// lists the mounted devices, and reading one shows its schema —
    // so the model can look up a parameter set without a tool per flow.
    expect(history).toContain('mounted tool devices');
    expect(history).toContain('xd://read_file');
    expect(history).toContain('file_path');

    const ghostDevice = callsFor('write_file').find((c) =>
      c.toolRequest.args.includes('xd://nope'),
    );
    expect(
      ghostDevice,
      'a call to an unmounted device was attempted',
    ).toBeTruthy();
    expect(ghostDevice!.toolRequest.success).toBe(false);
    expect(ghostDevice!.toolRequest.error).toContain('no such device');
  });
});
