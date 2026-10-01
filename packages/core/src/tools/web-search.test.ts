/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { WebSearchTool, type WebSearchToolParams } from './web-search.js';
import type { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import { ToolErrorType } from './tool-error.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';
import type * as DdgModule from './duckduckgo-search.js';
import { searchDuckDuckGo } from './duckduckgo-search.js';

// Mock GeminiClient and Config constructor
vi.mock('../core/client.js');
vi.mock('../config/config.js');
vi.mock('./duckduckgo-search.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DdgModule>()),
  searchDuckDuckGo: vi.fn(),
}));

describe('WebSearchTool', () => {
  const abortSignal = new AbortController().signal;
  let mockGeminiClient: GeminiClient;
  let tool: WebSearchTool;

  beforeEach(() => {
    const mockConfigInstance = {
      getGeminiClient: () => mockGeminiClient,
      get geminiClient() {
        return mockGeminiClient;
      },
      getProxy: () => undefined,
      generationConfigService: {
        getResolvedConfig: vi.fn().mockImplementation(({ model }) => ({
          model,
          sdkConfig: {},
        })),
      },
    } as unknown as Config;
    (
      mockConfigInstance as unknown as { config: Config; promptId: string }
    ).config = mockConfigInstance;
    (
      mockConfigInstance as unknown as { config: Config; promptId: string }
    ).promptId = 'test-prompt-id';
    mockGeminiClient = new GeminiClient(mockConfigInstance);
    tool = new WebSearchTool(mockConfigInstance, createMockMessageBus());
    // Default to "no results" so the grounding tests below keep exercising
    // grounding rather than tripping the DuckDuckGo branch.
    vi.mocked(searchDuckDuckGo).mockResolvedValue({
      results: [],
      blocked: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('build', () => {
    it('should return an invocation for a valid query', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('should throw an error for an empty query', () => {
      const params: WebSearchToolParams = { query: '' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });

    it('should throw an error for a query with only whitespace', () => {
      const params: WebSearchToolParams = { query: '   ' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });
  });

  describe('getDescription', () => {
    it('should return a description of the search', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        'Searching the web for: "test query"',
      );
    });
  });

  describe('execute', () => {
    it('should return search results for a successful query', async () => {
      const params: WebSearchToolParams = { query: 'successful query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Here are your results.' }],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).toBe(
        'Web search results for "successful query":\n\n<untrusted_context>\nHere are your results.\n</untrusted_context>',
      );
      expect(result.returnDisplay).toBe(
        'Search results for "successful query" returned.',
      );
      // An empty list rather than undefined: the answer arrived, it just
      // carried no citations.
      expect(result.sources).toEqual([]);
    });

    it('sends recency to grounding as a server-side time range', async () => {
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Recent answer.' }] },
          },
        ],
      });

      const invocation = tool.build({
        query: 'recent query',
        recency: 'week',
      });
      await invocation.execute({ abortSignal });

      const override = (mockGeminiClient.generateContent as Mock).mock
        .calls[0][4] as
        | { tools: Array<{ googleSearch: { timeRangeFilter: unknown } }> }
        | undefined;
      expect(override?.tools[0].googleSearch.timeRangeFilter).toEqual({
        startTime: expect.any(String),
        endTime: expect.any(String),
      });
    });

    it('sends no override when no recency window was asked for', async () => {
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Any answer.' }] },
          },
        ],
      });

      const invocation = tool.build({ query: 'no recency' });
      await invocation.execute({ abortSignal });

      expect((mockGeminiClient.generateContent as Mock).mock.calls[0][4]).toBe(
        undefined,
      );
    });

    it('does not read source pages unless asked', async () => {
      const params: WebSearchToolParams = { query: 'titles only' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'An answer.' }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { title: 'Doc', uri: 'https://example.com/a' } },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(mockGeminiClient.generateContent).toHaveBeenCalledTimes(1);
      expect(result.llmContent).not.toContain('Page content:');
    });

    it('reads source pages when fetch_sources is set', async () => {
      const params: WebSearchToolParams = {
        query: 'with content',
        fetch_sources: true,
      };
      (mockGeminiClient.generateContent as Mock)
        .mockResolvedValueOnce({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'An answer.' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { title: 'Doc', uri: 'https://example.com/a' } },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: 'The page documents installStep 3 requires Node 20.',
                  },
                ],
              },
            },
          ],
        });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(mockGeminiClient.generateContent).toHaveBeenCalledTimes(2);
      expect(result.llmContent).toContain('Page content:');
      expect(result.llmContent).toContain('Node 20');
    });

    it('warns the model when sources carry no attribution', async () => {
      const params: WebSearchToolParams = { query: 'unattributed query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'A claim with no citation.' }],
            },
            groundingMetadata: {
              webSearchQueries: ['unattributed query'],
              groundingChunks: [
                { web: { title: 'Doc', uri: 'https://example.com/a' } },
              ],
              // No groundingSupports: sources exist but nothing is attributed.
              groundingSupports: [],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.sources).toHaveLength(1);
      expect(result.llmContent).toContain(
        'came back without per-claim citations',
      );
      expect(result.llmContent).toContain('https://example.com/a');
    });

    it('omits the attribution warning when supports are present', async () => {
      const params: WebSearchToolParams = { query: 'attributed query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'A cited claim[1].' }],
            },
            groundingMetadata: {
              webSearchQueries: ['attributed query'],
              groundingChunks: [
                { web: { title: 'Doc', uri: 'https://example.com/a' } },
              ],
              groundingSupports: [
                {
                  segment: { startIndex: 0, endIndex: 13 },
                  groundingChunkIndices: [0],
                },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).not.toContain(
        'came back without per-claim citations',
      );
      expect(result.llmContent).toContain('https://example.com/a');
    });

    it('should handle no search results found', async () => {
      const params: WebSearchToolParams = { query: 'no results query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: '' }],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).toBe(
        'No search results or information found for query: "no results query"',
      );
      expect(result.returnDisplay).toBe('No information found.');
    });

    it('should return a WEB_SEARCH_FAILED error on failure', async () => {
      const params: WebSearchToolParams = { query: 'error query' };
      const testError = new Error('API Failure');
      (mockGeminiClient.generateContent as Mock).mockRejectedValue(testError);

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_FAILED);
      expect(result.llmContent).toContain('Error:');
      expect(result.llmContent).toContain('API Failure');
      expect(result.returnDisplay).toBe('Error performing web search.');
    });

    it('should correctly format results with sources and citations wrapped in untrusted_context', async () => {
      const params: WebSearchToolParams = { query: 'grounding query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'This is a test response.' }],
            },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example Site' } },
                { web: { uri: 'https://google.com', title: 'Google' } },
              ],
              groundingSupports: [
                {
                  segment: { startIndex: 5, endIndex: 14 },
                  groundingChunkIndices: [0],
                },
                {
                  segment: { startIndex: 15, endIndex: 24 },
                  groundingChunkIndices: [0, 1],
                },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      const expectedLlmContent = `Web search results for "grounding query":

<untrusted_context>
This is a test[1] response.[1][2]

Sources:
[1] Example Site (https://example.com)
[2] Google (https://google.com)
</untrusted_context>`;

      expect(result.llmContent).toBe(expectedLlmContent);
      expect(result.returnDisplay).toBe(
        'Search results for "grounding query" returned.',
      );
      expect(result.sources).toHaveLength(2);
    });

    it('should insert markers at correct byte positions for multibyte text', async () => {
      const params: WebSearchToolParams = { query: 'multibyte query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'こんにちは! Gemini CLI✨️' }],
            },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: 'Japanese Greeting',
                    uri: 'https://example.test/japanese-greeting',
                  },
                },
                {
                  web: {
                    title: 'google-gemini/gemini-cli',
                    uri: 'https://github.com/google-gemini/gemini-cli',
                  },
                },
                {
                  web: {
                    title: 'Gemini CLI: your open-source AI agent',
                    uri: 'https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/',
                  },
                },
              ],
              groundingSupports: [
                {
                  segment: {
                    // Byte range of "こんにちは!" (utf-8 encoded)
                    startIndex: 0,
                    endIndex: 16,
                  },
                  groundingChunkIndices: [0],
                },
                {
                  segment: {
                    // Byte range of "Gemini CLI✨️" (utf-8 encoded)
                    startIndex: 17,
                    endIndex: 33,
                  },
                  groundingChunkIndices: [1, 2],
                },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      const expectedLlmContent = `Web search results for "multibyte query":

<untrusted_context>
こんにちは![1] Gemini CLI✨️[2][3]

Sources:
[1] Japanese Greeting (https://example.test/japanese-greeting)
[2] google-gemini/gemini-cli (https://github.com/google-gemini/gemini-cli)
[3] Gemini CLI: your open-source AI agent (https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/)
</untrusted_context>`;

      expect(result.llmContent).toBe(expectedLlmContent);
      expect(result.returnDisplay).toBe(
        'Search results for "multibyte query" returned.',
      );
      expect(result.sources).toHaveLength(3);
    });

    it('answers from DuckDuckGo with snippets and skips grounding', async () => {
      vi.mocked(searchDuckDuckGo).mockResolvedValue({
        results: [
          {
            title: 'Backpressuring in Streams',
            url: 'https://example.com/bp',
            snippet: 'Why backpressure matters.',
            publishedDate: '2025-01-31',
          },
        ],
        blocked: false,
      });

      const invocation = tool.build({ query: 'stream backpressure' });
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).toContain('Backpressuring in Streams');
      expect(result.llmContent).toContain('Why backpressure matters.');
      expect(result.llmContent).toContain('Published: 2025-01-31');
      // The whole point: the model never spends a grounding call here.
      expect(mockGeminiClient.generateContent).not.toHaveBeenCalled();
    });

    it('falls back to grounding when DuckDuckGo is blocked', async () => {
      vi.mocked(searchDuckDuckGo).mockResolvedValue({
        results: [],
        blocked: true,
      });
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Grounded answer.' }] },
          },
        ],
      });

      const invocation = tool.build({ query: 'blocked query' });
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).toContain('Grounded answer.');
      expect(mockGeminiClient.generateContent).toHaveBeenCalledTimes(1);
    });

    it('reports an error instead of silently swapping backends when pinned', async () => {
      vi.mocked(searchDuckDuckGo).mockResolvedValue({
        results: [],
        blocked: true,
      });

      const invocation = tool.build({
        query: 'pinned query',
        provider: 'duckduckgo',
      });
      const result = await invocation.execute({ abortSignal });

      expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_FAILED);
      // Pinned means pinned: no silent substitution.
      expect(mockGeminiClient.generateContent).not.toHaveBeenCalled();
    });

    it('skips DuckDuckGo entirely when grounding is pinned', async () => {
      const invocation = tool.build({
        query: 'grounding only',
        provider: 'grounding',
      });
      await invocation.execute({ abortSignal });

      expect(searchDuckDuckGo).not.toHaveBeenCalled();
    });
  });
});
