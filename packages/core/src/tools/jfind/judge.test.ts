/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { LlmRole } from '../../telemetry/llmRole.js';
import type { GenerateContentResponse } from '@google/genai';
import { GeminiJudge, parseJudgeAnswers, type Judge } from './judge.js';

interface MockClient {
  generateContent: ReturnType<typeof vi.fn>;
  registerRuntimeModelOverride: ReturnType<typeof vi.fn>;
}

function makeConfig(): MockClient & { config: Config } {
  const generateContent = vi.fn();
  const registerRuntimeModelOverride = vi.fn();
  const config = {
    getBaseLlmClient: () => ({ generateContent }),
    modelConfigService: { registerRuntimeModelOverride },
  } as unknown as Config;
  return { config, generateContent, registerRuntimeModelOverride };
}

function response(
  items: unknown,
  usage?: { promptTokenCount: number; candidatesTokenCount: number },
): GenerateContentResponse {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: JSON.stringify({ items }) }],
        },
      },
    ],
    ...(usage ? { usageMetadata: usage } : {}),
  } as unknown as GenerateContentResponse;
}

describe('parseJudgeAnswers', () => {
  it('clamps probabilities into [0,1] and keeps only requested keys', () => {
    const { answers } = parseJudgeAnswers(
      JSON.stringify({
        items: [
          { k: 'e000', p: 1.7 },
          { k: 'e001', p: -0.2 },
          { k: 'zzz9', p: 0.5 },
        ],
      }),
      ['e000', 'e001'],
    );
    expect(answers.get('e000')).toBe(1);
    expect(answers.get('e001')).toBe(0);
    expect(answers.has('zzz9')).toBe(false);
  });

  it('drops malformed rows instead of failing the batch', () => {
    const { answers } = parseJudgeAnswers(
      JSON.stringify({
        items: [
          { k: 'e000', p: 'high' },
          { k: 'e001', p: Number.NaN },
          'not-an-object',
          { k: 'e002', p: 0.3 },
        ],
      }),
      ['e000', 'e001', 'e002'],
    );
    expect([...answers.keys()]).toEqual(['e002']);
    expect(answers.get('e002')).toBe(0.3);
  });

  it('throws on non-JSON bodies and on objects without an items array', () => {
    expect(() => parseJudgeAnswers('not json', [])).toThrow(
      'judge returned invalid JSON',
    );
    expect(() => parseJudgeAnswers('{"foo": 1}', [])).toThrow(
      'missing an `items` array',
    );
    expect(() => parseJudgeAnswers('[1,2]', [])).toThrow(
      'missing an `items` array',
    );
  });
});

describe('GeminiJudge', () => {
  let mock: ReturnType<typeof makeConfig>;

  beforeEach(() => {
    mock = makeConfig();
  });

  it('requests the configured model under the jfind override scope and reports usage', async () => {
    mock.generateContent.mockResolvedValue(
      response(
        [
          { k: 'e000', p: 0.9 },
          { k: 'e001', p: 0.42 },
        ],
        { promptTokenCount: 100, candidatesTokenCount: 20 },
      ),
    );
    const judge = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    const answer = await judge.judge(
      { prompt: 'state-a', keys: ['e000', 'e001'] },
      {},
    );
    expect(answer.answers.get('e000')).toBe(0.9);
    expect(answer.answers.get('e001')).toBe(0.42);
    expect(answer.inputTokens).toBe(100);
    expect(answer.outputTokens).toBe(20);

    const call = mock.generateContent.mock.calls[0][0];
    expect(call.modelConfigKey).toEqual({
      model: 'gemini-3.1-flash-lite',
      overrideScope: 'jfind',
    });
    expect(call.contents[0].parts[0].text).toBe('state-a');
    expect(call.role).toBe(LlmRole.UTILITY_TOOL);
    expect(call.maxAttempts).toBe(2);
  });

  it('serves an identical repeat prompt from cache without a second request', async () => {
    mock.generateContent.mockResolvedValue(
      response([{ k: 'e000', p: 0.7 }], {
        promptTokenCount: 50,
        candidatesTokenCount: 10,
      }),
    );
    const judge = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    const request = { prompt: 'state-cache', keys: ['e000'] };
    const first = await judge.judge(request, {});
    const second = await judge.judge(request, {});
    expect(mock.generateContent).toHaveBeenCalledTimes(1);
    expect(first.inputTokens).toBe(50);
    // The cached replay is free.
    expect(second.inputTokens).toBe(0);
    expect(second.outputTokens).toBe(0);
    expect(second.answers.get('e000')).toBe(0.7);
  });

  it('never caches an incomplete batch, so a malformed answer is re-asked', async () => {
    mock.generateContent
      .mockResolvedValueOnce(response([{ k: 'e000', p: 0.9 }]))
      .mockResolvedValueOnce(
        response([
          { k: 'e000', p: 0.9 },
          { k: 'e001', p: 0.8 },
        ]),
      );
    const judge = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    const request = { prompt: 'state-partial', keys: ['e000', 'e001'] };
    const first = await judge.judge(request, {});
    expect(first.answers.size).toBe(1);
    const second = await judge.judge(request, {});
    expect(mock.generateContent).toHaveBeenCalledTimes(2);
    expect(second.answers.size).toBe(2);
  });

  it('registers the runtime override once per model-config service', () => {
    const first = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    const second = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    expect(first).toBeInstanceOf(GeminiJudge);
    expect(second).toBeInstanceOf(GeminiJudge);
    expect(mock.registerRuntimeModelOverride).toHaveBeenCalledTimes(1);
    const override = mock.registerRuntimeModelOverride.mock.calls[0][0];
    expect(override.match).toEqual({ overrideScope: 'jfind' });
    expect(override.modelConfig.generateContentConfig.responseMimeType).toBe(
      'application/json',
    );
  });

  it('propagates client failures and rejects empty responses', async () => {
    const judge = new GeminiJudge(mock.config, 'gemini-3.1-flash-lite');
    const request: Judge = judge;
    mock.generateContent.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(
      request.judge({ prompt: 'state-fail', keys: ['e000'] }, {}),
    ).rejects.toThrow('quota exceeded');

    mock.generateContent.mockResolvedValueOnce({
      candidates: [],
    } as unknown as GenerateContentResponse);
    await expect(
      request.judge({ prompt: 'state-empty', keys: ['e000'] }, {}),
    ).rejects.toThrow('judge returned an empty response');
  });
});
