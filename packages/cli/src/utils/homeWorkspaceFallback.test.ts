/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redirectHomeWorkspaceToTmp } from './homeWorkspaceFallback.js';

describe('redirectHomeWorkspaceToTmp', () => {
  let fakeHome: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-'));
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('stays in a real workspace directory', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-project-'));
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {});

    try {
      expect(redirectHomeWorkspaceToTmp(fakeHome, project)).toBeUndefined();
      expect(chdirSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('prefers ~/tmp, matching omp candidate order', () => {
    const homeTmp = path.join(fakeHome, 'tmp');
    fs.mkdirSync(homeTmp);
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {});

    expect(redirectHomeWorkspaceToTmp(fakeHome, os.tmpdir())).toBe(homeTmp);
    expect(chdirSpy).toHaveBeenCalledExactlyOnceWith(homeTmp);
  });

  it('skips a missing ~/tmp and takes the next candidate', () => {
    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {});

    // ~/tmp does not exist; /tmp does on this platform.
    expect(redirectHomeWorkspaceToTmp(fakeHome, os.tmpdir())).toBe('/tmp');
    expect(chdirSpy).toHaveBeenCalledExactlyOnceWith('/tmp');
  });

  it('actually changes the working directory', () => {
    vi.mocked(process.cwd).mockRestore();
    process.chdir(fakeHome);

    const destination = redirectHomeWorkspaceToTmp(fakeHome);

    expect(destination).toBe('/tmp');
    expect(process.cwd()).toBe('/tmp');
  });
});
