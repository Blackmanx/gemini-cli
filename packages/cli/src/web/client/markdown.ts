/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { marked, type MarkedExtension, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

/** Tags the browser is allowed to keep from the rendered markdown. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'span',
  'div',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'details',
  'summary',
  'button',
];

/** Escapes the characters that would break out of an HTML attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders a fenced code block.
 *
 * The code is highlighted here rather than by a separate extension, so the
 * block can also carry the language label and a copy button of its own.
 */
function renderCode(code: string, language: string | undefined): string {
  const lang = language && hljs.getLanguage(language) ? language : '';
  const highlighted = lang
    ? hljs.highlight(code, { language: lang }).value
    : hljs.highlightAuto(code).value;
  const label = lang ? escapeHtml(lang) : 'text';
  return (
    `<pre data-lang="${label}">` +
    `<code class="hljs language-${label}">${highlighted}</code>` +
    `<button class="code-copy" type="button">Copy</button>` +
    `</pre>`
  );
}

marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      return renderCode(text, lang);
    },
  },
} as MarkedExtension);

marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Renders markdown into HTML that is safe to insert into the page. */
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false });
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [
      'href',
      'title',
      'target',
      'rel',
      'class',
      'src',
      'alt',
      'type',
      'checked',
      'disabled',
      'start',
      'data-lang',
    ],
    // Block javascript: and data: URLs in links and images.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#|\/|\.\/)/i,
  });
}
