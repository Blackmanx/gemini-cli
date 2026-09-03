/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Type, type GenerateContentParameters } from '@google/genai';
import {
  VllmContentGenerator,
  fetchVllmModels,
  normalizeVllmBaseUrl,
  convertContentsToOpenAiMessages,
  convertToolsToOpenAiTools,
} from './vllmContentGenerator.js';
import { LlmRole } from '../telemetry/llmRole.js';
import type { ContentGenerator } from './contentGenerator.js';

describe('vllmContentGenerator', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('normalizeVllmBaseUrl', () => {
    it('strips trailing slashes and whitespace', () => {
      expect(normalizeVllmBaseUrl('  http://localhost:8000/  ')).toBe(
        'http://localhost:8000',
      );
      expect(normalizeVllmBaseUrl('http://localhost:8000/v1/')).toBe(
        'http://localhost:8000/v1',
      );
    });
  });

  describe('fetchVllmModels', () => {
    it('returns model IDs from server response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
            { id: 'meta-llama/Llama-3.3-70B-Instruct' },
          ],
        }),
      } as unknown as Response);

      const models = await fetchVllmModels(
        'http://localhost:8000',
        'secret-key',
      );
      expect(models).toEqual([
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Llama-3.3-70B-Instruct',
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/models',
        expect.objectContaining({
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer secret-key',
          },
        }),
      );
    });

    it('returns empty array when server returns an error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);

      const models = await fetchVllmModels('http://localhost:8000');
      expect(models).toEqual([]);
    });

    it('returns empty array on network exception', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('Network failure'));

      const models = await fetchVllmModels('http://localhost:8000');
      expect(models).toEqual([]);
    });
  });

  describe('convertContentsToOpenAiMessages', () => {
    it('converts system instructions and simple user/assistant dialogue', () => {
      const messages = convertContentsToOpenAiMessages(
        [
          { role: 'user', parts: [{ text: 'Hello!' }] },
          { role: 'model', parts: [{ text: 'Greetings!' }] },
        ],
        'You are a helpful assistant.',
      );

      expect(messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Greetings!' },
      ]);
    });

    it('converts function calls and function responses', () => {
      const messages = convertContentsToOpenAiMessages([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_abc',
                name: 'run_command',
                args: { command: 'ls -la' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_abc',
                name: 'run_command',
                response: { output: 'file1.txt' },
              },
            },
          ],
        },
      ]);

      expect(messages).toEqual([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({ command: 'ls -la' }),
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_abc',
          content: JSON.stringify({ output: 'file1.txt' }),
        },
      ]);
    });
  });

  describe('convertToolsToOpenAiTools', () => {
    it('converts function declarations to OpenAI tools format', () => {
      const tools = convertToolsToOpenAiTools([
        {
          functionDeclarations: [
            {
              name: 'calculator',
              description: 'Performs math',
              parameters: {
                type: Type.OBJECT,
                properties: { expr: { type: Type.STRING } },
              },
            },
          ],
        },
      ]);

      expect(tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Performs math',
            parameters: {
              type: Type.OBJECT,
              properties: { expr: { type: Type.STRING } },
            },
          },
        },
      ]);
    });
  });

  describe('VllmContentGenerator', () => {
    const baseUrl = 'http://localhost:8000';
    const apiKey = 'test-api-key';

    it('generates non-streaming content successfully for any custom model', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-123',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Response from Qwen 2.5',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        }),
      } as unknown as Response);

      const generator = new VllmContentGenerator(baseUrl, apiKey);
      const req: GenerateContentParameters = {
        model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      };

      const result = await generator.generateContent(
        req,
        'prompt-1',
        LlmRole.MAIN,
      );

      expect(result.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
        'Response from Qwen 2.5',
      );
      expect(result.usageMetadata?.totalTokenCount).toBe(18);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('Qwen/Qwen2.5-Coder-32B-Instruct'),
        }),
      );
    });

    it('handles function calling in non-streaming responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'fetch_weather',
                      arguments: '{"city":"Berlin"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      } as unknown as Response);

      const generator = new VllmContentGenerator(baseUrl);
      const req: GenerateContentParameters = {
        model: 'mistralai/Mistral-7B-Instruct-v0.3',
        contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
      };

      const result = await generator.generateContent(
        req,
        'prompt-2',
        LlmRole.MAIN,
      );
      const fnCalls = (
        result as unknown as {
          functionCalls?: Array<{ name: string; args: unknown }>;
        }
      ).functionCalls;

      expect(fnCalls).toHaveLength(1);
      expect(fnCalls?.[0]?.name).toBe('fetch_weather');
      expect(fnCalls?.[0]?.args).toEqual({ city: 'Berlin' });
    });

    it('falls back to fallbackGenerator when endpoint returns 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as unknown as Response);

      const mockFallback = {
        generateContent: vi.fn().mockResolvedValue({
          candidates: [{ content: { parts: [{ text: 'Fallback response' }] } }],
        }),
      } as unknown as ContentGenerator;

      const generator = new VllmContentGenerator(
        baseUrl,
        apiKey,
        {},
        mockFallback,
      );
      const req: GenerateContentParameters = {
        model: 'my-custom-model',
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      };

      const result = await generator.generateContent(
        req,
        'prompt-3',
        LlmRole.MAIN,
      );
      expect(result.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
        'Fallback response',
      );
      expect(mockFallback.generateContent).toHaveBeenCalled();
    });

    it('generates streaming content and accumulates tool calls', async () => {
      const sseData = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ' world' } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_99',
                    function: { name: 'search', arguments: '{"query": ' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"vitest"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      } as unknown as Response);

      const generator = new VllmContentGenerator(baseUrl);
      const req: GenerateContentParameters = {
        model: 'meta-llama/Llama-3.1-8B-Instruct',
        contents: [{ role: 'user', parts: [{ text: 'Stream test' }] }],
      };

      const asyncGen = await generator.generateContentStream(
        req,
        'prompt-4',
        LlmRole.MAIN,
      );
      const chunks = [];
      for await (const chunk of asyncGen) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe(
        'Hello',
      );
      expect(chunks[1].candidates?.[0]?.content?.parts?.[0]?.text).toBe(
        ' world',
      );

      // Check tool call chunk
      const toolChunk = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall),
      );
      expect(toolChunk).toBeDefined();
      expect(
        toolChunk?.candidates?.[0]?.content?.parts?.[0]?.functionCall,
      ).toEqual({
        id: 'call_99',
        name: 'search',
        args: { query: 'vitest' },
      });
    });

    it('counts tokens based on content length', async () => {
      const generator = new VllmContentGenerator(baseUrl);
      const res = await generator.countTokens({
        model: 'default',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'This is a sample sentence with 38 chars' }],
          },
        ],
      });
      expect(res.totalTokens).toBe(10);
    });
  });
});
