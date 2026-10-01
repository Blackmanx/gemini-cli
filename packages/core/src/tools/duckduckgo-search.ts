/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DuckDuckGo HTML search.
 *
 * The Gemini backend's `googleSearch` grounding returns a synthesized answer
 * plus bare titles and URLs - it never returns the text behind a link, and
 * the number of sources is whatever grounding decided to return. A real SERP
 * gives titles, URLs, snippets and dates, which is what makes a result
 * judgeable without a second round-trip.
 *
 * This uses the no-JS HTML frontend, so it needs no API key. The cost of
 * that is real: DuckDuckGo throttles automated requests from datacenter and
 * shared-egress IPs and answers with a bot challenge, and the markup is
 * scraped rather than versioned. Callers must treat a failure here as
 * "provider unavailable", not as "no results", and fall back to grounding.
 */

import { debugLogger } from '../utils/debugLogger.js';
import type { WebSearchRecency } from './web-search.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

/** Hard cap on results, matching the grounding tool's ceiling. */
export const DDG_MAX_RESULTS = 20;

/** Pages walked when the caller asks for more results than one page holds. */
const DDG_MAX_PAGES = 3;

/**
 * DuckDuckGo's `df` parameter. Unlike grounding, where recency is only a
 * sentence appended to the prompt, this is a server-side date filter.
 */
const RECENCY_TO_DDG_DF: Record<WebSearchRecency, string> = {
  day: 'd',
  week: 'w',
  month: 'm',
  year: 'y',
};

