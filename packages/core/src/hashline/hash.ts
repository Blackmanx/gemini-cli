/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The four-uppercase-hex content tag that anchors every hashline edit.
 *
 * A tag is a CONTRACT with a model that already read a file: it says "the
 * content I am about to rewrite is byte-for-byte what I was shown". Once a
 * model has emitted `[src/a.ts#7F3A]`, that string has to keep meaning the
 * same thing on every machine, every Node build and every release, or correct
 * edits start being refused. That is why the algorithm is spelled out here
 * instead of being pulled from a library whose internals could move under us.
 *
 * It is XXH32 (seed 0) over the UTF-8 bytes of the normalised content, masked
 * to its low 16 bits and rendered as four uppercase hex digits. This matches
 * the algorithm `oh-my-pi` uses natively, so a tag minted here compares equal
 * to a tag minted there for the same bytes. It does NOT match any other hash
 * in this repository, and changing any step below is a breaking change that
 * invalidates every tag a model is currently holding.
 *
 * Normalisation, in order:
 *   1. a leading U+FEFF BOM is removed;
 *   2. CRLF and lone CR become LF, so a file checked out with Windows line
 *      endings hashes identically to the same file with Unix line endings;
 *   3. trailing spaces and tabs are stripped from every line, so a stray
 *      trailing-whitespace-only diff does not invalidate an anchor.
 * Nothing else is touched: indentation, blank lines and line count all stay
 * significant, because they are significant to the edit.
 */

const PRIME_1 = 0x9e3779b1;
const PRIME_2 = 0x85ebca77;
const PRIME_3 = 0xc2b2ae3d;
const PRIME_5 = 0x165667b1;

const BOM_CODE_POINT = 0xfeff;

const encoder = new TextEncoder();

/** Rotate a 32-bit value left, keeping the result unsigned. */
function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** Read four bytes starting at `offset` as a little-endian uint32. */
function readUint32(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset] + bytes[offset + 1] * 0x100;
  const high = bytes[offset + 2] + bytes[offset + 3] * 0x100;
  return (low + high * 0x10000) >>> 0;
}

/** One 16-byte XXH32 accumulator round. */
function accumulate(accumulator: number, input: number): number {
  const mixed = (accumulator + Math.imul(input, PRIME_2)) >>> 0;
  return Math.imul(rotateLeft(mixed, 13), PRIME_1) >>> 0;
}

/** XXH32 with an explicit seed, returned as an unsigned 32-bit integer. */
function xxh32(bytes: Uint8Array, seed: number): number {
  const length = bytes.length;
  let offset = 0;
  let hash: number;

  if (length >= 16) {
    let lane1 = (seed + PRIME_1 + PRIME_2) >>> 0;
    let lane2 = (seed + PRIME_2) >>> 0;
    let lane3 = seed >>> 0;
    let lane4 = (seed - PRIME_1) >>> 0;
    const limit = length - 16;
    do {
      lane1 = accumulate(lane1, readUint32(bytes, offset));
      lane2 = accumulate(lane2, readUint32(bytes, offset + 4));
      lane3 = accumulate(lane3, readUint32(bytes, offset + 8));
      lane4 = accumulate(lane4, readUint32(bytes, offset + 12));
      offset += 16;
    } while (offset <= limit);
    const merged =
      rotateLeft(lane1, 1) +
      rotateLeft(lane2, 7) +
      rotateLeft(lane3, 12) +
      rotateLeft(lane4, 18);
    hash = merged >>> 0;
  } else {
    hash = (seed + PRIME_5) >>> 0;
  }

  hash = (hash + length) >>> 0;

  while (offset + 4 <= length) {
    hash = (hash + Math.imul(readUint32(bytes, offset), PRIME_1)) >>> 0;
    hash = Math.imul(rotateLeft(hash, 17), PRIME_2) >>> 0;
    offset += 4;
  }

  while (offset < length) {
    hash = (hash + Math.imul(bytes[offset], PRIME_5)) >>> 0;
    hash = Math.imul(rotateLeft(hash, 11), PRIME_1) >>> 0;
    offset += 1;
  }

  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash, PRIME_2) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, PRIME_3) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash >>> 0;
}

/** Apply the normalisation documented at the top of this file. */
function normalizeForHash(content: string): string {
  const withoutBom =
    content.charCodeAt(0) === BOM_CODE_POINT ? content.slice(1) : content;
  const lf = withoutBom.includes('\r')
    ? withoutBom.replace(/\r\n?/g, '\n')
    : withoutBom;
  if (!lf.includes(' ') && !lf.includes('\t')) {
    return lf;
  }
  const trimmed: string[] = [];
  for (const line of lf.split('\n')) {
    trimmed.push(line.replace(/[ \t]+$/, ''));
  }
  return trimmed.join('\n');
}

/**
 * Mint the four-uppercase-hex tag for `content`.
 *
 * The same bytes always produce the same tag; changing, adding, removing or
 * reindenting even one line produces a different one, which is exactly the
 * signal the applier uses to reject a stale edit.
 */
export function fileHash(content: string): string {
  const digest = xxh32(encoder.encode(normalizeForHash(content)), 0);
  return ((digest & 0xffff) >>> 0).toString(16).toUpperCase().padStart(4, '0');
}
