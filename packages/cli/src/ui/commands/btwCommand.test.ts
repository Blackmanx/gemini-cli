/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { btwCommand } from './btwCommand.js';
import type { CommandContext } from './types.js';

function makeContext(history: unknown[]) {
  const generateContent = vi.fn().mockResolvedValue({
    candidates: [
      { content: { role: 'model', parts: [{ text: 'the answer' }] } },
    ],
  });
  const setPendingItem = vi.fn();
  const context = {
    services: {
      agentContext: {
        config: { getBaseLlmClient: () => ({ generateContent }) },
        geminiClient: { getHistory: () => history },
      },
    },
    ui: { setPendingItem },
  };
  return { context, generateContent, setPendingItem };
}

describe('btwCommand', () => {
  it('sends the conversation as context so the answer can be about it', async () => {
    const history = [
      { role: 'user', parts: [{ text: 'refactor auth.ts' }] },
      { role: 'model', parts: [{ text: 'done, split into two helpers' }] },
    ];
    const { context, generateContent } = makeContext(history);

    await btwCommand.action?.(
      context as unknown as CommandContext,
      'why two helpers?',
    );

    const request = generateContent.mock.calls[0][0];
    expect(request.contents).toEqual([
      ...history,
      { role: 'user', parts: [{ text: 'why two helpers?' }] },
    ]);
  });

  it('sends no tools, so a side question cannot act', async () => {
    const { context, generateContent } = makeContext([]);

    await btwCommand.action?.(
      context as unknown as CommandContext,
      'what time',
    );

    expect(generateContent.mock.calls[0][0].config).toBeUndefined();
  });

  it('strips tool traffic so a mid-flight history cannot replay a tool loop', async () => {
    const history = [
      { role: 'user', parts: [{ text: 'refactor auth.ts' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: {} } },
          { text: 'reading it now' },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: {} } }],
      },
    ];
    const { context, generateContent } = makeContext(history);

    await btwCommand.action?.(context as unknown as CommandContext, 'why?');

    expect(generateContent.mock.calls[0][0].contents).toEqual([
      { role: 'user', parts: [{ text: 'refactor auth.ts' }] },
      { role: 'model', parts: [{ text: 'reading it now' }] },
      { role: 'user', parts: [{ text: 'why?' }] },
    ]);
  });

  it('gives up rather than sitting on the placeholder forever', async () => {
    vi.useFakeTimers();
    try {
      const never = Promise.withResolvers<never>();
      const generateContent = vi.fn().mockReturnValue(never.promise);
      const setPendingItem = vi.fn();
      const context = {
        services: {
          agentContext: {
            config: { getBaseLlmClient: () => ({ generateContent }) },
            geminiClient: { getHistory: () => [] },
          },
        },
        ui: { setPendingItem },
      };

      await btwCommand.action?.(context as unknown as CommandContext, 'hi');
      setPendingItem.mockClear();
      await vi.advanceTimersByTimeAsync(90_000);

      expect(setPendingItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write the answer into history', async () => {
    const { context } = makeContext([]);
    const addItem = vi.fn();
    (context.ui as unknown as { addItem: unknown }).addItem = addItem;

    await btwCommand.action?.(
      context as unknown as CommandContext,
      'what time',
    );

    // Nothing returned for the processor to add: the answer arrives later and
    // goes to the pending region.
    expect(addItem).not.toHaveBeenCalled();
  });

  it('reports an empty question instead of calling the model', async () => {
    const { context, generateContent } = makeContext([]);
    const result = await btwCommand.action?.(
      context as unknown as CommandContext,
      '   ',
    );

    expect(generateContent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
  });
});
