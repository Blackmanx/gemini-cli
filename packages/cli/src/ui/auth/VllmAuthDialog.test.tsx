/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { VllmAuthDialog } from './VllmAuthDialog.js';
import * as core from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    fetchVllmModels: vi.fn(),
  };
});

describe('VllmAuthDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly with default fields including Model Name', async () => {
    vi.mocked(core.fetchVllmModels).mockResolvedValue([]);

    let renderResult: Awaited<ReturnType<typeof renderWithProviders>>;
    await act(async () => {
      renderResult = await renderWithProviders(
        <VllmAuthDialog
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          defaultBaseUrl="http://remote-vllm:8000"
          defaultApiKey="my-key"
          defaultModel="Qwen/Qwen2.5-Coder-32B-Instruct"
        />,
      );
    });

    const frame = renderResult!.lastFrame();
    expect(frame).toContain('Configure vLLM Connection');
    expect(frame).toContain('Base URL:');
    expect(frame).toContain('http://remote-vllm:8000');
    expect(frame).toContain('API Key (optional):');
    expect(frame).toContain('Model Name (optional / auto-detected):');
    expect(frame).toContain('Qwen/Qwen2.5-Coder-32B-Instruct');
  });

  it('displays discovered models and auto-populates the first model', async () => {
    vi.mocked(core.fetchVllmModels).mockResolvedValue([
      'meta-llama/Llama-3.1-8B-Instruct',
      'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',
    ]);

    let renderResult: Awaited<ReturnType<typeof renderWithProviders>>;
    await act(async () => {
      renderResult = await renderWithProviders(
        <VllmAuthDialog
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          defaultBaseUrl="http://remote-vllm:8000"
        />,
      );
    });

    const frame = renderResult!.lastFrame();
    expect(frame).toContain('meta-llama/Llama-3.1-8B-Instruct');
    expect(frame).toContain('deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct');
  });

  it('displays error message when provided', async () => {
    vi.mocked(core.fetchVllmModels).mockResolvedValue([]);

    let renderResult: Awaited<ReturnType<typeof renderWithProviders>>;
    await act(async () => {
      renderResult = await renderWithProviders(
        <VllmAuthDialog
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          error="Failed to connect to vLLM"
        />,
      );
    });

    expect(renderResult!.lastFrame()).toContain('Failed to connect to vLLM');
  });
});
