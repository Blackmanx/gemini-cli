/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import {
  ContextUsageDisplay,
  contextUsageReservedWidth,
} from './ContextUsageDisplay.js';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    tokenLimit: () => 10000,
  };
});

describe('ContextUsageDisplay', () => {
  it('renders the full context bar with totals on wide terminals', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    expect(lastFrame()).toContain('[█████░░░░░] 50% · 5k/10k');
    unmount();
  });

  it('renders the bar without totals on medium terminals', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model="gemini-pro"
        terminalWidth={100}
      />,
      { width: 100 },
    );
    const output = lastFrame();
    expect(output).toContain('[█████░░░░░] 50%');
    expect(output).not.toContain('·');
    unmount();
  });

  it('renders only the percentage on narrow terminals', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={2000}
        model="gemini-pro"
        terminalWidth={80}
      />,
      { width: 80 },
    );
    const output = lastFrame();
    expect(output).toContain('20%');
    expect(output).not.toContain('[');
    unmount();
  });

  it('renders an empty gauge at 0%', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={0}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    expect(lastFrame()).toContain('[░░░░░░░░░░] 0% · 0/10k');
    unmount();
  });

  it('renders a full gauge at 100%', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={10000}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    expect(lastFrame()).toContain('[██████████] 100% · 10k/10k');
    unmount();
  });

  it('falls back to the bare percentage when the model is unknown', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model={undefined}
        terminalWidth={120}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('0%');
    expect(output).not.toContain('[');
    unmount();
  });

  it('reserves the worst-case width per terminal-width tier', () => {
    expect(contextUsageReservedWidth(120)).toBe(30);
    expect(contextUsageReservedWidth(100)).toBe(17);
    expect(contextUsageReservedWidth(80)).toBe(4);
  });
});
