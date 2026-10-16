/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-shaped token redaction for memory writes.
 *
 * Ported from oh-my-pi's `memory-backend/redact.ts`, with two differences:
 *
 *  1. **Reversible.** `redactSecrets` returns opaque placeholders plus the
 *     mapping needed to undo them. Text handed to the model is scrubbed, and
 *     `restoreTokens` puts the real values back in model-authored tool
 *     arguments immediately before those arguments execute. Without that, a
 *     tool that needs a literal credential (a deploy target, a signed URL) can
 *     never receive one.
 *  2. **Broader coverage.** oh-my-pi only had GitHub, npm, Slack, Google and
 *     AWS prefixes plus keyword/JWT heuristics. This adds GitLab, Stripe,
 *     HuggingFace, OpenAI, Anthropic, `Authorization: Bearer …`, PEM blocks and
 *     passwords embedded in URLs, and it can be handed the caller's environment
 *     values so a secret that only exists in `process.env` is caught too.
 *
 * The replacement is a single forward sweep: every position is visited once and
 * every match is stepped over, so the pass is O(n) with a small constant rather
 * than O(n * patterns) as a chain of global regexes would be.
 *
 * Nothing here logs. A secret lives in the returned `tokens` map and nowhere
 * else; the caller decides when to drop it.
 */

/** What `redactSecrets` replaces a secret with, and how to undo that. */
export interface RedactionResult {
  /** The input with every credential-shaped substring replaced. */
  text: string;
  /** Placeholder -> original value. Never persist this. */
  tokens: Record<string, string>;
}

export interface RedactOptions {
  /**
   * Literal values to treat as secret (typically the values of credential-ish
   * environment variables). Values shorter than {@link MIN_SECRET_VALUE_LENGTH}
   * are ignored: they collide with ordinary words far more often than they
   * protect anything.
   */
  envValues?: readonly string[];
}

/** Shortest value accepted as a whole-value secret, and shortest assignment RHS. */
const MIN_SECRET_VALUE_LENGTH = 8;

/** Placeholder shape. ASCII so it survives a round trip through a model. */
const TOKEN_PREFIX = '__gemini_secret_';
const TOKEN_SUFFIX = '__';

/**
 * Fixed-prefix provider tokens, as `[prefix, tail]` pairs.
 *
 * Matching is anchored on the literal prefix, so the tail is only ever tried
 * once per position the prefix actually appears at — no backtracking scan.
 * `tail` is compiled sticky (see {@link PROVIDER_RULES}) and matched from just
 * past the prefix.
 */
const PROVIDER_RULE_SOURCES: ReadonlyArray<readonly [string, string]> = [
  // AWS access key id.
  ['AKIA', '[A-Z0-9]{16}'],
  ['ASIA', '[A-Z0-9]{16}'],
  // Google API key.
  ['AIza', '[A-Za-z0-9_-]{30,}'],
  // GitHub personal access / OAuth / user / server / refresh tokens.
  ['ghp_', '[A-Za-z0-9]{20,}'],
  ['gho_', '[A-Za-z0-9]{20,}'],
  ['ghu_', '[A-Za-z0-9]{20,}'],
  ['ghs_', '[A-Za-z0-9]{20,}'],
  ['ghr_', '[A-Za-z0-9]{20,}'],
  ['github_pat_', '[A-Za-z0-9_]{20,}'],
  // GitLab personal access token.
  ['glpat-', '[A-Za-z0-9_-]{16,}'],
  // npm access token.
  ['npm_', '[A-Za-z0-9]{30,}'],
  // Slack bot/app/user/refresh/legacy tokens.
  ['xoxb-', '[A-Za-z0-9-]{10,}'],
  ['xoxa-', '[A-Za-z0-9-]{10,}'],
  ['xoxp-', '[A-Za-z0-9-]{10,}'],
  ['xoxr-', '[A-Za-z0-9-]{10,}'],
  ['xoxs-', '[A-Za-z0-9-]{10,}'],
  // HuggingFace access token.
  ['hf_', '[A-Za-z0-9]{30,}'],
  // Stripe secret / restricted / publishable keys.
  ['sk_live_', '[A-Za-z0-9]{10,}'],
  ['sk_test_', '[A-Za-z0-9]{10,}'],
  ['rk_live_', '[A-Za-z0-9]{10,}'],
  ['rk_test_', '[A-Za-z0-9]{10,}'],
  ['pk_live_', '[A-Za-z0-9]{10,}'],
  ['pk_test_', '[A-Za-z0-9]{10,}'],
  // Anthropic, then OpenAI (project keys first: both start with `sk-`).
  ['sk-ant-', '[A-Za-z0-9_-]{24,}'],
  ['sk-proj-', '[A-Za-z0-9_-]{20,}'],
  ['sk-', '[A-Za-z0-9_-]{20,}'],
];

