/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reversible secret obfuscation.
 *
 * Ported from omp's `secrets/`. The problem it solves: a config value is
 * readable by the model, lands in transcripts, and is pasted into bug
 * reports. Redacting it irreversibly (`***`) breaks the tool that needs it.
 * Obfuscating it keeps it USABLE while making it useless to a reader who does
 * not hold the key.
 *
 * The placeholder is a keyed digest, not a counter. That single choice buys
 * three properties a counter cannot:
 *
 *  - **Unguessable.** The key is a per-install secret that never reaches a
 *    provider, so a reader cannot dictionary-hash candidate secrets to recover
 *    the mapping. A plain hash of the value would fall to exactly that.
 *  - **Stable.** The same secret yields the same placeholder in every session,
 *    so a transcript obfuscated last week still deobfuscates today. A counter
 *    would renumber and break persisted transcripts.
 *  - **Collision-safe.** Two different secrets cannot share a placeholder, so
 *    deobfuscation never has to guess which one was meant.
 *
 * The friendly label is a convenience for the model (`GITHUB_TOKEN` rather
 * than an opaque blob), so it is checked for leaking: a label that contains,
 * or is a visible prefix of, the secret would hand the secret straight back.
 */

/** Characters a label may use once sanitised. */
const HASH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Length of the digest in the placeholder.
 *
 * 12 base36 characters is ~62 bits. Sized for that on purpose: a shorter
 * digest would let unrelated secrets collide on a shared prefix, and a
 * collision means a persisted placeholder deobfuscating to the WRONG secret —
 * a silent, dangerous failure rather than a visible one.
 */
const HASH_LEN = 12;

const MAX_LABEL_LEN = 32;

/** A secret shorter than this is not a secret; redacting it only breaks text. */
export const MIN_SECRET_LENGTH = 8;

const TOKEN_PREFIX = '__secret_';
const TOKEN_SUFFIX = '__';

/** The per-install key, in memory, so repeated calls do not re-read the file. */
const cachedKeys = new Map<string, string>();

export function placeholderKeyPath(globalDir: string): string {
  return path.join(globalDir, 'secret-placeholder.key');
}

/**
 * The per-install placeholder key, created on first use.
 *
 * Written `wx` at mode 0600. `wx` matters: two processes racing to create the
 * key must not each end up believing in a different one, which would make
 * placeholders minted by one unresolvable by the other.
 */
