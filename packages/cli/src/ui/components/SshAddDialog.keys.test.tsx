/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { SshAddDialog } from './SshAddDialog.js';

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });

describe('SshAddDialog through the real keypress pipeline', () => {
  // No mocked hook here on purpose: keys go to the fake terminal and the
  // fork's own parser decides the name and the insertable flag. A hand-built
  // Key object would have hidden that this fork normalizes the return key to
  // 'enter' rather than ink's 'return' - the bug that made Enter do nothing.
  it('advances on Enter', async () => {
    let submitted: unknown = 'NOT-CALLED';
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <SshAddDialog
        existingNames={[]}
        onSubmit={(a) => {
          submitted = a;
        }}
      />,
    );
    await act(async () => {
      stdin.write('lair');
      await flush();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
      stdin.write('\r');
      await flush();
    });
    await flush();
    expect(lastFrame()).toContain('Host or IP');
    unmount();
    expect(submitted).toBe('NOT-CALLED');
  });
});