interface ProviderRule {
  readonly prefix: string;
  /** Sticky, so `exec` can only match at `lastIndex`. */
  readonly tail: RegExp;
}

const PROVIDER_RULES: ProviderRule[] = PROVIDER_RULE_SOURCES.map(
  ([prefix, tail]) => ({ prefix, tail: new RegExp(tail, 'y') }),
);

/** First character -> the rules that can start there. */
const PROVIDER_RULES_BY_FIRST_CHAR: Record<string, ProviderRule[]> = {};

for (const rule of PROVIDER_RULES) {
  const key = rule.prefix.charAt(0);
  const bucket = PROVIDER_RULES_BY_FIRST_CHAR[key];
  if (bucket) {
    bucket.push(rule);
  } else {
    PROVIDER_RULES_BY_FIRST_CHAR[key] = [rule];
  }
}

/**
 * Longest first, so `token` wins over `tok` and the reported match start covers
 * the whole keyword.
 */
const KEYWORDS: readonly string[] = [
  'password',
  'passwd',
  'api_key',
  'apikey',
  'secret',
  'token',
  'pwd',
  'key',
  'tok',
  'sk',
  'pk',
  'rk',
];

/**
 * A segment mixing letters and digits is credential-like at 12 characters;
 * letters alone need 16, which still catches `password-supersecretvalue` and
 * `token-abcdefghijklmnop` while leaving `authentication` and `configuration`
 * alone.
 */
const MIN_MIXED_SEGMENT = 12;
const MIN_LETTERS_SEGMENT = 16;

const MIN_JWT_SEGMENT = 16;

const PEM_BEGIN = '-----BEGIN';
const PEM_END = '-----END';

const CHAR_HYPHEN = 45;
const CHAR_UNDERSCORE = 95;
const CHAR_DOT = 46;
const CHAR_COLON = 58;
const CHAR_SLASH = 47;
const CHAR_EQUALS = 61;
const CHAR_LOWER_B = 98;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_AT = 64;
const CHAR_QUESTION = 63;
const CHAR_HASH = 35;
const CHAR_QUOTE = 34;
const CHAR_APOSTROPHE = 39;
const CHAR_BACKTICK = 96;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;

function isDelimiter(code: number): boolean {
  return code === CHAR_HYPHEN || code === CHAR_UNDERSCORE;
}

function isTokenChar(code: number): boolean {
  return (
    (code >= CHAR_ZERO && code <= CHAR_NINE) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z) ||
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z) ||
    isDelimiter(code)
  );
}

function isCredentialSegment(
  length: number,
  letter: boolean,
  digit: boolean,
): boolean {
  if (!letter && !digit) {
    return false;
  }
  if (letter && digit) {
    return length >= MIN_MIXED_SEGMENT;
  }
  return length >= MIN_LETTERS_SEGMENT;
}

function isSpace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_TAB;
}

/**
 * `input.startsWith(needle, index)`, case-insensitively. `needle` must already
 * be lowercase; only `A`..`Z` are folded (`code | 0x20`), so no other character
 * can alias a letter.
 */
function startsWithFolded(
  input: string,
  needle: string,
  index: number,
): boolean {
  if (index + needle.length > input.length) {
    return false;
  }
  for (let offset = 0; offset < needle.length; offset++) {
    if (
      (input.charCodeAt(index + offset) | 0x20) !==
      needle.charCodeAt(offset)
    ) {
      return false;
    }
  }
  return true;
}

interface SecretSpan {
  readonly start: number;
  readonly end: number;
}

/** `-----BEGIN … -----END …-----`; an unterminated block runs to end of text. */
function pemSpan(input: string, index: number): SecretSpan | undefined {
  if (!input.startsWith(PEM_BEGIN, index)) {
    return undefined;
  }
  const end = input.indexOf(PEM_END, index);
  if (end < 0) {
    return { start: index, end: input.length };
  }
  const lineEnd = input.indexOf('\n', end);
  return { start: index, end: lineEnd < 0 ? input.length : lineEnd + 1 };
}

