/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  deobfuscateSecrets,
  getSecretPlaceholderKey,
  obfuscateSecrets,
  type ObfuscateResult,
} from './obfuscator.js';

/**
 * The secret store: a file of values, and the `secret://name` references that
 * stand in for them.
 *
 * Ported from omp's `secrets/settings.ts`. Config files are readable by the
 * model, land in transcripts and get pasted into bug reports. Storing a
 * literal key in `settings.json` puts it in all three. Writing
 * `"apiKey": "secret://github"` instead puts only the NAME there; the value
 * lives in one file, mode 0600, and is substituted only where it is used.
 *
 * The value is still substituted into the text the model eventually sees, so
 * this is not a boundary against a determined reader of the transcript — it
 * is a boundary against a config file, a screen share, and a pasted snippet,
 * which is where keys actually leak.
 */

export const SECRET_FILE_NAME = 'secrets.json';

/** How a config value asks for a stored secret. */
const SECRET_REF = /^secret:\/\/([A-Za-z0-9_.-]+)$/;

/** Is this config value a reference rather than a literal? */
export function isSecretRef(value: string): boolean {
  return SECRET_REF.test(value);
}

/** The name a reference asks for, if it is a reference. */
export function secretRefName(value: string): string | undefined {
  const match = SECRET_REF.exec(value);
  return match === null ? undefined : match[1];
}

function isStringEntry(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) => typeof entry === 'string' || entry === undefined,
  );
}

export class SecretStore {
  private readonly file: string;
  private readonly key: string;
  private readonly secrets: Record<string, string>;

  private constructor(
    file: string,
    key: string,
    secrets: Record<string, string>,
  ) {
    this.file = file;
    this.key = key;
    this.secrets = secrets;
  }

  /**
   * Load the store, creating an empty one if absent.
   *
   * The key is minted even when there are no secrets, so a placeholder
   * generated later in the session is the same one next session.
   */
  static load(globalDir: string): SecretStore {
    const file = path.join(globalDir, SECRET_FILE_NAME);
    const key = getSecretPlaceholderKey(globalDir);
    let secrets: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isStringEntry(parsed)) {
        secrets = parsed;
      }
    } catch {
      // Absent or unparseable. An empty store is the safe reading: it cannot
      // silently substitute the wrong value for a reference.
    }
    return new SecretStore(file, key, secrets);
  }

  /** The stored name -> value pairs. */
  entries(): Record<string, string> {
    return { ...this.secrets };
  }

  /** One stored value, if present. */
  get(name: string): string | undefined {
    return this.secrets[name];
  }

  /** Store a value, creating the file at 0600 on first write. */
  set(name: string, value: string): void {
    this.secrets[name] = value;
    this.persist();
  }

  /** Forget a stored value. Returns whether there was one. */
  delete(name: string): boolean {
    if (!(name in this.secrets)) return false;
    delete this.secrets[name];
    this.persist();
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 0600: this file is the one place the literal values exist.
    fs.writeFileSync(this.file, `${JSON.stringify(this.secrets, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /**
   * Resolve a config value.
   *
   * A literal is returned unchanged. A reference to a missing name is an
   * error rather than a pass-through: returning the reference string would
   * send `secret://github` to an API as if it were a key, which fails
   * confusingly at the far end instead of here.
   */
  resolve(value: string): string {
    const name = secretRefName(value);
    if (name === undefined) return value;
    const resolved = this.secrets[name];
    if (resolved === undefined) {
      throw new Error(
        `Secret "${name}" is referenced but not set. ` +
          `Add it to ${this.file}, or run: gemini secrets set ${name}`,
      );
    }
    return resolved;
  }

  /** {@link resolve}, or the original value when the reference is unset. */
  resolveOrPassThrough(value: string): string {
    try {
      return this.resolve(value);
    } catch {
      return value;
    }
  }

  /**
   * Walk a config object, replacing every `secret://name` with its value.
   *
   * Keys as well as values: a settings file keyed by environment variable
   * name is a normal shape, and `{"secret://gh": "secret://gh"}` should still
   * end up with the real name.
   */
  resolveConfig(config: unknown): unknown {
    return this.walk(config);
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.resolveOrPassThrough(value);
    if (Array.isArray(value)) return value.map((entry) => this.walk(entry));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[this.resolveOrPassThrough(key)] = this.walk(entry);
      }
      return out;
    }
    return value;
  }

  /** Obfuscate every stored secret out of `text`. */
  obfuscate(text: string): ObfuscateResult {
    return obfuscateSecrets(text, this.secrets, this.key);
  }

  /** Put obfuscated placeholders back, using this store's key. */
  deobfuscate(text: string, map: Record<string, string>): string {
    return deobfuscateSecrets(text, map, this.key, this.secrets);
  }

  /** The per-install key backing placeholders for this store. */
  placeholderKey(): string {
    return this.key;
  }
}
