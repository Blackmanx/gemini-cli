/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnAsync } from './shell-utils.js';
import {
  isWsl,
  toWslPath,
  getWindowsUser,
  getWindowsPathContext,
  getCachedWindowsUserProfileRootSync,
  getWindowsUserProfileRoot,
  resetWindowsUserCacheForTesting,
} from './windowsContext.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('./shell-utils.js', () => ({
  spawnAsync: vi.fn(),
}));

const WSL_ENV_VARS = ['WSL_DISTRO_NAME', 'WSL_INTEROP', 'WSLENV'];

function clearWslEnv() {
  for (const name of WSL_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
}

describe('windowsContext', () => {
  beforeEach(() => {
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
    vi.stubEnv('WSL_INTEROP', undefined);
    vi.stubEnv('WSLENV', undefined);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(spawnAsync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
    resetWindowsUserCacheForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('isWsl', () => {
    it('detects WSL from WSL_DISTRO_NAME', () => {
      expect(isWsl()).toBe(true);
    });

    it('detects WSL from WSL_INTEROP', () => {
      vi.stubEnv('WSL_DISTRO_NAME', undefined);
      vi.stubEnv('WSL_INTEROP', 'InteropSession-123');
      expect(isWsl()).toBe(true);
    });

    it('detects WSL from the kernel release when env vars are absent', () => {
      clearWslEnv();
      vi.mocked(readFileSync).mockReturnValue(
        'Linux version 6.6.114.1-microsoft-standard-WSL2+',
      );
      expect(isWsl()).toBe(true);
    });

    it('is false on a plain Linux host', () => {
      clearWslEnv();
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(isWsl()).toBe(false);
    });
  });

  describe('toWslPath', () => {
    it('maps a C: path onto /mnt/c', () => {
      expect(toWslPath('C:\\Users\\jane.doe\\Downloads')).toBe(
        '/mnt/c/Users/jane.doe/Downloads',
      );
    });

    it('maps other drive letters and forward slashes', () => {
      expect(toWslPath('D:/work/report.docx')).toBe('/mnt/d/work/report.docx');
    });

    it('passes through paths that are not Windows paths', () => {
      expect(toWslPath('/home/user/file.txt')).toBe('/home/user/file.txt');
    });
  });

  describe('getWindowsUser', () => {
    it('parses username and profile from powershell output', async () => {
      vi.mocked(spawnAsync).mockResolvedValue({
        stdout: 'jane.doe\r\nC:\\Users\\jane.doe\r\n',
        stderr: '',
      });

      await expect(getWindowsUser()).resolves.toEqual({
        username: 'jane.doe',
        profile: 'C:\\Users\\jane.doe',
      });
    });

    it('caches the result across calls', async () => {
      vi.mocked(spawnAsync).mockResolvedValue({
        stdout: 'jane.doe\nC:\\Users\\jane.doe',
        stderr: '',
      });

      await getWindowsUser();
      await getWindowsUser();

      expect(spawnAsync).toHaveBeenCalledTimes(1);
    });

    it('returns null when powershell fails', async () => {
      vi.mocked(spawnAsync).mockRejectedValue(new Error('ENOENT'));

      await expect(getWindowsUser()).resolves.toBeNull();
    });

    it('returns null when the output is not a Windows profile', async () => {
      vi.mocked(spawnAsync).mockResolvedValue({
        stdout: 'jane.doe\n/some/unexpected/path',
        stderr: '',
      });

      await expect(getWindowsUser()).resolves.toBeNull();
    });
  });

  describe('getWindowsPathContext', () => {
    it('returns an empty string outside WSL', async () => {
      clearWslEnv();

      await expect(getWindowsPathContext()).resolves.toBe('');
      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('names the resolved Windows user and the path mapping rules', async () => {
      vi.mocked(spawnAsync).mockResolvedValue({
        stdout: 'jane.doe\nC:\\Users\\jane.doe',
        stderr: '',
      });

      const context = await getWindowsPathContext();

      expect(context).toContain('<windows_paths>');
      expect(context).toContain(
        'The Windows user is "jane.doe"',
      );
      expect(context).toContain('/mnt/c/Users/jane.doe');
      expect(context).toContain(
        'C:\\Users\\jane.doe\\Downloads\\Report.docx',
      );
      expect(context).toContain(
        '"Downloads" -> `/mnt/c/Users/<user>/Downloads`',
      );
      expect(context).toContain(
        'must be created under the Windows profile',
      );
    });

    it('falls back to self-service lookup instructions when powershell is unreachable', async () => {
      vi.mocked(spawnAsync).mockRejectedValue(new Error('ENOENT'));

      const context = await getWindowsPathContext();

      expect(context).toContain('/mnt/c/Users/<user>');
      expect(context).toContain('powershell.exe -NoProfile -Command $env:USERNAME');
      expect(context).not.toContain('The Windows user is');
    });
  });

  describe('windows profile root (disk cache)', () => {
    it('reads a previously cached profile synchronously', () => {
      vi.mocked(readFileSync).mockReturnValue(
        '{"username":"jane.doe","wslProfile":"/mnt/c/Users/jane.doe"}',
      );

      expect(getCachedWindowsUserProfileRootSync()).toBe(
        '/mnt/c/Users/jane.doe',
      );
      // The sync lookup never touches the interop bridge.
      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('ignores cache entries that are not WSL mounts', () => {
      vi.mocked(readFileSync).mockReturnValue(
        '{"username":"jane.doe","wslProfile":"C:\\\\Users\\\\jane.doe"}',
      );

      expect(getCachedWindowsUserProfileRootSync()).toBeNull();
    });

    it('returns null when there is no cache yet', () => {
      // readFileSync throws ENOENT from beforeEach.
      expect(getCachedWindowsUserProfileRootSync()).toBeNull();
    });

    it('resolves through powershell on first use and persists the answer', async () => {
      vi.mocked(spawnAsync).mockResolvedValue({
        stdout: 'jane.doe\nC:\\Users\\jane.doe',
        stderr: '',
      });

      await expect(getWindowsUserProfileRoot()).resolves.toBe(
        '/mnt/c/Users/jane.doe',
      );

      expect(mkdirSync).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
      const [, contents] = vi.mocked(writeFileSync).mock.calls[0];
      expect(String(contents)).toContain('/mnt/c/Users/jane.doe');
      expect(String(contents)).toContain('jane.doe');
    });

    it('reuses the disk cache without calling powershell', async () => {
      vi.mocked(readFileSync).mockReturnValue(
        '{"username":"jane.doe","wslProfile":"/mnt/c/Users/jane.doe"}',
      );

      await expect(getWindowsUserProfileRoot()).resolves.toBe(
        '/mnt/c/Users/jane.doe',
      );
      expect(spawnAsync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('returns null when the profile cannot be resolved', async () => {
      vi.mocked(spawnAsync).mockRejectedValue(new Error('ENOENT'));

      await expect(getWindowsUserProfileRoot()).resolves.toBeNull();
    });
  });
});
