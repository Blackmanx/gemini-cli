/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { createMockMessageBus } from '../../test-utils/mock-message-bus.js';
import { ToolErrorType } from '../tool-error.js';
import { Kind } from '../tools.js';
import { JfindTool, type JfindParams } from './jfind.js';

/** The subset of the client call the canned judge actually reads. */
interface JudgeCallOptions {
  contents: Array<{ parts: Array<{ text: string }> }>;
}

/** A judge stand-in that answers every question key of every phase with 0.9. */
function allHighClient(): ReturnType<typeof vi.fn> {
  return vi.fn(async (options: JudgeCallOptions) => {
    const prompt: string = options.contents[0].parts[0].text;
    const keys = [...prompt.matchAll(/^- ([ep]\d+):/gm)].map((m) => m[1]);
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  items: keys.map((k) => ({ k, p: 0.9 })),
                }),
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
    };
  });
}

describe('JfindTool', () => {
  let tempRootDir: string;
  let tool: JfindTool;
  let generateContent: ReturnType<typeof vi.fn>;
  const abortSignal = new AbortController().signal;

  beforeEach(async () => {
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-tool-'));
    await fs.mkdir(path.join(tempRootDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tempRootDir, 'src', 'login.ts'),
      'export function doLogin(user: string) {\n' +
        '  const session = createSession(user);\n' +
        '  return session;\n' +
        '}\n',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'src', 'noise.ts'),
      'export const noise = 1;\n',
    );
    await fs.writeFile(
      path.join(tempRootDir, 'package.json'),
      '{\n  "name": "fixture"\n}\n',
    );

    generateContent = allHighClient();
    const mockConfig = {
      getTargetDir: () => tempRootDir,
      getFileExclusions: () => ({ getGlobExcludes: () => [] }),
      validatePathAccess: () => null,
      getJfindJudgeModel: () => 'gemini-3.1-flash-lite',
      getBaseLlmClient: () => ({ generateContent }),
      modelConfigService: { registerRuntimeModelOverride: vi.fn() },
    } as unknown as Config;
    tool = new JfindTool(mockConfig, createMockMessageBus());
  });

  afterEach(async () => {
    await fs.rm(tempRootDir, { recursive: true, force: true });
  });

  it('is a search tool under the jfind name', () => {
    expect(tool.name).toBe('jfind');
    expect(tool.kind).toBe(Kind.Search);
  });

  it('returns ranked hits with ranges, gauges, and the token footer', async () => {
    const result = await tool
      .build({ query: 'doLogin session' })
      .execute({ abortSignal });

    expect(result.error).toBeUndefined();
    // Every eligible file judges at 0.9 with the all-high client.
    expect(result.llmContent).toContain('3 hit(s) for "doLogin session"');
    expect(result.llmContent).toContain('src/login.ts');
    expect(result.llmContent).toMatch(/src\/login\.ts:\d+(-\d+)?\s+0\.90\s/);
    expect(result.llmContent).toContain('judge tokens');
    expect(result.llmContent).toContain('judge tokens (gemini-3.1-flash-lite)');
    expect(result.returnDisplay).toContain('█');
    expect(result.returnDisplay).toContain('src/login.ts');
    expect(result.returnDisplay).toContain(
      'judge tokens (gemini-3.1-flash-lite)',
    );
  });

  it('scopes the search and the report to an explicit path', async () => {
    const result = await tool
      .build({ query: 'doLogin', path: 'src' })
      .execute({ abortSignal });
    expect(result.llmContent).toContain('for "doLogin" in src');
    // package.json lives outside src and is no longer listed or read.
    expect(result.llmContent).toContain('2 hit(s)');
    expect(result.llmContent).not.toContain('package.json  0.90');
  });

  it('flags a dead judge as an error instead of a clean empty result', async () => {
    generateContent.mockRejectedValue(new Error('quota exceeded'));
    const result = await tool
      .build({ query: 'doLogin' })
      .execute({ abortSignal });
    expect(result.error?.type).toBe(ToolErrorType.GREP_EXECUTION_ERROR);
    expect(result.error?.message).toMatch(/all \d+ judge requests failed/);
    expect(result.llmContent).toContain('judge requests failed');
    expect(result.llmContent).toContain('quota exceeded');
  });

  describe('validateToolParams', () => {
    it('accepts a plain query and a query scoped to a real path', () => {
      expect(tool.validateToolParams({ query: 'login flow' })).toBeNull();
      expect(
        tool.validateToolParams({ query: 'login flow', path: '.' }),
      ).toBeNull();
    });

    it('rejects an empty query and a missing path', () => {
      expect(tool.validateToolParams({ query: '   ' })).toBe(
        'query must be a non-empty description',
      );
      expect(tool.validateToolParams({} as unknown as JfindParams)).toContain(
        'query',
      );
      expect(
        tool.validateToolParams({ query: 'x', path: 'does-not-exist' }),
      ).toContain('Path does not exist');
    });
  });
});