export interface DdgResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface DdgSearchResponse {
  results: DdgResult[];
  /** True when DuckDuckGo answered with its bot-detection page. */
  blocked: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/** Decode the HTML entities and tags that show up in scraped result text. */
export function decodeHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x?[0-9a-f]+;?/gi, (match) => {
      const isHex = /^&#x/i.test(match);
      const code = Number.parseInt(
        match.replace(/^&#x?/i, '').replace(/;$/, ''),
        isHex ? 16 : 10,
      );
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(
      /&([a-z]+|#\d+);?/gi,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DDG wraps result links in a redirector (`//duckduckgo.com/l/?uddg=<encoded>`).
 * Unwrap it; anything already absolute is used as-is.
 */
export function unwrapResultUrl(href: string): string | undefined {
  let decoded = decodeHtmlText(href);
  if (decoded.startsWith('//')) {
    decoded = `https:${decoded}`;
  }
  if (!/^https?:\/\//i.test(decoded)) {
    return undefined;
  }

  try {
    const url = new URL(decoded);
    const wrapped = url.searchParams.get('uddg');
    if (wrapped) {
      const inner = new URL(wrapped);
      return inner.protocol === 'http:' || inner.protocol === 'https:'
        ? inner.toString()
        : undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Pull a publication date out of a result block.
 *
 * DDG has no date field: when a result carries one it appears as a
 * date-shaped run inside the snippet, so anything recognized here is
 * best-effort and may match text that is not a date at all.
 */
function extractPublishedDate(block: string): string | undefined {
  const snippet =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/.exec(
      block,
    );
  if (!snippet) {
    return undefined;
  }
  const text = decodeHtmlText(snippet[1]);
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) {
    return iso[1];
  }
  return undefined;
}

/**
 * Parse the result list out of a DuckDuckGo HTML page.
 *
 * Exported for tests: this is the part that breaks first when DuckDuckGo
 * changes its markup, and it is the only reason to believe the provider
 * works without a network call.
 */
export function parseDdgResults(html: string): DdgResult[] {
  const results: DdgResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"|<div\b[^>]*\bclass="[^"]*\bnav-link\b[^"]*"|$)/g;
  const titleRe =
    /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;

  for (const match of html.matchAll(blockRe)) {
    const block = match[1];
    const title = titleRe.exec(block);
    if (!title) {
      continue;
    }
    const url = unwrapResultUrl(title[1]);
    if (!url) {
      continue;
    }
    const titleText = decodeHtmlText(title[2]);
    if (!titleText) {
      continue;
    }
    const snippet = snippetRe.exec(block);
    const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
    results.push({
      title: titleText,
      url,
      ...(snippetText ? { snippet: snippetText } : {}),
      ...(extractPublishedDate(block)
        ? { publishedDate: extractPublishedDate(block) }
        : {}),
    });
  }
  return results;
}

/**
 * DuckDuckGo answers a throttled request with a 200/202 and a challenge
 * modal rather than an error status, so the body is the only reliable
 * signal that the request was not served.
 */
export function isAnomalyResponse(html: string): boolean {
  return (
    /anomaly\.js|anomaly-modal|challenge-form/i.test(html) ||
    /bots use duckduckgo too/i.test(html)
  );
}

/**
 * Read the hidden fields of DuckDuckGo's next-page form so a follow-up
 * request continues the same result set instead of restarting it.
 *
 * Attribute order varies between responses, so each input is parsed on its
 * own rather than matching one fixed layout.
 */
export function parseContinuationForm(
  html: string,
): URLSearchParams | undefined {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = new URLSearchParams();
    for (const inputMatch of formMatch[1].matchAll(/<input\b[^>]*>/gi)) {
      const input = inputMatch[0];
      const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      if (name && value !== undefined) {
        form.append(decodeHtmlText(name), decodeHtmlText(value));
      }
    }
    if (form.has('s') && form.has('vqd')) {
      return form;
    }
  }
  return undefined;
}

function buildForm(
  query: string,
  recency: WebSearchRecency | undefined,
): URLSearchParams {
  const form = new URLSearchParams({ q: query, kl: 'us-en' });
  const df = recency ? RECENCY_TO_DDG_DF[recency] : undefined;
  if (df) {
    form.set('df', df);
  }
  // Matches a real browser form submission; DuckDuckGo expects it present.
  form.set('b', '');
  return form;
}

/**
 * One page request against the no-JS frontend.
 */
async function requestPage(
  form: URLSearchParams,
  signal: AbortSignal,
): Promise<{ html: string; status: number }> {
  const response = await fetch(DDG_HTML_URL, {
    method: 'POST',
    body: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://html.duckduckgo.com/',
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal,
  });
  return { html: await response.text(), status: response.status };
}
/**
 * Resolves with `blocked: true` when DuckDuckGo served a bot challenge -
 * that is a provider outage, not an empty result set, and the caller is
 * expected to fall back. Rejects only on transport failures.
 */
export async function searchDuckDuckGo(options: {
  query: string;
  limit?: number;
  recency?: WebSearchRecency;
  signal: AbortSignal;
}): Promise<DdgSearchResponse> {
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DDG_MAX_RESULTS, DDG_MAX_RESULTS),
  );
  const results: DdgResult[] = [];
  const seen = new Set<string>();

  let form = buildForm(options.query, options.recency);
  for (let page = 0; page < DDG_MAX_PAGES; page++) {
    const { html, status } = await requestPage(form, options.signal);
    if (status < 200 || status >= 300) {
      if (page === 0) {
        throw new Error(`DuckDuckGo HTML search failed (HTTP ${status})`);
      }
      break;
    }
    if (isAnomalyResponse(html)) {
      if (page === 0) {
        return { results: [], blocked: true };
      }
      break;
    }

    for (const result of parseDdgResults(html)) {
      if (seen.has(result.url)) {
        continue;
      }
      seen.add(result.url);
      results.push(result);
    }
    if (results.length >= limit) {
      break;
    }

    const next = parseContinuationForm(html);
    if (!next) {
      break;
    }
    // The continuation form carries its own `q` and `kl`; only advance `s`.
    next.set('q', options.query);
    next.delete('df');
    if (options.recency) {
      next.set('df', RECENCY_TO_DDG_DF[options.recency]);
    }
    form = next;
  }

  debugLogger.debug(
    `[DdgSearch] "${options.query}" returned ${results.length} results`,
  );
  return { results: results.slice(0, limit), blocked: false };
}
