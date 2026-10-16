/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, redactText, restoreTokens } from './redact.js';

/** The placeholder shape `redactSecrets` emits. */
const PLACEHOLDER = /__gemini_secret_\d+__/;

describe('redactText', () => {
  it('redacts provider tokens and whole PEM blocks', () => {
    expect(redactText('ghp_1234567890abcdefghijklmnopqrstuvwxyz')).toMatch(
      PLACEHOLDER,
    );
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toMatch(PLACEHOLDER);
    const pem = redactText(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----',
    );
    expect(pem).toMatch(PLACEHOLDER);
    expect(pem).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('redacts JWTs and passwords embedded in URLs', () => {
    expect(
      redactText(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL9PlFU',
      ),
    ).toMatch(PLACEHOLDER);
    expect(
      redactText('postgres://admin:s3cr3tpassword@db.internal:5432/prod'),
    ).toBe('postgres://admin:__gemini_secret_1__@db.internal:5432/prod');
  });

  it('redacts the value of an assignment, spacing and quotes included', () => {
    expect(redactText('password=hunter2000hunter')).toBe(
      'password=__gemini_secret_1__',
    );
    expect(redactText('password = hunter2000hunter')).toBe(
      'password = __gemini_secret_1__',
    );
    expect(redactText('client_secret: "abcdefghijklmnop"')).toBe(
      'client_secret: "__gemini_secret_1__"',
    );
    // The keyword can sit at the end of a longer identifier, which is how
    // every cloud credential file writes it.
    expect(
      redactText(
        'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      ),
    ).toBe('aws_secret_access_key = __gemini_secret_1__');
    expect(redactText('db_password = hunter2000hunter')).toBe(
      'db_password = __gemini_secret_1__',
    );
  });

  it('redacts a credential that follows its keyword with only whitespace', () => {
    // The .netrc / .pgpass shape.
    expect(
      redactText(
        'machine api.example.com login scout password hunter2000hunter',
      ),
    ).toBe('machine api.example.com login scout password __gemini_secret_1__');
  });

  it('leaves ordinary identifiers, prose and short values alone', () => {
    for (const text of [
      'monkey = 3',
      'keynote = false',
      'password authentication failed for user "scout"',
      'Host github.com\n  HostName github.com\n  User git\n',
      'const tokenCount = 12;',
      'key = value',
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it('treats caller-supplied environment values as secret everywhere', () => {
    const secret = 'env-only-secret-value';
    expect(redactText(`using ${secret} now`, { envValues: [secret] })).toBe(
      'using __gemini_secret_1__ now',
    );
  });

  it('round-trips through restoreTokens', () => {
    const input = 'token=hunter2000hunter and ghp_1234567890abcdefghijklmnop';
    const { text, tokens } = redactSecrets(input);
    expect(text).not.toContain('hunter2000hunter');
    expect(restoreTokens(text, tokens)).toBe(input);
  });
});
