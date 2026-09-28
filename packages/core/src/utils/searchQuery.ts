/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structured web-search query parsing.
 *
 * Provider-neutral: this module only interprets operator syntax typed by the
 * user. It performs no network access and scrapes nothing.
 */

/** A raw query decomposed into free text plus every recognized constraint. */
export interface StructuredQuery {
  /** The original, unmodified input. */
  raw: string;
  /** Positive free-text terms (unquoted words). */
  terms: string[];
  /** Terms excluded via `-term`. */
  excludeTerms: string[];
  /** Quoted `"phrases"`. */
  phrases: string[];
  /** `a OR b OR c` groups, each a list of alternatives. */
  orGroups: string[][];
  sites: string[];
  excludeSites: string[];
  inUrls: string[];
  excludeInUrls: string[];
  inTitles: string[];
  excludeInTitles: string[];
  inTexts: string[];
  fileTypes: string[];
  excludeFileTypes: string[];
  /** ISO `YYYY-MM-DD`. */
  after?: string;
  /** ISO `YYYY-MM-DD`. */
  before?: string;
  langs: string[];
}

/** Operator families a target engine understands. */
export type QueryOperator = 'site' | 'inurl' | 'intitle' | 'filetype' | 'date';

const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i;

type AllMode = 'inTitle' | 'inUrl' | 'inText';

interface RawToken {
  text: string;
  /** Entire token was a quoted phrase. */
  quoted: boolean;
  /** Directive value was quoted (`intitle:"a b"`). */
  quotedValue?: boolean;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === '“' || ch === '”';
}

const WHITESPACE = /\s/;

/** Split a raw query into whitespace-delimited tokens, honoring quoted spans. */
function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const ch = raw[i];
    if (WHITESPACE.test(ch)) {
      i++;
      continue;
    }
    if (isQuote(ch)) {
      let j = i + 1;
      let buf = '';
      while (j < n && !isQuote(raw[j])) {
        buf += raw[j];
        j++;
      }
      if (buf.trim().length > 0) {
        tokens.push({ text: buf.trim(), quoted: true });
      }
      i = j + 1;
      continue;
    }
    let buf = '';
    let quotedValue = false;
    while (i < n && !WHITESPACE.test(raw[i])) {
      const c = raw[i];
      if (isQuote(c) && buf.endsWith(':')) {
        let j = i + 1;
        while (j < n && !isQuote(raw[j])) {
          buf += raw[j];
          j++;
        }
        quotedValue = true;
        i = j + 1;
        continue;
      }
      if (isQuote(c)) break;
      buf += c;
      i++;
    }
    if (buf.length > 0) tokens.push({ text: buf, quoted: false, quotedValue });
  }
  return tokens;
}

