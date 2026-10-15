/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal setup utility for configuring Shift+Enter and Ctrl+Enter support.
 *
 * This module provides automatic detection and configuration of various terminal
 * emulators to support multiline input through modified Enter keys.
 *
 * Supported terminals:
 * - VS Code: Configures keybindings.json to send \\\r\n
 * - Cursor: Configures keybindings.json to send \\\r\n (VS Code fork)
 * - Windsurf: Configures keybindings.json to send \\\r\n (VS Code fork)
 * - Antigravity: Configures keybindings.json to send \\\r\n (VS Code fork)
 * - Windows Terminal: Binds Shift+Enter to send the kitty CSI-u newline
 *   sequence (settings.json), on native Windows and under WSL alike.
 *
 * For VS Code and its forks:
 * - Shift+Enter: Sends \\\r\n (backslash followed by CRLF)
 * - Ctrl+Enter: Sends \\\r\n (backslash followed by CRLF)
 *
 * The module will not modify existing shift+enter or ctrl+enter keybindings
 * to avoid conflicts with user customizations.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { terminalCapabilityManager } from './terminalCapabilityManager.js';

import {
  debugLogger,
  homedir,
  getWindowsUserProfileRoot,
} from '@google/gemini-cli-core';
import { useEffect } from 'react';
import { persistentState } from '../../utils/persistentState.js';
import { requestConsentInteractive } from '../../config/extensions/consent.js';
import type { ConfirmationRequest } from '../types.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';

type AddItemFn = UseHistoryManagerReturn['addItem'];

export const VSCODE_SHIFT_ENTER_SEQUENCE = '\\\r\n';

/**
 * The kitty CSI-u encoding of Shift+Enter (`ESC [ 13 ; 2 u`). Windows Terminal
 * has no kitty protocol support of its own, so the binding must be taught to
 * send this sequence explicitly; the CLI's keypress parser already
 * understands it and maps it to a newline instead of a submit.
 */
export const WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE = '\u001b[13;2u';

/** Stable id of the action/keybinding pair we write into the WT settings. */
const WINDOWS_TERMINAL_SHIFT_ENTER_ID = 'gemini.shiftEnterNewline';

const execAsync = promisify(exec);

/**
 * Removes single-line JSON comments (// ...) from a string to allow parsing
 * VS Code style JSON files that may contain comments.
 */
function stripJsonComments(content: string): string {
  // Remove single-line comments (// ...)
  return content.replace(/^\s*\/\/.*$/gm, '');
}

export interface TerminalSetupResult {
  success: boolean;
  message: string;
  requiresRestart?: boolean;
}

type SupportedTerminal = 'vscode' | 'cursor' | 'windsurf' | 'antigravity';

/**
 * Terminal metadata used for configuration.
 */
interface TerminalData {
  terminalName: string;
  appName: string;
}
const TERMINAL_DATA: Record<SupportedTerminal, TerminalData> = {
  vscode: { terminalName: 'VS Code', appName: 'Code' },
  cursor: { terminalName: 'Cursor', appName: 'Cursor' },
  windsurf: { terminalName: 'Windsurf', appName: 'Windsurf' },
  antigravity: { terminalName: 'Antigravity', appName: 'Antigravity' },
};

/**
 * Maps a supported terminal ID to its display name and config folder name.
 */
function getSupportedTerminalData(
  terminal: SupportedTerminal,
): TerminalData | null {
  return TERMINAL_DATA[terminal] || null;
}

type Keybinding = {
  key?: string;
  command?: string;
  args?: { text?: string };
};

function isKeybinding(kb: unknown): kb is Keybinding {
  return typeof kb === 'object' && kb !== null;
}

/**
 * Checks if a keybindings array contains our specific binding for a given key.
 */
function hasOurBinding(
  keybindings: unknown[],
  key: 'shift+enter' | 'ctrl+enter',
): boolean {
  return keybindings.some((kb) => {
    if (!isKeybinding(kb)) return false;
    return (
      kb.key === key &&
      kb.command === 'workbench.action.terminal.sendSequence' &&
      kb.args?.text === VSCODE_SHIFT_ENTER_SEQUENCE
    );
  });
}

