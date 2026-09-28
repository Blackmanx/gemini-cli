/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w1.responses');

describe('omp port: files and search', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('serves line selectors, directory reads, limited globs, executable shebangs, and refuses generated files', async () => {
    await rig.setup('omp port w1', {
      settings: {
        tools: { core: ['read_file', 'glob', 'write_file', 'grep'] },
      },
      fakeResponsesPath: RESPONSES,
    });

    const testDir = rig.testDir!;
    writeFileSync(
      join(testDir, 'notes.txt'),
      ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n') + '\n',
    );
    mkdirSync(join(testDir, 'src', 'deep'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(testDir, 'src', 'deep', 'b.ts'),
      'export const b = 2;\n',
    );
    writeFileSync(join(testDir, 'src', 'c.txt'), 'not typescript\n');
    // Written by the model during the run, so seed a placeholder only: the
    // generated-file guard must reject the model's write.
    writeFileSync(join(testDir, 'api.pb.go'), 'SEED\n');

    await rig.run({ args: 'exercise the file tools' });

    // The API request log carries every request, so a later turn's body
    // contains the previous turn's tool results. That is where the rendered
    // output is observable from outside the process.
    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');

    const logs = rig.readToolLogs();
    const readCalls = logs.filter((l) => l.toolRequest.name === 'read_file');
    const globCalls = logs.filter((l) => l.toolRequest.name === 'glob');
    const writeCalls = logs.filter((l) => l.toolRequest.name === 'write_file');

    // 1. A path-embedded selector returns exactly the requested lines.
    expect(readCalls.length, 'read_file ran twice').toBe(2);
    expect(readCalls[0]!.toolRequest.args).toContain('notes.txt:2-3');
    expect(readCalls[0]!.toolRequest.success).toBe(true);
    expect(history).toContain('bravo');
    expect(history).toContain('charlie');
    expect(history).not.toContain('alpha');
    expect(history).not.toContain('delta');

    // 2. A directory renders as a shallow tree instead of erroring out.
    expect(readCalls[1]!.toolRequest.success).toBe(true);
    expect(history).toContain('Directory listing');

    // 3. glob honours `limit` and folds the result into a tree.
    expect(globCalls.length, 'glob ran once').toBe(1);
    expect(globCalls[0]!.toolRequest.args).toMatch(/"limit":\s*2/);
    expect(globCalls[0]!.toolRequest.success).toBe(true);
    // Scope the check to the glob result itself: the session context block
    // names every workspace file and would make a bare `toContain` vacuous.
    const globOutput = history.match(
      /"name":"glob","response":\{"output":"(.*?)"\}\]/,
    )?.[1];
    expect(globOutput, 'the glob response is in the request log').toBeTruthy();
    expect(globOutput).toContain('a.ts');
    // `*.ts` now recurses, so src/deep/b.ts is found...
    expect(globOutput).toContain('b.ts');
    // ...while the non-matching c.txt is not.
    expect(globOutput).not.toContain('c.txt');
    // The result is folded into a tree rather than a flat path list.
    expect(globOutput).toContain('# src/');

    // 4. A shebang makes the written file executable.
    const runPath = join(testDir, 'run.sh');
    expect(statSync(runPath).mode & 0o111, 'run.sh is executable').not.toBe(0);

    // 5. A generated file is refused, and the placeholder is left untouched.
    const generatedWrite = writeCalls.find((c) =>
      c.toolRequest.args.includes('api.pb.go'),
    );
    expect(generatedWrite, 'the generated file was written to').toBeTruthy();
    expect(generatedWrite!.toolRequest.success).toBe(false);
    expect(generatedWrite!.toolRequest.error).toContain('auto-generated');
    expect(statSync(join(testDir, 'api.pb.go')).size).toBeGreaterThan(0);
  });
});