/** Convert year/month/day parts to a validated ISO date, or undefined. */
function isoDate(year: number, month: number, day: number): string | undefined {
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse an `after:`/`before:` value into ISO `YYYY-MM-DD`.
 * Accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD` and `YYYY/MM/DD`; bare years and
 * months resolve to the first day of the period.
 */
export function parseDateValue(value: string): string | undefined {
  const t = value.trim();
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t);
  if (m) {
    return isoDate(
      Number(m[1]),
      m[2] ? Number(m[2]) : 1,
      m[3] ? Number(m[3]) : 1,
    );
  }
  return undefined;
}

/** Lowercase a `site:` value and strip scheme, `*.` wildcard, trailing slash/dot. */
function normalizeSite(value: string): string {
  let site = value.trim().toLowerCase();
  site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  if (site.startsWith('*.')) site = site.slice(2);
  site = site.replace(/[/.]+$/, '');
  return site;
}

const DIRECTIVE_FIELDS: Record<
  string,
  | 'site'
  | 'inUrl'
  | 'inTitle'
  | 'inText'
  | 'filetype'
  | 'before'
  | 'after'
  | 'lang'
> = {
  site: 'site',
  domain: 'site',
  host: 'site',
  inurl: 'inUrl',
  url: 'inUrl',
  intitle: 'inTitle',
  title: 'inTitle',
  intext: 'inText',
  inbody: 'inText',
  filetype: 'filetype',
  ext: 'filetype',
  before: 'before',
  until: 'before',
  after: 'after',
  since: 'after',
  lang: 'lang',
  language: 'lang',
};

const ALL_MODES: Record<string, AllMode> = {
  allintitle: 'inTitle',
  allinurl: 'inUrl',
  allintext: 'inText',
};

function isReservedToken(text: string): boolean {
  if (
    text === '(' ||
    text === ')' ||
    text === 'OR' ||
    text === 'AND' ||
    text === 'NOT' ||
    text === '|' ||
    text === '||' ||
    text === '&&' ||
    text === '!'
  ) {
    return true;
  }
  const m = DIRECTIVE_PATTERN.exec(text);
  if (!m) return false;
  const name = m[2].toLowerCase();
  return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined;
}

/**
 * Parse a raw query into a {@link StructuredQuery}.
 *
 * Lenient: unknown `name:value` tokens stay free text, and a directive with an
 * unparseable value degrades to a plain term rather than being dropped.
 */
export function parseStructuredQuery(query: string): StructuredQuery {
  const q: StructuredQuery = {
    raw: query,
    terms: [],
    excludeTerms: [],
    phrases: [],
    orGroups: [],
    sites: [],
    excludeSites: [],
    inUrls: [],
    excludeInUrls: [],
    inTitles: [],
    excludeInTitles: [],
    inTexts: [],
    fileTypes: [],
    excludeFileTypes: [],
    langs: [],
  };

  const tokens = tokenize(query);
  let negateNext = false;
  let orPending = false;
  let lastWasTerm = false;
  let allMode: AllMode | undefined;
  let group: string[] = [];

  const flushGroup = (): void => {
    if (group.length > 1) {
      q.orGroups.push(group);
      for (const member of group) {
        q.terms.push(member);
      }
    } else if (group.length === 1) {
      q.terms.push(group[0]);
    }
    group = [];
  };

  const pushConstraint = (
    field: 'site' | 'inUrl' | 'inTitle' | 'inText' | 'filetype',
    value: string,
    negated: boolean,
  ): void => {
    orPending = false;
    lastWasTerm = false;
    const v = value.trim();
    if (!v) return;
    switch (field) {
      case 'site': {
        const site = normalizeSite(v);
        if (site) (negated ? q.excludeSites : q.sites).push(site);
        break;
      }
      case 'inUrl':
        (negated ? q.excludeInUrls : q.inUrls).push(v);
        break;
      case 'inTitle':
        (negated ? q.excludeInTitles : q.inTitles).push(v);
        break;
      case 'inText':
        q.inTexts.push(v);
        break;
      case 'filetype': {
        const ext = v.toLowerCase().replace(/^\.+/, '');
        if (ext) (negated ? q.excludeFileTypes : q.fileTypes).push(ext);
        break;
      }
      default:
        break;
    }
  };

  const pushTerm = (text: string, phrase: boolean): void => {
    const negated = negateNext;
    negateNext = false;
    if (allMode) {
      pushConstraint(allMode, text, negated);
      return;
    }
    if (negated) {
      q.excludeTerms.push(text);
      orPending = false;
      lastWasTerm = false;
      return;
    }
    if (phrase) {
      q.phrases.push(text);
      orPending = false;
      lastWasTerm = false;
      return;
    }
    if (orPending && lastWasTerm) {
      if (group.length === 0 && lastWasTerm) {
        const prev = q.terms.pop();
        if (prev !== undefined) group.push(prev);
      }
      group.push(text);
      orPending = false;
      lastWasTerm = true;
      return;
    }
    q.terms.push(text);
    lastWasTerm = true;
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];

    if (tok.quoted) {
      pushTerm(tok.text, true);
      continue;
    }

    if (tok.text === 'OR' || tok.text === '|' || tok.text === '||') {
      orPending = true;
      continue;
    }
    if (tok.text === 'AND' || tok.text === '&&') {
      continue;
    }
    if (tok.text === 'NOT' || tok.text === '!') {
      negateNext = true;
      continue;
    }
    if (tok.text === '-' || tok.text === '+') {
      if (tok.text === '-' && tokens[idx + 1]?.quoted) negateNext = true;
      continue;
    }

    const match = DIRECTIVE_PATTERN.exec(tok.text);
    const name = match?.[2].toLowerCase();
    const allMatch = name ? ALL_MODES[name] : undefined;
    const field = name ? DIRECTIVE_FIELDS[name] : undefined;

    if (match && allMatch) {
      allMode = allMatch;
      const inline = match[3].trim();
      if (inline) pushConstraint(allMatch, inline, match[1] === '-');
      orPending = false;
      lastWasTerm = false;
      continue;
    }

    if (match && field) {
      let value = match[3].trim();
      if (!value) {
        const next = tokens[idx + 1];
        if (next && (next.quoted || !isReservedToken(next.text))) {
          value = next.text.trim();
          idx++;
        }
      }
      if (!value) continue;
      const negated = match[1] === '-' || negateNext;
      negateNext = false;
      switch (field) {
        case 'before':
        case 'after': {
          const iso = parseDateValue(value);
          if (!iso) {
            pushTerm(tok.text, false);
            continue;
          }
          if (field === 'before') q.before = iso;
          else q.after = iso;
          orPending = false;
          lastWasTerm = false;
          break;
        }
        case 'lang':
          q.langs.push(value.toLowerCase());
          orPending = false;
          lastWasTerm = false;
          break;
        default:
          pushConstraint(field, value, negated);
      }
      continue;
    }

    let text = tok.text;
    if (text.startsWith('-') && text.length > 1) {
      negateNext = true;
      text = text.replace(/^-+/, '');
      if (!text) continue;
      const negMatch = DIRECTIVE_PATTERN.exec(text);
      const negName = negMatch?.[2].toLowerCase();
      const negField = negName ? DIRECTIVE_FIELDS[negName] : undefined;
      if (
        negMatch &&
        negField &&
        negField !== 'before' &&
        negField !== 'after' &&
        negField !== 'lang'
      ) {
        negateNext = false;
        pushConstraint(negField, negMatch[3].trim(), true);
        continue;
      }
      pushTerm(text, false);
      continue;
    }
    if (text.startsWith('+') && text.length > 1) {
      pushTerm(text.slice(1), true);
      continue;
    }
    pushTerm(text, false);
  }

  flushGroup();
  return q;
}

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Rebuild a query string, emitting only the operators in `opts.supports`.
 * With `opts.supports` omitted, every operator is emitted.
 */
export function formatQuery(
  q: StructuredQuery,
  opts?: { supports?: QueryOperator[] },
): string {
  const supports = opts?.supports;
  const has = (op: QueryOperator): boolean =>
    supports === undefined || supports.includes(op);
  const parts: string[] = [];

  const grouped = new Set(q.orGroups.flat());
  for (const group of q.orGroups) {
    parts.push(`(${group.join(' OR ')})`);
  }
  for (const term of q.terms) {
    if (!grouped.has(term)) parts.push(term);
  }
  parts.push(...q.phrases.map((p) => `"${p}"`));
  parts.push(...q.excludeTerms.map((t) => `-${t}`));
  parts.push(...q.inTexts.map((t) => `intext:${quoteValue(t)}`));

  if (has('site')) {
    parts.push(...q.sites.map((s) => `site:${s}`));
    parts.push(...q.excludeSites.map((s) => `-site:${s}`));
  }
  if (has('inurl')) {
    parts.push(...q.inUrls.map((v) => `inurl:${quoteValue(v)}`));
    parts.push(...q.excludeInUrls.map((v) => `-inurl:${quoteValue(v)}`));
  }
  if (has('intitle')) {
    parts.push(...q.inTitles.map((v) => `intitle:${quoteValue(v)}`));
    parts.push(...q.excludeInTitles.map((v) => `-intitle:${quoteValue(v)}`));
  }
  if (has('filetype')) {
    parts.push(...q.fileTypes.map((f) => `filetype:${f}`));
    parts.push(...q.excludeFileTypes.map((f) => `-filetype:${f}`));
  }
  if (has('date')) {
    if (q.after) parts.push(`after:${q.after}`);
    if (q.before) parts.push(`before:${q.before}`);
  }
  parts.push(...q.langs.map((l) => `lang:${l}`));

  const result = parts.join(' ').trim();
  return result || q.raw.trim();
}

/** Minimal shape `applyQueryConstraints` needs from a search result. */
export interface ConstraintTarget {
  url?: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

interface ConstraintDimension<T extends ConstraintTarget> {
  /** Dimension name used in the relaxation note. */
  dimension: string;
  /** Directive rendering used in the relaxation note. */
  label: string;
  pred: (item: T) => boolean;
}

function constraintDimensions<T extends ConstraintTarget>(
  q: StructuredQuery,
  items: readonly T[],
): Array<ConstraintDimension<T>> {
  const dims: Array<ConstraintDimension<T>> = [];
  const lower = (s: string | undefined): string => (s ?? '').toLowerCase();

  if (q.sites.length > 0) {
    dims.push({
      dimension: 'site',
      label: q.sites.map((s) => `site:${s}`).join(' OR '),
      pred: (it) =>
        q.sites.some((site) => lower(it.url).includes(site.toLowerCase())),
    });
  }
  if (q.excludeSites.length > 0) {
    dims.push({
      dimension: 'site',
      label: q.excludeSites.map((s) => `-site:${s}`).join(' '),
      pred: (it) =>
        !q.excludeSites.some((site) =>
          lower(it.url).includes(site.toLowerCase()),
        ),
    });
  }
  if (q.inUrls.length > 0) {
    dims.push({
      dimension: 'inurl',
      label: q.inUrls.map((v) => `inurl:${v}`).join(' '),
      pred: (it) =>
        q.inUrls.every((v) => lower(it.url).includes(v.toLowerCase())),
    });
  }
  if (q.excludeInUrls.length > 0) {
    dims.push({
      dimension: 'inurl',
      label: q.excludeInUrls.map((v) => `-inurl:${v}`).join(' '),
      pred: (it) =>
        !q.excludeInUrls.some((v) => lower(it.url).includes(v.toLowerCase())),
    });
  }
  if (q.inTitles.length > 0) {
    dims.push({
      dimension: 'intitle',
      label: q.inTitles.map((v) => `intitle:${v}`).join(' '),
      pred: (it) =>
        q.inTitles.every((v) => lower(it.title).includes(v.toLowerCase())),
    });
  }
  if (q.excludeInTitles.length > 0) {
    dims.push({
      dimension: 'intitle',
      label: q.excludeInTitles.map((v) => `-intitle:${v}`).join(' '),
      pred: (it) =>
        !q.excludeInTitles.some((v) =>
          lower(it.title).includes(v.toLowerCase()),
        ),
    });
  }
  if (q.fileTypes.length > 0) {
    dims.push({
      dimension: 'filetype',
      label: q.fileTypes.map((f) => `filetype:${f}`).join(' OR '),
      pred: (it) =>
        q.fileTypes.some((ext) =>
          lower(it.url).endsWith(`.${ext.toLowerCase()}`),
        ),
    });
  }
  if (q.excludeFileTypes.length > 0) {
    dims.push({
      dimension: 'filetype',
      label: q.excludeFileTypes.map((f) => `-filetype:${f}`).join(' '),
      pred: (it) =>
        !q.excludeFileTypes.some((ext) =>
          lower(it.url).endsWith(`.${ext.toLowerCase()}`),
        ),
    });
  }
  if (q.after !== undefined || q.before !== undefined) {
    const afterMs = q.after !== undefined ? Date.parse(q.after) : undefined;
    const beforeMs = q.before !== undefined ? Date.parse(q.before) : undefined;
    const anyDated = items.some((it) => !!it.publishedAt);
    dims.push({
      dimension: 'date',
      label: [
        q.after ? `after:${q.after}` : '',
        q.before ? `before:${q.before}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      pred: (it) => {
        if (!it.publishedAt) return !anyDated;
        const time = Date.parse(it.publishedAt);
        if (Number.isNaN(time)) return true;
        if (afterMs !== undefined && time < afterMs) return false;
        if (beforeMs !== undefined && time >= beforeMs) return false;
        return true;
      },
    });
  }
  if (q.terms.length > 0) {
    dims.push({
      dimension: 'terms',
      label: q.terms.join(' '),
      pred: (it) => {
        const hay = `${it.title ?? ''} ${it.snippet ?? ''}`.toLowerCase();
        return q.terms.every((t) => hay.includes(t.toLowerCase()));
      },
    });
  }
  if (q.phrases.length > 0) {
    dims.push({
      dimension: 'phrases',
      label: q.phrases.map((p) => `"${p}"`).join(' '),
      pred: (it) => {
        const hay = `${it.title ?? ''} ${it.snippet ?? ''}`.toLowerCase();
        return q.phrases.every((p) => hay.includes(p.toLowerCase()));
      },
    });
  }
  return dims;
}

/**
 * Lenient post-filter over already-fetched results.
 *
 * Each dimension applies independently; a dimension that would eliminate every
 * remaining item is relaxed and reported in `notes` instead of returning
 * nothing. No network access happens here.
 */
export function applyQueryConstraints<T extends ConstraintTarget>(
  items: T[],
  q: StructuredQuery,
): { items: T[]; notes: string[] } {
  let current = [...items];
  const notes: string[] = [];
  if (current.length === 0) return { items: current, notes };
  for (const dim of constraintDimensions(q, items)) {
    const kept = current.filter(dim.pred);
    if (kept.length > 0) {
      current = kept;
    } else {
      notes.push(
        `Note: no results matched ${dim.dimension} (${dim.label}); that filter was relaxed.`,
      );
    }
  }
  return { items: current, notes };
}