/** `Authorization: Bearer <token>` — the header value, not the header name. */
function bearerSpan(input: string, index: number): SecretSpan | undefined {
  if (
    index + 7 > input.length ||
    (input.charCodeAt(index) | 0x20) !== CHAR_LOWER_B
  ) {
    return undefined;
  }
  if (!startsWithFolded(input, 'bearer ', index)) {
    return undefined;
  }
  const start = index + 7;
  let end = start;
  while (end < input.length && !isSpace(input.charCodeAt(end))) {
    end++;
  }
  if (end - start < 8) {
    return undefined;
  }
  return { start, end };
}

/** A password in `scheme://user:password@host`. */
function urlPasswordSpan(input: string, index: number): SecretSpan | undefined {
  if (
    input.charCodeAt(index) !== CHAR_COLON ||
    input.charCodeAt(index + 1) !== CHAR_SLASH ||
    input.charCodeAt(index + 2) !== CHAR_SLASH
  ) {
    return undefined;
  }
  const authorityStart = index + 3;
  let at = authorityStart;
  let colon = -1;
  while (at < input.length) {
    const code = input.charCodeAt(at);
    if (code === CHAR_AT) {
      break;
    }
    if (
      isSpace(code) ||
      code === CHAR_SLASH ||
      code === CHAR_QUESTION ||
      code === CHAR_HASH ||
      code === CHAR_QUOTE
    ) {
      return undefined;
    }
    if (code === CHAR_COLON && colon < 0) {
      colon = at;
    }
    at++;
  }
  if (at >= input.length || colon < 0 || colon === authorityStart) {
    return undefined;
  }
  return { start: colon + 1, end: at };
}

/** `header.payload.signature` with three long base64url-ish segments. */
function jwtSpan(input: string, index: number): SecretSpan | undefined {
  let first = index;
  while (first < input.length && isTokenChar(input.charCodeAt(first))) {
    first++;
  }
  if (first - index < MIN_JWT_SEGMENT || input.charCodeAt(first) !== CHAR_DOT) {
    return undefined;
  }
  let second = first + 1;
  while (second < input.length && isTokenChar(input.charCodeAt(second))) {
    second++;
  }
  if (
    second - first - 1 < MIN_JWT_SEGMENT ||
    input.charCodeAt(second) !== CHAR_DOT
  ) {
    return undefined;
  }
  let third = second + 1;
  while (third < input.length && isTokenChar(input.charCodeAt(third))) {
    third++;
  }
  if (third - second - 1 < MIN_JWT_SEGMENT) {
    return undefined;
  }
  return { start: index, end: third };
}

/**
 * End of a `keyword<delimiter>credential-looking-run` sequence, or -1.
 *
 * Text like `token_aaaa-token_aaaa-…` is one unbroken run of token characters,
 * and "some later segment of this run mixes letters and digits" is not
 * expressible without a lookahead that rescans the tail once per candidate.
 * Instead the run is walked once, marking each segment, and the run is redacted
 * whole when any segment past the keyword looks like a credential — which is
 * what a reader would do with it.
 */
function keywordSecretEnd(
  input: string,
  start: number,
  keywordLength: number,
): number {
  const delimiter = start + keywordLength;
  if (!isDelimiter(input.charCodeAt(delimiter))) {
    return -1;
  }
  let index = delimiter + 1;
  let length = 0;
  let letter = false;
  let digit = false;
  let credential = false;
  while (index < input.length && isTokenChar(input.charCodeAt(index))) {
    const code = input.charCodeAt(index);
    if (isDelimiter(code)) {
      credential = credential || isCredentialSegment(length, letter, digit);
      length = 0;
      letter = false;
      digit = false;
    } else {
      length++;
      if (code >= CHAR_ZERO && code <= CHAR_NINE) {
        digit = true;
      } else {
        letter = true;
      }
    }
    index++;
  }
  credential = credential || isCredentialSegment(length, letter, digit);
  return credential ? index : -1;
}

/** Whitespace tolerated between a keyword/separator and its value. */
const MAX_ASSIGN_SPACES = 4;

/** `index` advanced past up to `max` spaces/tabs. */
function skipSpaces(input: string, index: number, max: number): number {
  let skipped = 0;
  while (
    skipped < max &&
    index < input.length &&
    isSpace(input.charCodeAt(index))
  ) {
    index++;
    skipped++;
  }
  return index;
}

