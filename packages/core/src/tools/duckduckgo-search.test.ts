/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  decodeHtmlText,
  isAnomalyResponse,
  parseContinuationForm,
  parseDdgResults,
  unwrapResultUrl,
} from './duckduckgo-search.js';
import { formatDdgResult } from './web-search.js';

/** One result block shaped like the real no-JS frontend emits. */
function resultBlock(href: string, title: string, snippet?: string): string {
  const snippetHtml = snippet
    ? `<a class="result__snippet" href="x">${snippet}</a>`
    : '';
  return `<div class="result results_links results_links_deep web-result">
    <h2 class="result__title"><a class="result__a" href="${href}">${title}</a></h2>
    ${snippetHtml}
  </div>`;
}

const PAGE = `<html><body><div class="results">
${resultBlock(
  '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbackpressure',
  'Backpressuring in Streams',
  'A good example of why the backpressure mechanism matters.',
)}
${resultBlock('https://other.example.org/streams', 'Understanding Streams')}
</div></body></html>`;

describe('decodeHtmlText', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeHtmlText('a &amp; b &#39;c&#39; &#x27;d&#x27;')).toBe(
      "a & b 'c' 'd'",
    );
  });

  it('strips tags and collapses whitespace', () => {
    expect(decodeHtmlText('<b>Node.js</b>   stream\n\n  docs')).toBe(
      'Node.js stream docs',
    );
  });
});

describe('unwrapResultUrl', () => {
  it('unwraps the redirector form DuckDuckGo uses', () => {
    expect(
      unwrapResultUrl(
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbackpressure',
      ),
    ).toBe('https://example.com/backpressure');
  });

  it('keeps an already-absolute link', () => {
    expect(unwrapResultUrl('https://other.example.org/streams')).toBe(
      'https://other.example.org/streams',
    );
  });

  it('rejects a non-http scheme smuggled through the redirector', () => {
    expect(
      unwrapResultUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'),
    ).toBeUndefined();
  });
});

describe('parseDdgResults', () => {
  it('extracts title, url and snippet from each result', () => {
    const results = parseDdgResults(PAGE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Backpressuring in Streams',
      url: 'https://example.com/backpressure',
      snippet: 'A good example of why the backpressure mechanism matters.',
    });
  });

  it('omits the snippet when the page carries none', () => {
    const [second] = parseDdgResults(PAGE).slice(1);
    expect(second.snippet).toBeUndefined();
  });

  it('returns nothing for a page with no result blocks', () => {
    expect(parseDdgResults('<html><body>nope</body></html>')).toEqual([]);
  });
});

describe('isAnomalyResponse', () => {
  it('flags the bot challenge page', () => {
    expect(isAnomalyResponse('<script src="/dist/anomaly.js"></script>')).toBe(
      true,
    );
  });

  it('does not flag a real result page', () => {
    expect(isAnomalyResponse(PAGE)).toBe(false);
  });
});

describe('parseContinuationForm', () => {
  it('finds the next-page form regardless of attribute order', () => {
    const form = parseContinuationForm(
      '<form action="/html/"><input value="vqd-1" name="vqd"><input value="q1" name="s"></form>',
    );
    expect(form?.get('vqd')).toBe('vqd-1');
    expect(form?.get('s')).toBe('q1');
  });

  it('ignores a form missing the query state', () => {
    expect(
      parseContinuationForm('<form><input value="x" name="other"></form>'),
    ).toBeUndefined();
  });
});

describe('formatDdgResult', () => {
  it('renders title, url, date and snippet', () => {
    expect(
      formatDdgResult(
        {
          title: 'Streams',
          url: 'https://example.com/s',
          snippet: 'Text.',
          publishedDate: '2025-01-31',
        },
        0,
      ),
    ).toBe(
      '[1] Streams\nURL: https://example.com/s\nPublished: 2025-01-31\nText.',
    );
  });

  it('omits absent optional fields', () => {
    expect(formatDdgResult({ title: 'T', url: 'https://e.com' }, 4)).toBe(
      '[5] T\nURL: https://e.com',
    );
  });
});
