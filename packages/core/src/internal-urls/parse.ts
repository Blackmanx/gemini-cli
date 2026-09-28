/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure string parsing for internal URLs — no I/O, no scheme registry, no
 * knowledge of which schemes exist.
 *
 * The line-selector grammar that may follow a URL's path is ported here (it
 * lives in omp's read tool and TUI line-ranges module). Two things make the
 * grammar necessary at all:
 *
 * 1. `new URL()` reads a colon in the authority as a port separator, which
 *    breaks namespaced URLs like `skill://plugin:name`. So the components are
 *    extracted by regex instead.
 * 2. A trailing `:<chunk>` after a scheme is unambiguously a read selector even
 *    when malformed (`artifact://3:raw:-100-5`), so the whole chain is peeled
 *    and the selector parser — not the scheme handler — explains the error.
 */

/** Shared line-range chunk grammar, ported from omp's `line-ranges.ts`. */
const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
// Path splitting only peels complete ranges (not a trailing `+` or `L`).
const RANGE_SELECTOR_CHUNK = String.raw`${LINE_RANGE_CHUNK_SOURCE}(?<=[\d.-])`;
const RANGE_LIST_SOURCE = `${RANGE_SELECTOR_CHUNK}(?:,${RANGE_SELECTOR_CHUNK})*`;
// A tail selector: `-N` reads the last N lines.
const TAIL_CHUNK_SOURCE = String.raw`-\d+`;
/**
 * Permissive selector chunk for internal URLs — accepts well-formed selectors
 * plus common malformed shapes (e.g. `:-N-M`) so the entire chain is peeled
 * before dispatch.
 */
const SELECTOR_PART_RE = new RegExp(
  String.raw`^(?:raw|conflicts|img|${RANGE_LIST_SOURCE}|${TAIL_CHUNK_SOURCE}(?:[-+]\d+)?)$`,
  'i',
);

/** `scheme://` with an RFC 3986 scheme token. */
const HIERARCHICAL_SCHEME_RE = /^([a-z][a-z0-9+.-]{1,23}):\/\//i;
/** `scheme:/` single-slash alias, which is never followed by a second slash. */
const SINGLE_SLASH_SCHEME_RE = /^([a-z][a-z0-9+.-]{1,23}):\/(?!\/)/i;

// Schemes that own their URLs for other consumers: an internal URL never
// shadows a web or filesystem URL the tools already handle.
const EXTERNAL_SCHEMES: Readonly<Record<string, true>> = {
  about: true,
  data: true,
  file: true,
  ftp: true,
  http: true,
  https: true,
  javascript: true,
  mailto: true,
  ws: true,
  wss: true,
};

/**
 * Parsed internal URL. `rest` is everything after `scheme://` with the
 * read-selector chain removed; `scheme` is lowercased and empty for a
 * non-URL input.
 */
export interface ParsedInternalUrl {
  /** Lowercased scheme without `://`; empty string when `isScheme` is false. */
  scheme: string;
  /** Input after `://`, with a peeled selector chain removed. */
  rest: string;
  /**
   * Peeled read-selector chain, without its leading `:`. `undefined` when the
   * input carries none.
   */
  selector: string | undefined;
  /** Whether `input` is a hierarchical `scheme://` URL. */
  isScheme: boolean;
}

/**
 * Split a hierarchical `scheme://rest` URL into its lowercased scheme and the
 * text after `://`. `null` when `input` is not such a URL — a bare
 * `scheme:/rest` alias is not split here; normalize it first.
 */
export function splitScheme(
  input: string,
): { scheme: string; rest: string } | null {
  const match = HIERARCHICAL_SCHEME_RE.exec(input);
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    rest: input.slice(match[0].length),
  };
}

/**
 * Split a `scheme:/rest` single-slash alias into its lowercased scheme and the
 * text after `:/`. `null` for anything else, including the hierarchical
 * `scheme://` form.
 */
export function splitSingleSlashAlias(
  input: string,
): { scheme: string; rest: string } | null {
  const match = SINGLE_SLASH_SCHEME_RE.exec(input);
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    rest: input.slice(match[0].length),
  };
}

/**
 * Rewrite the registered single-slash alias `scheme:/x` to `scheme://x`.
 * `input` is returned unchanged when it is not that alias.
 */
export function normalizeSingleSlashAlias(
  scheme: string,
  input: string,
): string {
  const match = SINGLE_SLASH_SCHEME_RE.exec(input);
  if (!match || match[1].toLowerCase() !== scheme.toLowerCase()) return input;
  return `${match[1]}://${input.slice(match[0].length)}`;
}

