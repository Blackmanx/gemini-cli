/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { SshAddDialog } from './SshAddDialog.js';

// The repo's convention for keypress-driven components (see
// ShellInputPrompt.test.tsx) is to capture the handler useKeypress registers
// and invoke it, rather than pushing bytes through a synthetic stdin.
const mockUseKeypress = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: mockUseKeypress,
}));

beforeEach(() => {
  // The mocked hook is module-level; a stale registration from a previous
  // test would otherwise receive the next test's keystrokes.
  mockUseKeypress.mockClear();
});

// Ink commits a frame asynchronously; without a real wait the assertion can
// read the frame from before the keystroke landed.
const flush = (lastFrame: () => string, ms = 60) =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      void lastFrame();
      resolve();
    }, ms);
  });
// Ink delivers one keypress per character. The handler is resolved from the
// most recent registration inside each press: re-renders append new calls,
// so capturing it once would go stale.
const latestHandler = () => mockUseKeypress.mock.calls.at(-1)![0];

const press = (key: { sequence: string; name: string }) =>
  act(() => {
    latestHandler()({ ctrl: false, meta: false, shift: false, ...key });
  });

const type = (text: string) => {
  for (const char of text) {
    press({ sequence: char, name: char });
  }
};

const enter = () => press({ sequence: '\r', name: 'return' });

const esc = () => press({ sequence: '', name: 'escape' });

const renderDialog = async (
  existingNames: readonly string[],
  onSubmit: (answers: unknown) => void,
) =>
  renderWithProviders(
    <SshAddDialog existingNames={existingNames} onSubmit={onSubmit} />,
  );

describe('SshAddDialog', () => {
  it('renders instead of hanging the CLI', async () => {
    const { lastFrame, unmount } = await renderDialog([], () => {});
    expect(lastFrame()).toContain('Add SSH server');
    unmount();
  });

  it('collects every field and reports no password in the prompt', async () => {
    let submitted: unknown = 'NOT-CALLED';
    const { lastFrame, unmount } = await renderDialog([], (a) => {
      submitted = a;
    });

    for (const text of ['lair', '192.168.68.57', 'blackman', '', '']) {
      if (text) type(text);
      enter();
    }
    // Secrets must never be echoed into the rendered prompt.
    expect(lastFrame()).not.toContain('Oscuridad77');

    type('Oscuridad77');
    enter();
    type('Oscuridad77');
    enter();

    unmount();
    expect(submitted).toEqual({
      name: 'lair',
      host: '192.168.68.57',
      user: 'blackman',
      port: 22,
      password: 'Oscuridad77',
      sudoPassword: 'Oscuridad77',
    });
  });

  it('leaves a blank secret undefined so the stored one survives', async () => {
    let submitted: unknown = 'NOT-CALLED';
    const { unmount } = await renderDialog([], (a) => {
      submitted = a;
    });

    for (const text of ['lair', 'host', 'user', '', '']) {
      if (text) type(text);
      enter();
    }
    enter(); // blank password
    enter(); // blank sudo password

    unmount();
    expect(submitted).toEqual({
      name: 'lair',
      host: 'host',
      user: 'user',
      port: 22,
    });
  });

  it('reports cancellation as null so nothing is stored', async () => {
    let submitted: unknown = 'NOT-CALLED';
    const { unmount } = await renderDialog([], (a) => {
      submitted = a;
    });
    esc();
    unmount();
    expect(submitted).toBeNull();
  });

  it('refuses a name that is already taken', async () => {
    let submitted: unknown = 'NOT-CALLED';
    const { lastFrame, unmount } = await renderDialog(['taken'], (a) => {
      submitted = a;
    });
    type('taken');
    enter();
    await flush(lastFrame);
    expect(lastFrame()).toContain('already exists');
    expect(submitted).toBe('NOT-CALLED');
    unmount();
  });
});