export function getTerminalProgram(): SupportedTerminal | null {
  const termProgram = process.env['TERM_PROGRAM'];

  // Check VS Code and its forks - check forks first to avoid false positives
  // Check for Cursor-specific indicators
  if (
    process.env['CURSOR_TRACE_ID'] ||
    process.env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('cursor')
  ) {
    return 'cursor';
  }
  // Check for Windsurf-specific indicators
  if (
    process.env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('windsurf')
  ) {
    return 'windsurf';
  }
  // Check for Antigravity-specific indicators
  if (
    process.env['VSCODE_GIT_ASKPASS_MAIN']
      ?.toLowerCase()
      .includes('antigravity')
  ) {
    return 'antigravity';
  }
  // Check VS Code last since forks may also set VSCODE env vars
  if (termProgram === 'vscode' || process.env['VSCODE_GIT_IPC_HANDLE']) {
    return 'vscode';
  }
  return null;
}

// Terminal detection
async function detectTerminal(): Promise<SupportedTerminal | null> {
  const envTerminal = getTerminalProgram();
  if (envTerminal) {
    return envTerminal;
  }

  // Check parent process name
  if (os.platform() !== 'win32') {
    try {
      const { stdout } = await execAsync('ps -o comm= -p $PPID');
      const parentName = stdout.trim();

      // Check forks before VS Code to avoid false positives
      if (parentName.includes('windsurf') || parentName.includes('Windsurf'))
        return 'windsurf';
      if (
        parentName.includes('antigravity') ||
        parentName.includes('Antigravity')
      )
        return 'antigravity';
      if (parentName.includes('cursor') || parentName.includes('Cursor'))
        return 'cursor';
      if (parentName.includes('code') || parentName.includes('Code'))
        return 'vscode';
    } catch (error) {
      // Continue detection even if process check fails
      debugLogger.debug('Parent process detection failed:', error);
    }
  }

  return null;
}

// Backup file helper
async function backupFile(filePath: string): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.backup.${timestamp}`;
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    // Log backup errors but continue with operation
    debugLogger.warn(`Failed to create backup of ${filePath}:`, error);
  }
}

// Helper function to get VS Code-style config directory
function getVSCodeStyleConfigDir(appName: string): string | null {
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      appName,
      'User',
    );
  } else if (platform === 'win32') {
    if (!process.env['APPDATA']) {
      return null;
    }
    return path.join(process.env['APPDATA'], appName, 'User');
  } else {
    return path.join(homedir(), '.config', appName, 'User');
  }
}

// Generic VS Code-style terminal configuration
async function configureVSCodeStyle(
  terminalName: string,
  appName: string,
): Promise<TerminalSetupResult> {
  const configDir = getVSCodeStyleConfigDir(appName);

  if (!configDir) {
    return {
      success: false,
      message: `Could not determine ${terminalName} config path on Windows: APPDATA environment variable is not set.`,
    };
  }

  const keybindingsFile = path.join(configDir, 'keybindings.json');

  try {
    await fs.mkdir(configDir, { recursive: true });

    let keybindings: unknown[] = [];
    try {
      const content = await fs.readFile(keybindingsFile, 'utf8');
      await backupFile(keybindingsFile);
      try {
        const cleanContent = stripJsonComments(content);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const parsedContent = JSON.parse(cleanContent);
        if (!Array.isArray(parsedContent)) {
          return {
            success: false,
            message:
              `${terminalName} keybindings.json exists but is not a valid JSON array. ` +
              `Please fix the file manually or delete it to allow automatic configuration.\n` +
              `File: ${keybindingsFile}`,
          };
        }
        keybindings = parsedContent;
      } catch (parseError) {
        return {
          success: false,
          message:
            `Failed to parse ${terminalName} keybindings.json. The file contains invalid JSON.\n` +
            `Please fix the file manually or delete it to allow automatic configuration.\n` +
            `File: ${keybindingsFile}\n` +
            `Error: ${parseError}`,
        };
      }
    } catch {
      // File doesn't exist, will create new one
    }

    const targetBindings = [
      {
        key: 'shift+enter',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
      },
      {
        key: 'ctrl+enter',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
      },
      {
        key: 'cmd+z',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: '\u001b[122;9u' },
      },
      {
        key: 'alt+z',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: '\u001b[122;3u' },
      },
      {
        key: 'shift+cmd+z',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: '\u001b[122;10u' },
      },
      {
        key: 'shift+alt+z',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: '\u001b[122;4u' },
      },
    ];

    const results = targetBindings.map((target) => {
      const hasOurBinding = keybindings.some((kb) => {
        if (!isKeybinding(kb)) return false;
        return (
          kb.key === target.key &&
          kb.command === target.command &&
          kb.args?.text === target.args.text
        );
      });

      const existingBinding = keybindings.find((kb) => {
        if (!isKeybinding(kb)) return false;
        return kb.key === target.key;
      });

      return {
        target,
        hasOurBinding,
        conflict: !!existingBinding && !hasOurBinding,
        conflictMessage: `- ${target.key.charAt(0).toUpperCase() + target.key.slice(1)} binding already exists`,
      };
    });

    if (results.every((r) => r.hasOurBinding)) {
      return {
        success: true,
        message: `${terminalName} keybindings already configured.`,
      };
    }

    const conflicts = results.filter((r) => r.conflict);
    if (conflicts.length > 0) {
      return {
        success: false,
        message:
          `Existing keybindings detected. Will not modify to avoid conflicts.\n` +
          conflicts.map((c) => c.conflictMessage).join('\n') +
          '\n' +
          `Please check and modify manually if needed: ${keybindingsFile}`,
      };
    }

    for (const { hasOurBinding, target } of results) {
      if (!hasOurBinding) {
        keybindings.unshift(target);
      }
    }

    await fs.writeFile(keybindingsFile, JSON.stringify(keybindings, null, 4));
    return {
      success: true,
      message: `Added ${targetBindings
        .map((b) => b.key.charAt(0).toUpperCase() + b.key.slice(1))
        .join(
          ', ',
        )} keybindings to ${terminalName}.\nModified: ${keybindingsFile}`,
      requiresRestart: true,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to configure ${terminalName}.\nFile: ${keybindingsFile}\nError: ${error}`,
    };
  }
}

