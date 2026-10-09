/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { isValidSshProfileName } from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';

/** One collected answer. Unanswered secrets are `undefined`, never ''. */
export interface SshAddAnswers {
  name: string;
  host: string;
  user: string;
  port: number;
  identityFile?: string;
  password?: string;
  sudoPassword?: string;
}

export interface SshAddDialogProps {
  /** Prefills an existing profile when `/ssh-add <name>` names one. */
  initial?: Record<string, string>;
  /** Names already taken, so the wizard can refuse a collision inline. */
  existingNames: readonly string[];
  /** Called with the answers, or null when the operator cancels. */
  onSubmit: (answers: SshAddAnswers | null) => void;
}

interface Field {
  key: keyof SshAddAnswers;
  label: string;
  hint: string;
  /** Secret fields render as dots and are never echoed. */
  secret?: boolean;
  required: boolean;
  initial?: string;
}

const FIELDS: readonly Field[] = [
  {
    key: 'name',
    label: 'Profile name',
    hint: 'letters, digits, dot, dash, underscore',
    required: true,
  },
  {
    key: 'host',
    label: 'Host or IP',
    hint: '',
    required: true,
  },
  { key: 'user', label: 'SSH user', hint: '', required: true },
  {
    key: 'port',
    label: 'Port',
    hint: '22',
    required: true,
    initial: '22',
  },
  {
    key: 'identityFile',
    label: 'Private key path',
    hint: 'blank for password or ssh-agent',
    required: false,
  },
  {
    key: 'password',
    label: 'SSH password',
    hint: 'blank to keep the stored one; stored in your OS keychain',
    secret: true,
    required: false,
  },
  {
    key: 'sudoPassword',
    label: 'sudo password',
    hint: 'blank forbids sudo for the agent on this host',
    secret: true,
    required: false,
  },
];

/**
 * The `/ssh-add` wizard.
 *
 * Rendered as an Ink dialog rather than a `prompts` session: `prompts` puts
 * the terminal in raw mode and writes straight to stdout, which fights the
 * TUI's own renderer and deadlocks the CLI the moment the command is invoked.
 */
export const SshAddDialog: React.FC<SshAddDialogProps> = ({
  initial,
  existingNames,
  onSubmit,
}) => {
  const [index, setIndex] = useState(0);
  // Prefill is string-valued because that is what the text field holds; the
  // numeric port arrives as its string form and is parsed on submit.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      FIELDS.map((field) => [
        field.key,
        initial?.[field.key] ?? field.initial ?? '',
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  // Keypresses arrive faster than React re-renders, so the handler must not
  // read the values captured by the render that created it. These refs hold
  // the authoritative current state and are updated synchronously, which is
  // what stops every character after the first from being dropped.
  const valuesRef = useRef(values);
  const indexRef = useRef(index);
  useEffect(() => {
    valuesRef.current = values;
    indexRef.current = index;
  }, [values, index]);

  const write = (next: Record<string, string>, nextIndex: number) => {
    valuesRef.current = next;
    indexRef.current = nextIndex;
    setValues(next);
    setIndex(nextIndex);
  };

  const field = FIELDS[index];
  const value = values[field.key] ?? '';

  const advance = (nextValues: Record<string, string>) => {
    if (indexRef.current < FIELDS.length - 1) {
      write(nextValues, indexRef.current + 1);
      setError(null);
      return;
    }
    submit(nextValues);
  };

  const submit = (final: Record<string, string>) => {
    const name = (final['name'] ?? '').trim();
    const port = Number.parseInt(final['port'] ?? '', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Port must be a number from 1 to 65535.');
      return;
    }
    for (const required of FIELDS.filter((f) => f.required)) {
      if (!(final[required.key] ?? '').trim()) {
        setError(`${required.label} is required.`);
        return;
      }
    }

    const trimmed = (key: string) => (final[key] ?? '').trim();
    onSubmit({
      name,
      host: trimmed('host'),
      user: trimmed('user'),
      port,
      ...(trimmed('identityFile')
        ? { identityFile: trimmed('identityFile') }
        : {}),
      // `undefined` means "leave the stored secret alone"; an empty string
      // means "delete it". The distinction is the whole reason the wizard
      // pre-fills nothing but reports undefined rather than ''.
      ...(final['password'] === undefined || final['password'] === ''
        ? {}
        : { password: final['password'] }),
      ...(final['sudoPassword'] === undefined || final['sudoPassword'] === ''
        ? {}
        : { sudoPassword: final['sudoPassword'] }),
    });
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSubmit(null);
        return;
      }
      const currentField = FIELDS[indexRef.current];
      const current = valuesRef.current[currentField.key] ?? '';

      // This fork normalizes the return key to 'enter', not ink's 'return', and
      // rewrites a return pressed within FAST_RETURN_TIMEOUT of a typed
      // character into shift+enter, so that unbracketed pastes survive. Those
      // fields are single-line and a newline is meaningless here, so both
      // variants advance: otherwise typing a value and immediately hitting
      // Enter silently does nothing.
      if (key.name === 'enter') {
        const trimmed = current.trim();
        // Validate as the operator leaves the field, so a name that cannot
        // work is caught before they type a password, not after.
        if (currentField.key === 'name') {
          if (!isValidSshProfileName(trimmed)) {
            setError('Use letters, digits, dot, dash or underscore (max 64).');
            return;
          }
          if (existingNames.includes(trimmed)) {
            setError(`A profile named "${trimmed}" already exists.`);
            return;
          }
        }
        if (currentField.required && trimmed === '') {
          setError(`${currentField.label} is required.`);
          return;
        }
        advance({ ...valuesRef.current, [currentField.key]: trimmed });
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        write(
          { ...valuesRef.current, [currentField.key]: current.slice(0, -1) },
          indexRef.current,
        );
        setError(null);
        return;
      }
      // `insertable` is this fork's own flag for "printable character"; the
      // key name is a terminal-dependent label and cannot be length-tested.
      if (!key.insertable || key.ctrl || key.alt || key.cmd) {
        return;
      }
      write(
        { ...valuesRef.current, [currentField.key]: current + key.sequence },
        indexRef.current,
      );
      setError(null);
    },
    { isActive: true },
  );

  const shown =
    field.secret && value.length > 0 ? '•'.repeat(value.length) : value;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color={theme.text.accent}>
        Add SSH server
      </Text>
      <Text dimColor>
        {index + 1}/{FIELDS.length} · {field.label}
        {field.required ? '' : ' (optional)'}
      </Text>
      {field.hint ? <Text dimColor>{field.hint}</Text> : null}
      <Box>
        <Text color={theme.text.primary}>{'> '}</Text>
        <Text color={theme.text.primary}>{shown}</Text>
        <Text color={theme.text.primary}>█</Text>
      </Box>
      {error ? <Text color={theme.status.error}>{error}</Text> : null}
      <Text dimColor>enter next · esc cancel</Text>
    </Box>
  );
};