/**
 * Whether a value looks like a credential rather than code: it mixes letters
 * and digits, or is a long letter-only run. `getToken()`, `undefined`, `true`
 * and short words fail both, which is what keeps `const token = getToken();`
 * readable while `password = hunter2000` is not.
 */
function isCredentialValue(
  length: number,
  letter: boolean,
  digit: boolean,
): boolean {
  if (letter && digit) {
    return length >= MIN_SECRET_VALUE_LENGTH;
  }
  if (letter) {
    return length >= MIN_LETTERS_SEGMENT;
  }
  return false;
}

/**
 * `password = hunter2000` / `apiKey: "abcdefgh"` — the value, not the key.
 * Whitespace is allowed on both sides of the separator, which is how config
 * files are actually written (`.env`, `~/.aws/credentials`, ini, yaml); a value
 * separated by whitespace must then look credential-shaped, so ordinary
 * assignments in code are left alone.
 */
function assignmentSpan(
  input: string,
  start: number,
  keywordLength: number,
): SecretSpan | undefined {
  let index = skipSpaces(input, start + keywordLength, MAX_ASSIGN_SPACES);
  const separator = input.charCodeAt(index);
  if (separator !== CHAR_EQUALS && separator !== CHAR_COLON) {
    return undefined;
  }
  // `key::value` and `scheme://value` are not assignments.
  if (separator === CHAR_COLON && input.charCodeAt(index + 1) === CHAR_COLON) {
    return undefined;
  }
  index++;
  const spaced = isSpace(input.charCodeAt(index));
  index = skipSpaces(input, index, MAX_ASSIGN_SPACES);
  if (
    index < input.length &&
    (input.charCodeAt(index) === CHAR_QUOTE ||
      input.charCodeAt(index) === CHAR_APOSTROPHE ||
      input.charCodeAt(index) === CHAR_BACKTICK)
  ) {
    index++;
  }
  const valueStart = index;
  let letter = false;
  let digit = false;
  while (index < input.length && !isSpace(input.charCodeAt(index))) {
    const code = input.charCodeAt(index);
    if (
      code === CHAR_QUOTE ||
      code === CHAR_APOSTROPHE ||
      code === CHAR_BACKTICK
    ) {
      break;
    }
    if (code >= CHAR_ZERO && code <= CHAR_NINE) digit = true;
    else if (!isDelimiter(code)) letter = true;
    index++;
  }
  const length = index - valueStart;
  if (
    spaced
      ? !isCredentialValue(length, letter, digit)
      : length < MIN_SECRET_VALUE_LENGTH
  ) {
    return undefined;
  }
  return { start: valueStart, end: index };
}

/**
 * `password hunter2000` — the `.netrc`/`.pgpass` shape, where the value follows
 * the keyword with only whitespace between them. Matched only from a token-run
 * start and only when the value itself looks credential-shaped, so prose like
 * "password authentication failed" is left untouched.
 */
function spacedValueSpan(
  input: string,
  start: number,
  keywordLength: number,
): SecretSpan | undefined {
  if (start > 0 && isTokenChar(input.charCodeAt(start - 1))) {
    return undefined;
  }
  const afterKeyword = start + keywordLength;
  if (!isSpace(input.charCodeAt(afterKeyword))) {
    return undefined;
  }
  let index = skipSpaces(input, afterKeyword, MAX_ASSIGN_SPACES);
  const valueStart = index;
  let letter = false;
  let digit = false;
  while (index < input.length && !isSpace(input.charCodeAt(index))) {
    const code = input.charCodeAt(index);
    if (
      code === CHAR_QUOTE ||
      code === CHAR_APOSTROPHE ||
      code === CHAR_BACKTICK
    ) {
      break;
    }
    if (code >= CHAR_ZERO && code <= CHAR_NINE) digit = true;
    else if (!isDelimiter(code)) letter = true;
    index++;
  }
  if (!isCredentialValue(index - valueStart, letter, digit)) {
    return undefined;
  }
  return { start: valueStart, end: index };
}

function buildEnvIndex(
  envValues: readonly string[] | undefined,
): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  if (!envValues) {
    return index;
  }
  // Longest first so `LONG_SECRET` is preferred over `SECRET`.
  const usable = envValues
    .filter((value) => value.length >= MIN_SECRET_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of usable) {
    const key = value.charAt(0);
    const bucket = index[key];
    if (bucket) {
      bucket.push(value);
    } else {
      index[key] = [value];
    }
  }
  return index;
}

