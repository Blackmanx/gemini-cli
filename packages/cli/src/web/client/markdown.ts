/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { marked, type MarkedExtension } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { markedHighlight } from 'marked-highlight';
import 'highlight.js/styles/github.css';

/**
 * Renders markdown to sanitized HTML.
 *
 * The model's output is untrusted content, so it goes through DOMPurify before
 * it reaches the DOM. Code blocks are highlighted with highlight.js, which is
 * already a dependency of the CLI.
 */
const highlighter = markedHighlight({
  emptyLangClass: 'hljs',
  langPrefix: 'hljs language-',
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        // Fall through to the escaped plain text.
      }
    }
    return hljs.highlightAuto(code).value;
  },
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
marked.use(highlighter as MarkedExtension);

marked.setOptions({
  gfm: true,
  breaks: true,
});

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
];

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
    ],
    // Block javascript: and data: URLs in links and images.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#|\/|\.\/)/i,
  });
}
