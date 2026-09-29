/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  redactText,
  scanPlaceholders,
  type ChatRecordingService,
  type MessageRecord,
} from '@google/gemini-cli-core';

/**
 * `/share` — hand someone this conversation.
 *
 * Ported from omp's `/share`. omp's version posts the session to a hosted
 * share server; that is infrastructure rather than a feature, and standing up
 * a service is out of scope here. What is portable, and what the feature is
 * actually for, is the part that does not need a server: produce one file the
 * recipient can open, with the parts that must not travel left out.
 *
 * Two things make a shared transcript safe to hand over, and both are opt-in
 * rather than assumed, because guessing wrong either way is bad:
 *
 *  - **Redaction.** A transcript can contain a key the agent read out of a
 *    config file. `redact: true` is the default; turning it off is a
 *    deliberate act, not the easy path.
 *  - **Encryption.** A shared file is a file that gets emailed. With
 *    `encrypt: true` the payload is sealed with a passphrase, and the
 *    passphrase is never written into the file.
 */

export interface ShareOptions {
  /** Replace credential-shaped text with a placeholder. Default `true`. */
  redact?: boolean;
  /** Seal the body with a passphrase. Default `true`. */
  encrypt?: boolean;
  /** Where to write. Default: a timestamped file in the project temp dir. */
  outFile?: string;
}

export interface ShareResult {
  path: string;
  /** Whether the body was sealed. */
  encrypted: boolean;
  /** Whether credential-shaped text was replaced. */
  redacted: boolean;
  /** How many placeholders the redaction introduced. */
  redactedCount: number;
  byteSize: number;
  /** How to read it back, for the message shown to the user. */
  readBack: string;
}

const FILE_PREFIX = 'shared-session-';

/** AAD binding the ciphertext to this format, so it cannot be swapped. */
const AAD = Buffer.from('gemini-shared-session:v1', 'utf8');

/**
 * The transcript as markdown, for a human to read.
 *
 * Tool calls are summarised rather than dumped: a transcript of a real
 * session is mostly `grep` output, and a reader wants the reasoning and the
 * conclusions, not forty screens of search results.
 */
function textOf(content: MessageRecord['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null && 'text' in part) {
        return String(part.text ?? '');
      }
      return '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

function transcriptMarkdown(service: ChatRecordingService): string {
  const conversation = service.getConversation();
  if (conversation === null)
    return '# Shared Gemini CLI session\n\n(no messages)';
  const parts: string[] = ['# Shared Gemini CLI session', ''];
  if (conversation.summary !== undefined && conversation.summary !== '') {
    parts.push(`> ${conversation.summary}`, '');
  }
  for (const message of conversation.messages) {
    if (message.type === 'gemini') {
      const text = textOf(message.content);
      if (text.trim() === '') continue;
      parts.push('## Gemini', '', text, '');
      continue;
    }
    if (message.type === 'user') {
      const text = textOf(message.content);
      if (text.trim() === '') continue;
      parts.push('## You', '', text, '');
      continue;
    }
  }
  return parts.join('\n');
}

/** Derive a key from a passphrase, with a salt so two files differ. */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 200_000, 32, 'sha256');
}

export async function shareSession(
  service: ChatRecordingService,
  passphrase: string | undefined,
  options: ShareOptions = {},
): Promise<ShareResult> {
  const redact = options.redact ?? true;
  const encrypt = options.encrypt ?? true;

  if (encrypt && (passphrase === undefined || passphrase === '')) {
    throw new Error(
      'Sharing encrypts by default, so a passphrase is required. Pass one, ' +
        'or ask for an unencrypted share if you understand the risk.',
    );
  }

  let body = transcriptMarkdown(service);
  let redactedCount = 0;
  if (redact) {
    // The same credential-shaped matcher used for memory writes, so a shared
    // transcript is scrubbed the way a stored memory is.
    body = redactText(body);
    redactedCount = scanPlaceholders(body).length;
  }

  const envelope: Record<string, unknown> = {
    version: 1,
    kind: 'gemini-shared-session',
    createdAt: new Date().toISOString(),
    redacted: redact,
  };

  if (encrypt) {
    // Narrowed once, after the guard above: a missing passphrase is an error
    // here, not a silent unencrypted write further down.
    const secret = passphrase ?? '';
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      deriveKey(secret, salt),
      iv,
    );
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(body, 'utf8'),
      cipher.final(),
    ]);
    envelope['encrypted'] = true;
    envelope['salt'] = salt.toString('base64');
    envelope['iv'] = iv.toString('base64');
    envelope['tag'] = cipher.getAuthTag().toString('base64');
    envelope['body'] = ciphertext.toString('base64');
  } else {
    envelope['encrypted'] = false;
    envelope['body'] = body;
  }

  const serialised = `${JSON.stringify(envelope, null, 2)}\n`;
  const sessionPath = service.getConversationFilePath();
  const dir =
    options.outFile !== undefined
      ? path.dirname(options.outFile)
      : sessionPath !== null && sessionPath !== ''
        ? path.dirname(sessionPath)
        : process.cwd();
  const file =
    options.outFile ??
    path.join(
      dir,
      `${FILE_PREFIX}${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.json`,
    );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialised, { encoding: 'utf8', mode: 0o600 });

  return {
    path: file,
    encrypted: encrypt,
    redacted: redact,
    redactedCount,
    byteSize: Buffer.byteLength(serialised),
    readBack: encrypt
      ? `gemini share --read ${file} --passphrase <passphrase>`
      : `gemini share --read ${file}`,
  };
}