/**
 * Whether `input` is shaped like an internal URL. Deliberately conservative:
 * a scheme must be a short known-shaped token (`2`–`24` chars, letters, digits,
 * `+`, `.`, `-`) followed by `://`, or a `scheme:/x` single-slash alias of the
 * same shape, and must not be a scheme the tools already own (`http`, `file`,
 * …). A Windows drive path (`C:\x`, `C:/x`), an external URL, and a plain
 * relative path all return false.
 */
export function looksLikeInternalUrl(input: string): boolean {
  const hierarchical = HIERARCHICAL_SCHEME_RE.exec(input);
  if (hierarchical) {
    return EXTERNAL_SCHEMES[hierarchical[1].toLowerCase()] !== true;
  }
  const alias = splitSingleSlashAlias(input);
  if (!alias) return false;
  if (EXTERNAL_SCHEMES[alias.scheme] === true) return false;
  return alias.rest.length > 0;
}

/**
 * Peel the trailing read-selector chain off `input` (`artifact://3:raw:1-50` →
 * `{ path: 'artifact://3', sel: 'raw:1-50' }`).
 *
 * Only schemes whose spec declares `lines` selectors peel; `none`/`opaque` and
 * unregistered schemes pass through untouched. With `portAuthority` and no
 * `/path` after the authority, nothing peels — a trailing `:N` is a port
 * (`ssh://host:2222`), not a selector. Malformed selector-shaped tails still
 * peel so the selector parser, not the scheme handler, explains them.
 */
export function peelSelector(
  input: string,
  selectors: 'lines' | 'none' | 'opaque',
  portAuthority?: boolean,
): { path: string; sel?: string } {
  const split = splitScheme(input);
  if (!split || selectors !== 'lines') return { path: input };
  if (portAuthority && !split.rest.includes('/')) return { path: input };

  const schemeEnd = input.length - split.rest.length;
  let path = input;
  const chunks: string[] = [];
  for (;;) {
    const colon = path.lastIndexOf(':');
    // Stop before crossing into the scheme separator `://`.
    if (colon < schemeEnd) break;
    const tail = path.slice(colon + 1);
    if (!SELECTOR_PART_RE.test(tail)) break;
    chunks.unshift(tail);
    path = path.slice(0, colon);
  }
  if (chunks.length === 0) return { path: input };
  return { path, sel: chunks.join(':') };
}

/**
 * Parse an internal URL into its components without touching the scheme
 * registry.
 *
 * The peeled {@link ParsedInternalUrl.selector} is spec-agnostic and therefore
 * conservative: `portAuthority` is assumed, so a scheme whose resources are
 * addressed by authority alone (`artifact://3:raw`) keeps `3:raw` intact here.
 * The spec-aware peel is {@link peelSelector}, which the router calls with the
 * registered spec; that result is authoritative for tools.
 */
export function parseInternalUrl(input: string): ParsedInternalUrl {
  const split = splitScheme(input);
  if (!split) {
    return { scheme: '', rest: input, selector: undefined, isScheme: false };
  }
  const { path, sel } = peelSelector(input, 'lines', true);
  return {
    scheme: split.scheme,
    rest: path.slice(split.scheme.length + 3),
    selector: sel,
    isScheme: true,
  };
}

// A `?` opening `key=value` pairs starts a URL query (`?op=search`); any other
// `?` is a glob character.
const QUERY_START_RE = /\?[\w.-]*=/;
const GLOB_CHARS_RE = /[*?[{]/;

/**
 * Whether `input` carries a glob in its path portion. The authority, the query
 * and the fragment never glob: `issue://owner/fix*` is a glob while
 * `issue://?search=fix*` and `memory://root#*` are not. Scheme-unaware — a
 * scheme whose authority is a host (`portAuthority`) narrows this further in
 * the router.
 */
export function isGlobInput(input: string): boolean {
  const split = splitScheme(input);
  const rest = split ? split.rest : input;

  const fragment = rest.indexOf('#');
  const beforeFragment = fragment === -1 ? rest : rest.slice(0, fragment);
  const query = beforeFragment.search(QUERY_START_RE);
  const beforeQuery =
    query === -1 ? beforeFragment : beforeFragment.slice(0, query);

  // Drop the authority: it names a host or an id, never a glob segment.
  const path = split
    ? beforeQuery.slice(beforeQuery.indexOf('/') + 1)
    : beforeQuery;
  return GLOB_CHARS_RE.test(path);
}