/** First token number not already present in `input`, so a restore is unambiguous. */
function firstFreeTokenNumber(input: string): number {
  const pattern = new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g');
  let highest = 0;
  let match = pattern.exec(input);
  while (match !== null) {
    const found = Number.parseInt(match[1], 10);
    if (found > highest) {
      highest = found;
    }
    match = pattern.exec(input);
  }
  return highest + 1;
}

/**
 * The credential-shaped run starting at `index`, if any.
 *
 * Ordering is by specificity: an anchored provider prefix is evidence on its
 * own, while the keyword heuristics are evidence only in context.
 */
function matchSecretSpan(
  input: string,
  index: number,
  envIndex: Record<string, string[]>,
): SecretSpan | undefined {
  const pem = pemSpan(input, index);
  if (pem) {
    return pem;
  }

  const envBucket = envIndex[input.charAt(index)];
  if (envBucket) {
    for (const value of envBucket) {
      if (input.startsWith(value, index)) {
        return { start: index, end: index + value.length };
      }
    }
  }

  const rules = PROVIDER_RULES_BY_FIRST_CHAR[input.charAt(index)];
  if (rules) {
    for (const rule of rules) {
      if (!input.startsWith(rule.prefix, index)) {
        continue;
      }
      rule.tail.lastIndex = index + rule.prefix.length;
      const matched = rule.tail.exec(input);
      if (matched && matched[0].length > 0) {
        return { start: index, end: matched.index + matched[0].length };
      }
    }
  }

  const bearer = bearerSpan(input, index);
  if (bearer) {
    return bearer;
  }

  const url = urlPasswordSpan(input, index);
  if (url) {
    return url;
  }

  const atRunStart = index === 0 || !isTokenChar(input.charCodeAt(index - 1));
  if (atRunStart) {
    const jwt = jwtSpan(input, index);
    if (jwt) {
      return jwt;
    }
  }

  for (const keyword of KEYWORDS) {
    if (!startsWithFolded(input, keyword, index)) {
      continue;
    }
    const end = keywordSecretEnd(input, index, keyword.length);
    if (end > index) {
      return { start: index, end };
    }
    const assigned = assignmentSpan(input, index, keyword.length);
    if (assigned) {
      return assigned;
    }
    const spaced = spacedValueSpan(input, index, keyword.length);
    if (spaced) {
      return spaced;
    }
  }
  return undefined;
}

/**
 * Replace every credential-shaped substring in `input` with an opaque
 * placeholder, and return the mapping needed by {@link restoreTokens}.
 *
 * The sweep is single-pass: `matchSecretSpan` is consulted once per position
 * and every match is stepped over, so no character is examined twice except
 * inside the run a match is measuring.
 */
export function redactSecrets(
  input: string,
  options?: RedactOptions,
): RedactionResult {
  const envIndex = buildEnvIndex(options?.envValues);
  const tokens: Record<string, string> = {};
  let counter = firstFreeTokenNumber(input);
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < input.length) {
    const span = matchSecretSpan(input, index, envIndex);
    if (!span) {
      index++;
      continue;
    }
    const placeholder = `${TOKEN_PREFIX}${counter}${TOKEN_SUFFIX}`;
    counter++;
    tokens[placeholder] = input.slice(span.start, span.end);
    out += `${input.slice(copied, span.start)}${placeholder}`;
    copied = span.end;
    index = span.end;
  }
  if (copied === 0) {
    return { text: input, tokens };
  }
  return { text: out + input.slice(copied), tokens };
}

/** {@link redactSecrets}, discarding the tokens. Use for anything persisted. */
export function redactText(input: string, options?: RedactOptions): string {
  return redactSecrets(input, options).text;
}

/**
 * Put the values behind {@link redactSecrets}' placeholders back.
 *
 * Call this on model-authored text immediately before it is used as a tool
 * argument, never on anything that is displayed, logged or stored.
 */
export function restoreTokens(
  text: string,
  tokens: Record<string, string>,
): string {
  let restored = text;
  for (const [placeholder, value] of Object.entries(tokens)) {
    if (value !== '' && restored.includes(placeholder)) {
      restored = restored.split(placeholder).join(value);
    }
  }
  return restored;
}
