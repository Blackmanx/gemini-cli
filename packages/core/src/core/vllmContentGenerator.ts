/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  type Content,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { debugLogger } from '../utils/debugLogger.js';

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAiChatCompletionChoice {
  index: number;
  message?: {
    role: string;
    content?: string | null;
    tool_calls?: OpenAiToolCall[];
  };
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAiChatCompletionResponse {
  id?: string;
  choices: OpenAiChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Normalizes the base URL for vLLM API calls.
 */
export function normalizeVllmBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function getChatCompletionsUrl(baseUrl: string): string {
  const norm = normalizeVllmBaseUrl(baseUrl);
  if (norm.endsWith('/v1')) {
    return `${norm}/chat/completions`;
  }
  return `${norm}/v1/chat/completions`;
}

function getModelsUrl(baseUrl: string): string {
  const norm = normalizeVllmBaseUrl(baseUrl);
  if (norm.endsWith('/v1')) {
    return `${norm}/models`;
  }
  return `${norm}/v1/models`;
}

/**
 * Fetches available models from a vLLM server via GET /v1/models.
 */
export async function fetchVllmModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  try {
    const url = getModelsUrl(baseUrl);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (apiKey?.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    if (Array.isArray(data.data)) {
      return data.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
    return [];
  } catch (e) {
    debugLogger.warn('Failed to fetch models from vLLM server:', e);
    return [];
  }
}

/**
 * Maps Gemini contents & system instructions to OpenAI messages.
 */
export function convertContentsToOpenAiMessages(
  contents: Content[] = [],
  systemInstruction?: GenerateContentParameters['config'] extends {
    systemInstruction?: infer S;
  }
    ? S
    : unknown,
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];

  // Add system instruction if present
  if (systemInstruction) {
    let sysText = '';
    if (typeof systemInstruction === 'string') {
      sysText = systemInstruction;
    } else if (typeof systemInstruction === 'object' && systemInstruction) {
      const parts = (systemInstruction as { parts?: Part[] }).parts || [];
      sysText = parts
        .map((p) => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    if (sysText.trim()) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts || [];

    const textParts: string[] = [];
    const toolCalls: OpenAiToolCall[] = [];
    const toolResponses: Array<{ id: string; content: string }> = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.text !== undefined && part.text !== null) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        const id = part.functionCall.id || `call_${i}_${Date.now()}`;
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name: part.functionCall.name || 'tool',
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
      if (part.functionResponse) {
        const resp = part.functionResponse.response;
        const textContent =
          typeof resp === 'string'
            ? resp
            : JSON.stringify(resp ?? { output: '' });
        toolResponses.push({
          id:
            part.functionResponse.id || part.functionResponse.name || 'call_0',
          content: textContent,
        });
      }
    }

    if (toolResponses.length > 0) {
      for (const tr of toolResponses) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: tr.content,
        });
      }
    } else if (toolCalls.length > 0 || textParts.length > 0) {
      const msg: OpenAiMessage = {
        role,
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      messages.push(msg);
    }
  }

  return messages;
}

/**
 * Maps Gemini tools to OpenAI tools.
 */
