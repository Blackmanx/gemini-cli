/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnAsync } from './shell-utils.js';
import { debugLogger } from './debugLogger.js';
import { Storage } from '../config/storage.js';

/** How long to wait for the Windows interop bridge before giving up. */
const POWERSHELL_TIMEOUT_MS = 5000;

export interface WindowsUser {
  /** e.g. "jane.doe" */
  username: string;
  /** Windows form of the profile directory, e.g. "C:\Users\jane.doe" */
  profile: string;
}

/**
 * Whether this process runs inside WSL (any version). Mirrors the detection
 * used for the Windows clipboard bridge.
 */
export function isWsl(): boolean {
  if (
    process.env['WSL_DISTRO_NAME'] ||
    process.env['WSL_INTEROP'] ||
    process.env['WSLENV'] !== undefined
  ) {
    return true;
  }
  try {
    // e.g. "Linux version 6.6.114.1-microsoft-standard-WSL2+ ..."
    return /microsoft/i.test(
      readFileSync('/proc/sys/kernel/osrelease', 'utf8'),
    );
  } catch {
    return false;
  }
}

/** Converts "C:\Users\jane.doe" to "/mnt/c/Users/jane.doe". */
export function toWslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return windowsPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

let windowsUserPromise: Promise<WindowsUser | null> | undefined;

/**
 * Resolves the Windows username and profile directory through the WSL
 * interop bridge. The result (including a failure) is cached for the
 * lifetime of the process: the answer essentially never changes mid-session
 * and the interop call costs a few hundred milliseconds.
 */
export function getWindowsUser(): Promise<WindowsUser | null> {
  windowsUserPromise ??= resolveWindowsUser();
  return windowsUserPromise;
}

/** Clears the cached Windows user. Test-only. */
export function resetWindowsUserCacheForTesting(): void {
  windowsUserPromise = undefined;
  profileRootPromise = undefined;
}

async function resolveWindowsUser(): Promise<WindowsUser | null> {
  try {
    const { stdout } = await spawnAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Write-Output $env:USERNAME; Write-Output $env:USERPROFILE',
      ],
      { timeout: POWERSHELL_TIMEOUT_MS },
    );
    const [username, profile] = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!username || !profile || !/^[A-Za-z]:[\\/]/.test(profile)) {
      debugLogger.debug(
        '[windowsContext] unexpected powershell output:',
        JSON.stringify(stdout),
      );
      return null;
    }
    return { username, profile };
  } catch (e) {
    debugLogger.debug('[windowsContext] Windows interop unreachable:', e);
    return null;
  }
}

let profileRootPromise: Promise<string | null> | undefined;

function windowsProfileCachePath(): string {
  return join(Storage.getGlobalGeminiDir(), 'windows-profile.json');
}

/**
 * Synchronous best-effort lookup of the Windows profile root in WSL form
 * (e.g. `/mnt/c/Users/jane.doe`), backed by the on-disk cache a previous
 * resolution left behind. Path validation is synchronous, so this is what
 * it consults: on the very first run there is no value until
 * {@link getWindowsUserProfileRoot} has completed.
 */
export function getCachedWindowsUserProfileRootSync(): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(windowsProfileCachePath(), 'utf8'),
    ) as { wslProfile?: unknown };
    if (
      typeof parsed.wslProfile === 'string' &&
      parsed.wslProfile.startsWith('/mnt/')
    ) {
      return parsed.wslProfile;
    }
  } catch {
    // First run, unreadable cache, or no WSL mount — nothing cached.
  }
  return null;
}

/**
 * The Windows user profile in WSL form, resolved through powershell on
 * first use and persisted to disk so later sessions start instantly.
 * null when it cannot be resolved (no interop, unexpected output).
 */
export function getWindowsUserProfileRoot(): Promise<string | null> {
  profileRootPromise ??= resolveProfileRoot();
  return profileRootPromise;
}

async function resolveProfileRoot(): Promise<string | null> {
  const cached = getCachedWindowsUserProfileRootSync();
  if (cached) return cached;

  const user = await getWindowsUser();
  if (!user) return null;

  const wslProfile = toWslPath(user.profile);
  if (!wslProfile.startsWith('/mnt/')) return null;

  try {
    mkdirSync(dirname(windowsProfileCachePath()), { recursive: true });
    writeFileSync(
      windowsProfileCachePath(),
      JSON.stringify({ username: user.username, wslProfile }, null, 2),
    );
  } catch (e) {
    debugLogger.debug('[windowsContext] could not persist profile cache:', e);
  }
  return wslProfile;
}

/**
 * A `<windows_paths>` block describing how Windows paths map onto the WSL
 * mount, or '' when not running under WSL. Without it the model has no way
 * to know that a bare "Downloads" in chat means the Windows profile on
 * /mnt/c, and every Windows file hand-off costs a round of questions.
 */
export async function getWindowsPathContext(): Promise<string> {
  if (!isWsl()) return '';

  const user = await getWindowsUser();
  const userLine = user
    ? `- The Windows user is "${user.username}"; their profile \`${user.profile}\` on Windows is \`${toWslPath(user.profile)}\` from WSL.`
    : '- The Windows user profile lives at `/mnt/c/Users/<user>`. To resolve `<user>` run `powershell.exe -NoProfile -Command $env:USERNAME` (or inspect `ls /mnt/c/Users`).';

  return `<windows_paths>
This session runs inside WSL, where the Windows drives are mounted under \`/mnt/<drive>\`.
- Mapping a Windows path to WSL: lowercase the drive letter, replace \`\\\` with \`/\`, and prefix \`/mnt/\`. Example: \`C:\\Users\\jane.doe\\Downloads\\Report.docx\` is \`/mnt/c/Users/jane.doe/Downloads/Report.docx\`.
${userLine}
- When the user names a Windows folder without a full path, it refers to their own profile: "Downloads" -> \`/mnt/c/Users/<user>/Downloads\`, "Desktop" -> \`/mnt/c/Users/<user>/Desktop\`, "Documents" -> \`/mnt/c/Users/<user>/Documents\`. Go look there directly instead of asking the user for the full path.
- Documents the user will review in Windows (Word, PowerPoint, Excel, PDF) must be created under the Windows profile — usually the user's Downloads folder — not in the Linux workspace, so the user can open them with Windows applications.
</windows_paths>`;
}
