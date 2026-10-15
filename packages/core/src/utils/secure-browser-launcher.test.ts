/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openBrowserSecurely,
  shouldLaunchBrowser,
} from './secure-browser-launcher.js';

// Create mock function using vi.hoisted
const mockExecFile = vi.hoisted(() => vi.fn());
const mockIsWsl = vi.hoisted(() => vi.fn(() => false));

// Mock modules
vi.mock('node:child_process');
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));
vi.mock('./windowsContext.js', () => ({
  isWsl: mockIsWsl,
}));

describe('secure-browser-launcher', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockIsWsl.mockReturnValue(false);
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  describe('URL validation', () => {
    it('should allow valid HTTP URLs', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('http://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['http://example.com'],
        expect.any(Object),
      );
    });

    it('should allow valid HTTPS URLs', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should reject non-HTTP(S) protocols', async () => {
      await expect(openBrowserSecurely('file:///etc/passwd')).rejects.toThrow(
        'Unsafe protocol',
      );
      await expect(openBrowserSecurely('javascript:alert(1)')).rejects.toThrow(
        'Unsafe protocol',
      );
      await expect(openBrowserSecurely('ftp://example.com')).rejects.toThrow(
        'Unsafe protocol',
      );
    });

    it('should reject invalid URLs', async () => {
      await expect(openBrowserSecurely('not-a-url')).rejects.toThrow(
        'Invalid URL',
      );
      await expect(openBrowserSecurely('')).rejects.toThrow('Invalid URL');
    });

    it('should reject URLs with control characters', async () => {
      await expect(
        openBrowserSecurely('http://example.com\nmalicious-command'),
      ).rejects.toThrow('invalid characters');
      await expect(
        openBrowserSecurely('http://example.com\rmalicious-command'),
      ).rejects.toThrow('invalid characters');
      await expect(
        openBrowserSecurely('http://example.com\x00'),
      ).rejects.toThrow('invalid characters');
    });
  });

  describe('Command injection prevention', () => {
    it('should prevent PowerShell command injection on Windows', async () => {
      setPlatform('win32');

      // The POC from the vulnerability report
      const maliciousUrl =
        "http://127.0.0.1:8080/?param=example#$(Invoke-Expression([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('Y2FsYy5leGU='))))";

      await openBrowserSecurely(maliciousUrl);

      // Verify that execFile was called (not exec) and the URL is passed safely
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process '${maliciousUrl.replace(/'/g, "''")}'`,
        ],
        expect.any(Object),
      );
    });

    it('should handle URLs with special shell characters safely', async () => {
      setPlatform('darwin');

      const urlsWithSpecialChars = [
        'http://example.com/path?param=value&other=$value',
        'http://example.com/path#fragment;command',
        'http://example.com/$(whoami)',
        'http://example.com/`command`',
        'http://example.com/|pipe',
        'http://example.com/>redirect',
      ];

      for (const url of urlsWithSpecialChars) {
        await openBrowserSecurely(url);
        // Verify the URL is passed as an argument, not interpreted by shell
        expect(mockExecFile).toHaveBeenCalledWith(
          'open',
          [url],
          expect.any(Object),
        );
      }
    });

    it('should properly escape single quotes in URLs on Windows', async () => {
      setPlatform('win32');

      const urlWithSingleQuotes =
        "http://example.com/path?name=O'Brien&test='value'";
      await openBrowserSecurely(urlWithSingleQuotes);

      // Verify that single quotes are escaped by doubling them
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process 'http://example.com/path?name=O''Brien&test=''value'''`,
        ],
        expect.any(Object),
      );
    });
  });

  describe('Platform-specific behavior', () => {
    it('should use correct command on macOS', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should use PowerShell on Windows', async () => {
      setPlatform('win32');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
          '-Command',
          `Start-Process 'https://example.com'`,
        ]),
        expect.any(Object),
      );
    });

    it('should use xdg-open on Linux', async () => {
      setPlatform('linux');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should throw on unsupported platforms', async () => {
      setPlatform('aix');
      await expect(openBrowserSecurely('https://example.com')).rejects.toThrow(
        'Unsupported platform',
      );
    });
  });

  describe('Error handling', () => {
    it('should handle browser launch failures gracefully', async () => {
      setPlatform('darwin');
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));

      await expect(openBrowserSecurely('https://example.com')).rejects.toThrow(
        'Failed to open browser',
      );
    });

    it('should try fallback browsers on Linux', async () => {
      setPlatform('linux');

      // First call to xdg-open fails
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      // Second call to gnome-open succeeds
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await openBrowserSecurely('https://example.com');

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'gnome-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });
  });

  describe('WSL', () => {
    it('should use wslview on WSL instead of xdg-open', async () => {
      setPlatform('linux');
      mockIsWsl.mockReturnValue(true);

      await openBrowserSecurely('https://example.com');

      expect(mockExecFile).toHaveBeenCalledWith(
        'wslview',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should fall back to the powershell interop bridge when wslview fails', async () => {
      setPlatform('linux');
      mockIsWsl.mockReturnValue(true);

      // First call to wslview fails (wslu not installed)
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      // Second call to powershell.exe succeeds
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await openBrowserSecurely("https://example.com/'quoted'");

      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'wslview',
        ["https://example.com/'quoted'"],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process 'https://example.com/''quoted'''`,
        ],
        expect.any(Object),
      );
    });

    describe('shouldLaunchBrowser', () => {
      const originalCI = process.env['CI'];
      const originalDebianFrontend = process.env['DEBIAN_FRONTEND'];

      beforeEach(() => {
        // These tests are host-independent: neutralize CI markers and any
        // display variables the dev host may export.
        delete process.env['CI'];
        delete process.env['DEBIAN_FRONTEND'];
        delete process.env['DISPLAY'];
        delete process.env['WAYLAND_DISPLAY'];
        delete process.env['MIR_SOCKET'];
      });

      afterEach(() => {
        if (originalCI !== undefined) process.env['CI'] = originalCI;
        if (originalDebianFrontend !== undefined) {
          process.env['DEBIAN_FRONTEND'] = originalDebianFrontend;
        }
      });

      it('should launch even without DISPLAY under WSL', () => {
        setPlatform('linux');
        mockIsWsl.mockReturnValue(true);

        expect(shouldLaunchBrowser()).toBe(true);
      });

      it('should not launch on plain Linux without a display server', () => {
        setPlatform('linux');
        mockIsWsl.mockReturnValue(false);

        expect(shouldLaunchBrowser()).toBe(false);
      });
    });
  });
});
