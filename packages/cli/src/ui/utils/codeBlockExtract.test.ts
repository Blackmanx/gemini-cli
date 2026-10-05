/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractCodeBlocks, lastCodeBlock } from './codeBlockExtract.js';

describe('extractCodeBlocks', () => {
  it('takes the body without fences or the language tag', () => {
    expect(extractCodeBlocks('```python\ndef f():\n    return 1\n```')).toEqual(
      ['def f():\n    return 1'],
    );
  });

  it('returns the last block when there are several', () => {
    const text = '```sh\nfirst\n```\ntext\n```sh\nsecond\n```';
    expect(lastCodeBlock(text)).toBe('second');
  });

  it('handles tilde fences', () => {
    expect(extractCodeBlocks('~~~js\nconst a = 1;\n~~~')).toEqual([
      'const a = 1;',
    ]);
  });

  it('does not close a backtick fence with a longer tilde run', () => {
    expect(extractCodeBlocks('```\n~~~\nstill code\n```')).toEqual([
      '~~~\nstill code',
    ]);
  });

  it('keeps blank lines inside a block', () => {
    expect(extractCodeBlocks('```\na\n\nb\n```')).toEqual(['a\n\nb']);
  });

  it('emits a block that is still streaming', () => {
    expect(extractCodeBlocks('```bash\nls -l')).toEqual(['ls -l']);
  });

  it('ignores text with no fences', () => {
    expect(extractCodeBlocks('just prose')).toEqual([]);
    expect(lastCodeBlock('just prose')).toBeNull();
  });

  it('ignores an inline code span', () => {
    expect(lastCodeBlock('use `rm -rf` carefully')).toBeNull();
  });

  it('trims trailing blank lines from the last block', () => {
    expect(lastCodeBlock('```\ncode\n\n\n```')).toBe('code');
  });
});
