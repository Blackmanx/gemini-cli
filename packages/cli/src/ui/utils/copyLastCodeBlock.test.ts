/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as commandUtils from './commandUtils.js';
import { copyLastCodeBlock, lastRenderedReply } from './copyLastCodeBlock.js';
import type { HistoryItem } from '../types.js';

const settings = {} as Parameters<typeof copyLastCodeBlock>[1];

const item = (text: string): HistoryItem =>
  ({ type: 'gemini', text, id: text }) as unknown as HistoryItem;

describe('lastRenderedReply', () => {
  it('takes the last thing the model printed', () => {
    expect(
      lastRenderedReply([
        item('primera'),
        { type: 'info', text: 'nota', id: 'n' } as unknown as HistoryItem,
        item('segunda'),
      ]),
    ).toBe('segunda');
  });

  it('skips trailing items that are not model output', () => {
    expect(
      lastRenderedReply([
        item('```bash\nls\n```'),
        { type: 'info', text: 'copiado', id: 'i' } as unknown as HistoryItem,
      ]),
    ).toBe('```bash\nls\n```');
  });

  it('returns nothing when the model never printed', () => {
    expect(
      lastRenderedReply([
        { type: 'info', text: 'hola', id: 'i' } as unknown as HistoryItem,
      ]),
    ).toBe('');
  });
});

describe('copyLastCodeBlock', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('copies the fenced block the renderer actually showed', async () => {
    const copied: string[] = [];
    vi.spyOn(commandUtils, 'copyToClipboard').mockImplementation(
      async (text: string) => {
        copied.push(text);
      },
    );

    const result = await copyLastCodeBlock(
      [item('Aquí tienes:\n\n```markdown\n# Project Overview\n\n- item\n```')],
      settings,
    );

    expect(copied).toEqual(['# Project Overview\n\n- item']);
    expect(result.copied).toBe('# Project Overview\n\n- item');
    expect(result.isError).toBe(false);
  });

  it('reports a miss instead of copying prose when there is no block', async () => {
    const copy = vi
      .spyOn(commandUtils, 'copyToClipboard')
      .mockImplementation(async () => {});

    const result = await copyLastCodeBlock([item('solo texto')], settings);

    expect(copy).not.toHaveBeenCalled();
    expect(result.copied).toBeNull();
    expect(result.message).toContain('No code block');
  });

  it('surfaces a clipboard failure as an error rather than throwing', async () => {
    vi.spyOn(commandUtils, 'copyToClipboard').mockRejectedValue(
      new Error('no clipboard'),
    );

    const result = await copyLastCodeBlock([item('```\nx\n```')], settings);

    expect(result.isError).toBe(true);
    expect(result.message).toContain('no clipboard');
  });
});