/**
 * Whether this session runs inside Windows Terminal. WT sets WT_SESSION for
 * every process it spawns and the variable survives the jump into WSL, which
 * is what makes detection work from both native Windows and the WSL side.
 */
function isWindowsTerminalSession(): boolean {
  return !!process.env['WT_SESSION'];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape shared by WT `actions` and `keybindings` entries (all optional). */
interface WindowsTerminalEntry {
  id?: string;
  keys?: string;
  command?: unknown;
}

function isWindowsTerminalEntry(value: unknown): value is WindowsTerminalEntry {
  return isPlainObject(value);
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The `input` of a sendInput command, or undefined for other actions. */
function sendInputPayload(entry: unknown): unknown {
  if (!isPlainObject(entry)) return undefined;
  const command = entry['command'];
  if (!isPlainObject(command) || command['action'] !== 'sendInput') {
    return undefined;
  }
  return command['input'];
}

/**
 * The Windows %LOCALAPPDATA% directory for the current platform: straight
 * from the environment on win32, `<profile>/AppData/Local` (WSL form,
 * through the cached interop lookup) under WSL.
 */
async function getWindowsLocalAppData(): Promise<string | null> {
  const fromEnv = process.env['LOCALAPPDATA'];
  if (fromEnv) return fromEnv;
  if (os.platform() === 'win32') return null;
  const profileRoot = await getWindowsUserProfileRoot();
  if (!profileRoot) return null;
  return path.join(profileRoot, 'AppData', 'Local');
}

/**
 * settings.json locations for every Windows Terminal install flavor:
 * Store (MSIX) stable, Store preview, then the standalone
 * (scoop/chocolatey/zip) layout.
 */
async function windowsTerminalSettingsCandidates(): Promise<string[]> {
  const localAppData = await getWindowsLocalAppData();
  if (!localAppData) return [];
  return [
    path.join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    ),
    path.join(
      localAppData,
      'Packages',
      'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    ),
    path.join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

/** The first existing settings.json with its content, or null if none. */
async function findWindowsTerminalSettingsFile(): Promise<{
  path: string;
  content: string;
} | null> {
  for (const candidate of await windowsTerminalSettingsCandidates()) {
    try {
      return { path: candidate, content: await fs.readFile(candidate, 'utf8') };
    } catch {
      // Try the next install flavor.
    }
  }
  return null;
}

/** Strict JSON parse (see below for why JSONC is rejected), else null. */
function parseWindowsTerminalSettings(
  content: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

type WindowsTerminalShiftEnterState = 'configured' | 'conflict' | 'missing';

/**
 * Classifies the current shift+enter wiring: our sendInput binding present,
 * a shift+enter binding owned by the user, or nothing at all. Resolution
 * covers both the modern actions/keybindings id split and the legacy
 * inline-command form.
 */
function windowsTerminalShiftEnterState(
  settings: Record<string, unknown>,
): WindowsTerminalShiftEnterState {
  const actionById = new Map<string, unknown>();
  for (const action of asUnknownArray(settings['actions'])) {
    if (isWindowsTerminalEntry(action) && typeof action.id === 'string') {
      actionById.set(action.id, action);
    }
  }

  let state: WindowsTerminalShiftEnterState = 'missing';
  for (const binding of asUnknownArray(settings['keybindings'])) {
    if (!isWindowsTerminalEntry(binding) || binding.keys !== 'shift+enter') {
      continue;
    }
    const resolved =
      typeof binding.id === 'string'
        ? sendInputPayload(actionById.get(binding.id))
        : sendInputPayload(binding);
    if (typeof resolved === 'string' && resolved.includes('[13;2u')) {
      return 'configured';
    }
    state = 'conflict';
  }
  return state;
}

function windowsTerminalManualInstructions(settingsPath?: string): string {
  return (
    'Please add this binding manually to the Windows Terminal settings.json' +
    (settingsPath ? ` (${settingsPath})` : '') +
    ':\n' +
    '  in "actions":    { "command": { "action": "sendInput", ' +
    '"input": "\\u001b[13;2u" }, "id": "' +
    WINDOWS_TERMINAL_SHIFT_ENTER_ID +
    '" }\n' +
    '  in "keybindings": { "id": "' +
    WINDOWS_TERMINAL_SHIFT_ENTER_ID +
    '", "keys": "shift+enter" }'
  );
}

/**
 * Adds the Shift+Enter → newline binding to Windows Terminal's settings.json.
 *
 * The file is rewritten as plain JSON, so a settings file carrying comments
 * or trailing commas (JSONC) is deliberately left untouched and reported with
 * manual instructions instead — silently dropping the user's comments would
 * be worse than one extra paste. Existing shift+enter bindings owned by the
 * user are never modified.
 */
async function configureWindowsTerminal(): Promise<TerminalSetupResult> {
  const file = await findWindowsTerminalSettingsFile();
  if (!file) {
    return {
      success: false,
      message:
        'Could not locate the Windows Terminal settings.json on this machine.\n' +
        windowsTerminalManualInstructions(),
    };
  }

  const settings = parseWindowsTerminalSettings(file.content);
  if (!settings) {
    return {
      success: false,
      message:
        'Windows Terminal settings.json is not plain JSON (comments or ' +
        'trailing commas?), so it cannot be modified automatically without ' +
        'losing them.\n' +
        windowsTerminalManualInstructions(file.path),
    };
  }

  const state = windowsTerminalShiftEnterState(settings);
  if (state === 'configured') {
    return {
      success: true,
      message: 'Windows Terminal is already configured for Shift+Enter.',
    };
  }
  if (state === 'conflict') {
    return {
      success: false,
      message:
        'A shift+enter keybinding already exists in Windows Terminal; it ' +
        'will not be modified to avoid clobbering your customization.\n' +
        windowsTerminalManualInstructions(file.path),
    };
  }

  const actions = asUnknownArray(settings['actions']);
  if (
    !actions.some(
      (action) =>
        isPlainObject(action) &&
        action['id'] === WINDOWS_TERMINAL_SHIFT_ENTER_ID,
    )
  ) {
    actions.push({
      command: {
        action: 'sendInput',
        input: WINDOWS_TERMINAL_SHIFT_ENTER_SEQUENCE,
      },
      id: WINDOWS_TERMINAL_SHIFT_ENTER_ID,
    });
    settings['actions'] = actions;
  }
  const keybindings = asUnknownArray(settings['keybindings']);
  keybindings.push({
    id: WINDOWS_TERMINAL_SHIFT_ENTER_ID,
    keys: 'shift+enter',
  });
  settings['keybindings'] = keybindings;

  await backupFile(file.path);
  await fs.writeFile(file.path, JSON.stringify(settings, null, 4) + '\n');
  return {
    success: true,
    message:
      `Added the Shift+Enter → newline keybinding to Windows Terminal ` +
      `(applies immediately, no restart needed).\nModified: ${file.path}`,
  };
}

/**
 * Determines whether it is useful to prompt the user to run /terminal-setup
 * in the current environment.
 *
 * Returns true when:
 * - Kitty/modifyOtherKeys keyboard protocol is not already enabled, and
 * - Either we're running inside a supported VS Code-style terminal (VS Code,
 *   Cursor, Windsurf, Antigravity) whose keybindings file does not already
 *   contain both of our Shift+Enter and Ctrl+Enter bindings, or
 * - We're running inside Windows Terminal and its shift+enter binding is
 *   missing (or its settings could not be read, in which case the setup
 *   prints manual instructions).
 */
export async function shouldPromptForTerminalSetup(): Promise<boolean> {
  if (terminalCapabilityManager.isKittyProtocolEnabled()) {
    return false;
  }

  const terminal = await detectTerminal();
  if (!terminal) {
    if (!isWindowsTerminalSession()) {
      return false;
    }
    const file = await findWindowsTerminalSettingsFile();
    if (!file) {
      // Unlocatable settings: still worth prompting — the setup run shows
      // exactly what to paste where.
      return true;
    }
    const settings = parseWindowsTerminalSettings(file.content);
    if (!settings) {
      return true;
    }
    return windowsTerminalShiftEnterState(settings) !== 'configured';
  }

  const terminalData = getSupportedTerminalData(terminal);
  if (!terminalData) {
    return false;
  }

  const configDir = getVSCodeStyleConfigDir(terminalData.appName);
  if (!configDir) {
    return false;
  }

  const keybindingsFile = path.join(configDir, 'keybindings.json');

  try {
    const content = await fs.readFile(keybindingsFile, 'utf8');
    const cleanContent = stripJsonComments(content);
    const parsedContent: unknown = JSON.parse(cleanContent) as unknown;

    if (!Array.isArray(parsedContent)) {
      return true;
    }

    const hasOurShiftEnter = hasOurBinding(parsedContent, 'shift+enter');
    const hasOurCtrlEnter = hasOurBinding(parsedContent, 'ctrl+enter');

    return !(hasOurShiftEnter && hasOurCtrlEnter);
  } catch (error) {
    debugLogger.debug(
      `Failed to read or parse keybindings, assuming prompt is needed: ${error}`,
    );
    return true;
  }
}

/**
 * Main terminal setup function that detects and configures the current terminal.
 *
 * This function:
 * 1. Detects the current terminal emulator
 * 2. Applies appropriate configuration for Shift+Enter and Ctrl+Enter support
 * 3. Creates backups of configuration files before modifying them
 *
 * @returns Promise<TerminalSetupResult> Result object with success status and message
 *
 * @example
 * const result = await terminalSetup();
 * if (result.success) {
 *   console.log(result.message);
 *   if (result.requiresRestart) {
 *     console.log('Please restart your terminal');
 *   }
 * }
 */
export async function terminalSetup(): Promise<TerminalSetupResult> {
  // Check if terminal already has optimal keyboard support
  if (terminalCapabilityManager.isKittyProtocolEnabled()) {
    return {
      success: true,
      message:
        'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).',
    };
  }

  const terminal = await detectTerminal();

  if (!terminal) {
    if (isWindowsTerminalSession()) {
      return configureWindowsTerminal();
    }
    return {
      success: false,
      message:
        'Could not detect terminal type. Supported terminals: VS Code, ' +
        'Cursor, Windsurf, Antigravity, and Windows Terminal.',
    };
  }

  const terminalData = getSupportedTerminalData(terminal);
  if (!terminalData) {
    return {
      success: false,
      message: `Terminal "${terminal}" is not supported yet.`,
    };
  }

  return configureVSCodeStyle(terminalData.terminalName, terminalData.appName);
}

export const TERMINAL_SETUP_CONSENT_MESSAGE =
  'Gemini CLI works best with Shift+Enter/Ctrl+Enter for multiline input. ' +
  'Would you like to automatically configure your terminal keybindings?';

export function formatTerminalSetupResultMessage(
  result: TerminalSetupResult,
): string {
  let content = result.message;
  if (result.requiresRestart) {
    content +=
      '\n\nPlease restart your terminal for the changes to take effect.';
  }
  return content;
}

interface UseTerminalSetupPromptParams {
  addConfirmUpdateExtensionRequest: (request: ConfirmationRequest) => void;
  addItem: AddItemFn;
}

/**
 * Hook that shows a one-time prompt to run /terminal-setup when it would help.
 */
export function useTerminalSetupPrompt({
  addConfirmUpdateExtensionRequest,
  addItem,
}: UseTerminalSetupPromptParams): void {
  useEffect(() => {
    const hasBeenPrompted = persistentState.get('terminalSetupPromptShown');
    if (hasBeenPrompted) {
      return;
    }
    let cancelled = false;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      const shouldPrompt = await shouldPromptForTerminalSetup();
      if (!shouldPrompt || cancelled) return;

      persistentState.set('terminalSetupPromptShown', true);

      const confirmed = await requestConsentInteractive(
        TERMINAL_SETUP_CONSENT_MESSAGE,
        addConfirmUpdateExtensionRequest,
      );

      if (!confirmed || cancelled) return;

      const result = await terminalSetup();
      if (cancelled) return;
      addItem(
        {
          type: result.success ? 'info' : 'error',
          text: formatTerminalSetupResultMessage(result),
        },
        Date.now(),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [addConfirmUpdateExtensionRequest, addItem]);
}