export function convertToolsToOpenAiTools(
  tools?: GenerateContentParameters['config'] extends { tools?: infer T }
    ? T
    : unknown,
): OpenAiTool[] | undefined {
  if (!tools || !Array.isArray(tools)) return undefined;

  const result: OpenAiTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const t = tool as { functionDeclarations?: FunctionDeclaration[] };
    const decls = t.functionDeclarations;
    if (!Array.isArray(decls)) continue;

    for (const decl of decls) {
      if (!decl.name) continue;
      result.push({
        type: 'function',
        function: {
          name: decl.name,
          ...(decl.description ? { description: decl.description } : {}),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          parameters: decl.parameters as Record<string, unknown> | undefined,
        },
      });
    }
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Creates a GenerateContentResponse compatible with the Gemini SDK.
 */
function createGenerateContentResponse(
  parts: Part[],
  finishReason: FinishReason = FinishReason.STOP,
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  },
): GenerateContentResponse {
  const candidate = {
    content: {
      role: 'model',
      parts,
    },
    finishReason,
  };

  const response: Record<string, unknown> = {
    candidates: [candidate],
    usageMetadata: usage
      ? {
          promptTokenCount: usage.prompt_tokens,
          candidatesTokenCount: usage.completion_tokens,
          totalTokenCount: usage.total_tokens,
        }
      : undefined,
  };

  Object.defineProperty(response, 'functionCalls', {
    get(): FunctionCall[] | undefined {
      const calls: FunctionCall[] = [];
      for (const p of parts) {
        if (p.functionCall) {
          calls.push(p.functionCall);
        }
      }
      return calls.length > 0 ? calls : undefined;
    },
    enumerable: true,
    configurable: true,
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return response as unknown as GenerateContentResponse;
}

/**
 * ContentGenerator implementation for remote or local vLLM instances.
 * Compatible with any model hosted on the vLLM server.
 */
export class VllmContentGenerator implements ContentGenerator {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly customHeaders: Record<string, string> = {},
    private readonly fallbackGenerator?: ContentGenerator,
  ) {}

  private getRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders,
    };
    if (this.apiKey?.trim()) {
      headers['Authorization'] = `Bearer ${this.apiKey.trim()}`;
    }
    return headers;
  }

  private buildPayload(
    request: GenerateContentParameters,
    stream: boolean,
  ): Record<string, unknown> {
    const model = request.model || process.env['VLLM_MODEL'] || 'default';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const contents = (request.contents || []) as Content[];
    const messages = convertContentsToOpenAiMessages(
      contents,
      request.config?.systemInstruction,
    );

    const tools = convertToolsToOpenAiTools(request.config?.tools);

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream,
    };

    if (tools && tools.length > 0) {
      payload['tools'] = tools;
    }

    if (request.config?.temperature !== undefined) {
      payload['temperature'] = request.config.temperature;
    }
    if (request.config?.topP !== undefined) {
      payload['top_p'] = request.config.topP;
    }
    if (request.config?.maxOutputTokens !== undefined) {
      payload['max_tokens'] = request.config.maxOutputTokens;
    }
    if (
      request.config?.stopSequences &&
      request.config.stopSequences.length > 0
    ) {
      payload['stop'] = request.config.stopSequences;
    }

    return payload;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const url = getChatCompletionsUrl(this.baseUrl);
    const headers = this.getRequestHeaders();
    const payload = this.buildPayload(request, false);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: request.config?.abortSignal,
      });
    } catch (e) {
      if (this.fallbackGenerator) {
        return this.fallbackGenerator.generateContent(
          request,
          userPromptId,
          role,
        );
      }
      throw e;
    }

    // If 404, the server may be exposing a Gemini protocol proxy instead
    if (response.status === 404 && this.fallbackGenerator) {
      return this.fallbackGenerator.generateContent(
        request,
        userPromptId,
        role,
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (
        payload['tools'] &&
        response.status === 400 &&
        (errorText.includes('does not support tools') ||
          errorText.includes('tools are not supported') ||
          errorText.includes('tool calls are not supported'))
      ) {
        debugLogger.warn(
          'Model does not support tools, retrying without tools',
        );
        delete payload['tools'];
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: request.config?.abortSignal,
        });
        if (!response.ok) {
          const retryErrorText = await response.text();
          throw new Error(
            `vLLM error (${response.status} ${response.statusText}): ${retryErrorText}`,
          );
        }
      } else {
        throw new Error(
          `vLLM error (${response.status} ${response.statusText}): ${errorText}`,
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = (await response.json()) as OpenAiChatCompletionResponse;
    const choice = data.choices?.[0];
    const parts: Part[] = [];

    if (choice?.message?.content) {
      parts.push({ text: choice.message.content });
    }

    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = { raw: tc.function.arguments };
        }
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args,
          },
        });
      }
    }

    return createGenerateContentResponse(parts, FinishReason.STOP, data.usage);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const url = getChatCompletionsUrl(this.baseUrl);
    const headers = this.getRequestHeaders();
    const payload = this.buildPayload(request, true);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: request.config?.abortSignal,
      });
    } catch (e) {
      if (this.fallbackGenerator) {
        return this.fallbackGenerator.generateContentStream(
          request,
          userPromptId,
          role,
        );
      }
      throw e;
    }

    if (response.status === 404 && this.fallbackGenerator) {
      return this.fallbackGenerator.generateContentStream(
        request,
        userPromptId,
        role,
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (
        payload['tools'] &&
        response.status === 400 &&
        (errorText.includes('does not support tools') ||
          errorText.includes('tools are not supported') ||
          errorText.includes('tool calls are not supported'))
      ) {
        debugLogger.warn(
          'Model does not support tools, retrying stream without tools',
        );
        delete payload['tools'];
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: request.config?.abortSignal,
        });
        if (!response.ok) {
          const retryErrorText = await response.text();
          throw new Error(
            `vLLM streaming error (${response.status} ${response.statusText}): ${retryErrorText}`,
          );
        }
      } else {
        throw new Error(
          `vLLM streaming error (${response.status} ${response.statusText}): ${errorText}`,
        );
      }
    }

    if (!response.body) {
      throw new Error('No response body returned from vLLM');
    }

    const streamBody = response.body;

    async function* iterate(): AsyncGenerator<GenerateContentResponse> {
      const reader = streamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Track accumulated tool calls across stream chunks
      const toolCallAccumulators = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let parsed: OpenAiChatCompletionResponse;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            parsed = JSON.parse(jsonStr) as OpenAiChatCompletionResponse;
          } catch {
            continue;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          // Content delta
          if (choice.delta?.content) {
            yield createGenerateContentResponse(
              [{ text: choice.delta.content }],
              FinishReason.STOP,
              parsed.usage,
            );
          }

          // Tool calls delta
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const index = tc.index ?? 0;
              if (!toolCallAccumulators.has(index)) {
                toolCallAccumulators.set(index, {
                  id: tc.id || `call_${index}`,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                });
              } else {
                const acc = toolCallAccumulators.get(index)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments)
                  acc.arguments += tc.function.arguments;
              }
            }
          }

          // When a tool call completes or stream reaches finish_reason
          if (
            choice.finish_reason === 'tool_calls' ||
            (choice.finish_reason && toolCallAccumulators.size > 0)
          ) {
            const parts: Part[] = [];
            for (const acc of toolCallAccumulators.values()) {
              let args: Record<string, unknown> = {};
              try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                args = JSON.parse(acc.arguments || '{}');
              } catch {
                args = { raw: acc.arguments };
              }
              parts.push({
                functionCall: {
                  id: acc.id,
                  name: acc.name,
                  args,
                },
              });
            }
            toolCallAccumulators.clear();
            if (parts.length > 0) {
              yield createGenerateContentResponse(
                parts,
                FinishReason.STOP,
                parsed.usage,
              );
            }
          }
        }
      }

      // Flush any remaining tool calls
      if (toolCallAccumulators.size > 0) {
        const parts: Part[] = [];
        for (const acc of toolCallAccumulators.values()) {
          let args: Record<string, unknown> = {};
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            args = JSON.parse(acc.arguments || '{}');
          } catch {
            args = { raw: acc.arguments };
          }
          parts.push({
            functionCall: {
              id: acc.id,
              name: acc.name,
              args,
            },
          });
        }
        toolCallAccumulators.clear();
        yield createGenerateContentResponse(parts, FinishReason.STOP);
      }
    }

    return iterate();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    let totalChars = 0;
    if (Array.isArray(request.contents)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      for (const content of request.contents as Content[]) {
        for (const part of content.parts || []) {
          if (part.text) totalChars += part.text.length;
        }
      }
    }
    return {
      totalTokens: Math.max(1, Math.ceil(totalChars / 4)),
    };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return {} as unknown as EmbedContentResponse;
  }
}