export function getSecretPlaceholderKey(globalDir: string): string {
  const keyPath = placeholderKeyPath(globalDir);
  const cached = cachedKeys.get(keyPath);
  if (cached !== undefined) return cached;

  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing !== '') {
      cachedKeys.set(keyPath, existing);
      return existing;
    }
  } catch {
    // Absent or unreadable; fall through and mint one.
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(keyPath, 'wx', 0o600);
  } catch {
    // Lost the race. Whoever won wrote a valid key; use theirs.
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing === '') {
      throw new Error(
        `The secret placeholder key at ${keyPath} exists but is empty. ` +
          'Remove it to regenerate; doing so invalidates placeholders in ' +
          'previously recorded transcripts.',
      );
    }
    cachedKeys.set(keyPath, existing);
    return existing;
  }
  try {
    fs.writeFileSync(fd, generated, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  cachedKeys.set(keyPath, generated);
  return generated;
}

/** Drop the in-memory key cache. Exposed for tests. */
export function resetSecretPlaceholderKeyCache(): void {
  cachedKeys.clear();
}

/** A label reduced to the shape a model can read safely. */
export function sanitizeLabel(name: string): string | undefined {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const sliced = cleaned.slice(0, MAX_LABEL_LEN);
  return sliced.length > 0 ? sliced : undefined;
}

/** A value reduced to the same shape, for collision comparison. */
export function sanitizeForCollisionCheck(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Whether a label would leak the secret it labels.
 *
 * Two ways that happens: the label contains the whole (sanitised) secret, or
 * the label is long enough to hit the display cap and is a visible prefix of
 * it. The second is the one that is easy to miss — a 32-character label is
 * the visible start of a 40-character secret.
 */
export function labelCollidesWithSecret(
  label: string,
  secret: string,
): boolean {
  const sanitizedSecret = sanitizeForCollisionCheck(secret);
  if (sanitizedSecret.length === 0) return false;
  if (label.includes(sanitizedSecret)) return true;
  return label.length >= MAX_LABEL_LEN && sanitizedSecret.startsWith(label);
}

/**
 * The placeholder for one secret under one key.
 *
 * Deterministic in `(key, secret)`, which is what makes it both stable and
 * collision-safe.
 */
export function placeholderFor(
  key: string,
  secret: string,
  label?: string,
): string {
  const digest = crypto
    .createHmac('sha256', key)
    .update(secret, 'utf8')
    .digest();
  let hash = '';
  for (let i = 0; i < HASH_LEN; i++) {
    hash += HASH_CHARS[digest[i] % HASH_CHARS.length];
  }
  const safeLabel = label === undefined ? undefined : sanitizeLabel(label);
  const head =
    safeLabel === undefined || labelCollidesWithSecret(safeLabel, secret)
      ? 'SECRET'
      : safeLabel;
  return `${TOKEN_PREFIX}${head}_${hash}${TOKEN_SUFFIX}`;
}

const PLACEHOLDER_RE = /__secret_([A-Z0-9]{1,32}?)_([A-Z0-9]{12})__/g;

/** Every placeholder in `text`, with its label and digest. */
export function scanPlaceholders(
  text: string,
): Array<{ full: string; label: string; hash: string }> {
  const found: Array<{ full: string; label: string; hash: string }> = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let match = PLACEHOLDER_RE.exec(text);
  while (match !== null) {
    found.push({ full: match[0], label: match[1], hash: match[2] });
    match = PLACEHOLDER_RE.exec(text);
  }
  return found;
}

export interface ObfuscateResult {
  text: string;
  /** Placeholder -> secret, for the values that were replaced. */
  map: Record<string, string>;
  /** Secrets found but too short to be secrets; redacted, not reversible. */
  tooShort: string[];
}

/**
 * Replace every registered secret in `text` with its placeholder.
 *
 * Registered rather than pattern-matched on purpose: a known secret is an
 * exact fact, while a pattern match is a guess. Text that looks like a
 * credential but is not a registered one is left alone here — irreversibly
 * redacting real content (`redactText` does that) is the wrong trade for a
 * value the caller has not identified.
 *
 * Longest secret first, so a secret that is a prefix of another cannot
 * shadow it and leave a dangling tail.
 */
export function obfuscateSecrets(
  text: string,
  secrets: Record<string, string>,
  key: string,
): ObfuscateResult {
  const entries = Object.entries(secrets).filter(
    ([, value]) => value.length > 0,
  );
  const tooShort: string[] = [];
  const usable = entries.filter(([, value]) => {
    if (value.length >= MIN_SECRET_LENGTH) return true;
    tooShort.push(value);
    return false;
  });
  usable.sort((a, b) => b[1].length - a[1].length);

  const map: Record<string, string> = {};
  let out = text;
  for (const [name, value] of usable) {
    const placeholder = placeholderFor(key, value, name);
    if (!out.includes(placeholder)) {
      out = out.split(value).join(placeholder);
      map[placeholder] = value;
    }
  }
  return { text: out, map, tooShort };
}

/**
 * Put the values behind placeholders back.
 *
 * The map is authoritative and is consulted first, so a placeholder resolves
 * even when the secret set has since changed. A placeholder with no entry in
 * the map is restored by recomputing over `secrets` — the key is enough to
 * match, which is what makes an old transcript deobfuscate after the
 * configured secret set is reordered or extended.
 */
export function deobfuscateSecrets(
  text: string,
  map: Record<string, string>,
  key: string,
  secrets: Record<string, string> = {},
): string {
  let out = text;
  for (const [placeholder, secret] of Object.entries(map)) {
    out = out.split(placeholder).join(secret);
  }
  // Anything still holding a placeholder is resolved by digest.
  for (const name of Object.keys(secrets)) {
    const value = secrets[name];
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    const placeholder = placeholderFor(key, value, name);
    if (out.includes(placeholder)) {
      out = out.split(placeholder).join(value);
    }
  }
  return out;
}
