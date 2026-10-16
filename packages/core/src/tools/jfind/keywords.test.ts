/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { keywords, keywordsFromQuery } from './keywords.js';

describe('keywordsFromQuery', () => {
  it('keeps quoted phrases whole and lowercased', () => {
    expect(keywordsFromQuery('find "Session Resume" logic')).toContain(
      'session resume',
    );
  });

  it('drops stopwords and pure digits but keeps informative tokens', () => {
    const result = keywordsFromQuery('the 42 files are ready when ready');
    expect(result).toContain('ready');
    expect(result).not.toContain('the');
    expect(result).not.toContain('42');
    expect(result).not.toContain('are');
  });

  it('stems long suffixes so inflected spellings collapse together', () => {
    expect(keywordsFromQuery('spawned')).toEqual(keywordsFromQuery('spawn'));
  });

  it('deduplicates tokens that stem to the same keyword', () => {
    expect(keywordsFromQuery('compact compacted')).toEqual(['compact']);
  });
});

describe('keywords', () => {
  it('appends caller extras lowercased and without duplicating query terms', () => {
    const result = keywords('Alpha beta', ['gamma ', 'ALPHA']);
    expect(result).toEqual(['alpha', 'beta', 'gamma']);
  });
});
