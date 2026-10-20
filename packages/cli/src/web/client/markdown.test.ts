/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders a code block with its language and a copy button', () => {
    const html = renderMarkdown(
      '```typescript\nconst answer: number = 42;\n```',
    );

    expect(html).toContain('data-lang="typescript"');
    expect(html).toContain('class="code-copy"');
    expect(html).toContain('hljs');
    // The code itself is highlighted, not just escaped.
    expect(html).toMatch(/<span class="hljs-[^"]+">/);
  });

  it('labels a code block with no language as plain text', () => {
    const html = renderMarkdown('```\nhello\n```');
    expect(html).toContain('data-lang="text"');
  });

  it('escapes the language so it cannot break out of the attribute', () => {
    const html = renderMarkdown(
      '```"><img src=x onerror=alert(1)>\nhello\n```',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=');
  });

  it('keeps the shape of ordinary markdown', () => {
    const html = renderMarkdown('# Title\n\n- one\n- two\n\n**bold**');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('throws scripts away', () => {
    const html = renderMarkdown('before<script>alert("x")</script>after');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('throws event handlers away', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('will not follow a javascript link', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('will not follow a data link', () => {
    const html = renderMarkdown('[click](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('data:text/html');
  });

  it('keeps ordinary links', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
  });
});

describe('tables', () => {
  it('wraps a table so its cells can be copied in one go', () => {
    const html = renderMarkdown(
      '| Model | Reqs |\n| --- | --- |\n| pro | 3 |\n| flash | 5 |\n',
    );

    expect(html).toContain('class="table-wrap"');
    expect(html).toContain('class="table-copy"');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>pro</td>');
    expect(html).toContain('<td>flash</td>');
  });

  it('leaves text that is not a table alone', () => {
    const html = renderMarkdown('no tables here');
    expect(html).not.toContain('table-wrap');
  });
});
