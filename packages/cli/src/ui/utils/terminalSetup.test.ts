/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  terminalSetup,
  VSCODE_SHIFT_ENTER_SEQUENCE,
  shouldPromptForTerminalSetup,
} from './terminalSetup.js';
import { terminalCapabilityManager } from './terminalCapabilityManager.js';

// Mock dependencies
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  copyFile: vi.fn(),
  homedir: vi.fn(),
  platform: vi.fn(),
  writeStream: {
    write: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  createWriteStream: () => mocks.writeStream,
  promises: {
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    copyFile: mocks.copyFile,
  },
}));

vi.mock('node:os', () => ({
  homedir: mocks.homedir,
  platform: mocks.platform,
}));

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    homedir: mocks.homedir,
  };
});

vi.mock('./terminalCapabilityManager.js', () => ({
  terminalCapabilityManager: {
    isKittyProtocolEnabled: vi.fn().mockReturnValue(false),
  },
}));

describe('terminalSetup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('VSCODE_GIT_ASKPASS_MAIN', '');
    vi.stubEnv('VSCODE_GIT_IPC_HANDLE', '');
    // Isolate from the real session: dev machines running these suites inside
    // Windows Terminal would otherwise leak WT_SESSION into every test.
    vi.stubEnv('WT_SESSION', '');

    // Default mocks
    mocks.homedir.mockReturnValue('/home/user');
    mocks.platform.mockReturnValue('darwin');
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.exec.mockImplementation((cmd, cb) => cb(null, { stdout: '' }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('detectTerminal', () => {
    it('should detect VS Code from env var', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const result = await terminalSetup();
      expect(result.message).toContain('VS Code');
    });

    it('should detect Cursor from env var', async () => {
      process.env['CURSOR_TRACE_ID'] = 'some-id';
      const result = await terminalSetup();
      expect(result.message).toContain('Cursor');
    });

    it('should detect Windsurf from env var', async () => {
      process.env['VSCODE_GIT_ASKPASS_MAIN'] = '/path/to/windsurf/askpass';
      const result = await terminalSetup();
      expect(result.message).toContain('Windsurf');
    });

    it('should detect from parent process', async () => {
      mocks.platform.mockReturnValue('linux');
      mocks.exec.mockImplementation((cmd, cb) => {
        cb(null, { stdout: 'code\n' });
      });

      const result = await terminalSetup();
      expect(result.message).toContain('VS Code');
    });
  });

  describe('configureVSCodeStyle', () => {
    it('should create new keybindings file if none exists', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalled();

      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(writtenContent).toMatchSnapshot();
    });

    it('should append to existing keybindings', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[]');

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(writtenContent).toHaveLength(6); // Shift+Enter, Ctrl+Enter, Cmd+Z, Alt+Z, Shift+Cmd+Z, Shift+Alt+Z
    });

    it('should not modify if bindings already exist', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const existingBindings = [
        {
          key: 'shift+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'cmd+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;9u' },
        },
        {
          key: 'alt+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;3u' },
        },
        {
          key: 'shift+cmd+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;10u' },
        },
        {
          key: 'shift+alt+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;4u' },
        },
      ];
      mocks.readFile.mockResolvedValue(JSON.stringify(existingBindings));

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should fail gracefully if json is invalid', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('{ invalid json');

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid JSON');
    });

    it('should handle comments in JSON', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const jsonWithComments = '// This is a comment\n[]';
      mocks.readFile.mockResolvedValue(jsonWithComments);

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalled();
    });
  });

  describe('shouldPromptForTerminalSetup', () => {
    it('should return false when kitty protocol is already enabled', async () => {
      vi.mocked(
        terminalCapabilityManager.isKittyProtocolEnabled,
      ).mockReturnValue(true);

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(false);
    });

    it('should return false when both Shift+Enter and Ctrl+Enter bindings already exist', async () => {
      vi.mocked(
        terminalCapabilityManager.isKittyProtocolEnabled,
      ).mockReturnValue(false);
      process.env['TERM_PROGRAM'] = 'vscode';

      const existingBindings = [
        {
          key: 'shift+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
      ];
      mocks.readFile.mockResolvedValue(JSON.stringify(existingBindings));

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(false);
    });

    it('should return true when keybindings file does not exist', async () => {
      vi.mocked(
        terminalCapabilityManager.isKittyProtocolEnabled,
      ).mockReturnValue(false);
      process.env['TERM_PROGRAM'] = 'vscode';

      mocks.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(true);
    });
  });

  describe('Windows Terminal', () => {
    const wtSettingsWithoutBinding = {
      $schema: 'https://aka.ms/terminal-profiles-schema',
      defaultProfile: '{9ef397a5-256f-5757-b7ef-9e215905a881}',
      actions: [{ command: 'paste', id: 'User.paste' }],
      keybindings: [{ id: 'User.paste', keys: 'ctrl+v' }],
    };

    const wtSettingsWithBinding = {
      actions: [
        {
          command: { action: 'sendInput', input: '\u001b[13;2u' },
          id: 'gemini.shiftEnterNewline',
        },
      ],
      keybindings: [{ id: 'gemini.shiftEnterNewline', keys: 'shift+enter' }],
    };

    beforeEach(() => {
      vi.stubEnv('WT_SESSION', 'some-guid');
      vi.stubEnv('LOCALAPPDATA', '/tmp/fake-local-app-data');
      // Default: no settings.json in any install flavor.
      mocks.readFile.mockRejectedValue(new Error('ENOENT'));
    });

    it('adds the Shift+Enter newline binding to settings.json', async () => {
      mocks.readFile.mockResolvedValue(
        JSON.stringify(wtSettingsWithoutBinding),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.copyFile).toHaveBeenCalled(); // timestamped backup first
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);

      const written = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(written.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'gemini.shiftEnterNewline',
            command: { action: 'sendInput', input: '\u001b[13;2u' },
          }),
        ]),
      );
      expect(written.keybindings).toEqual(
        expect.arrayContaining([
          { id: 'gemini.shiftEnterNewline', keys: 'shift+enter' },
        ]),
      );
      // Existing entries survive the rewrite.
      expect(written.actions).toEqual(
        expect.arrayContaining([{ command: 'paste', id: 'User.paste' }]),
      );
    });

    it('is idempotent when the binding already exists', async () => {
      mocks.readFile.mockResolvedValue(JSON.stringify(wtSettingsWithBinding));

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('already configured');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('does not modify a user-owned shift+enter binding', async () => {
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          actions: [
            {
              command: { action: 'sendInput', input: 'something-else' },
              id: 'custom.shiftEnter',
            },
          ],
          keybindings: [{ id: 'custom.shiftEnter', keys: 'shift+enter' }],
        }),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('will not be modified');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('falls back to the preview flavor when the stable install is absent', async () => {
      mocks.readFile
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue(JSON.stringify(wtSettingsWithoutBinding));

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    });

    it('prints manual instructions when no settings file is found', async () => {
      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('manually');
      expect(result.message).toContain('"keys": "shift+enter"');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('refuses to rewrite JSONC settings and prints manual instructions', async () => {
      mocks.readFile.mockResolvedValue(
        '{\n  // user comment\n  "actions": [],\n}\n',
      );

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('cannot be modified automatically');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    describe('shouldPromptForTerminalSetup', () => {
      it('returns true when the shift+enter binding is missing', async () => {
        mocks.readFile.mockResolvedValue(
          JSON.stringify(wtSettingsWithoutBinding),
        );

        await expect(shouldPromptForTerminalSetup()).resolves.toBe(true);
      });

      it('returns false when the binding is already configured', async () => {
        mocks.readFile.mockResolvedValue(JSON.stringify(wtSettingsWithBinding));

        await expect(shouldPromptForTerminalSetup()).resolves.toBe(false);
      });

      it('returns true when the settings file cannot be read', async () => {
        await expect(shouldPromptForTerminalSetup()).resolves.toBe(true);
      });

      it('returns false outside Windows Terminal', async () => {
        vi.stubEnv('WT_SESSION', '');

        await expect(shouldPromptForTerminalSetup()).resolves.toBe(false);
      });
    });
  });
});
