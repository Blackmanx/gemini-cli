/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { initializeOutputListenersAndFlush } from '../gemini.js';
import { loadSettings } from '../config/settings.js';
import { getSettingsSchema } from '../config/settingsSchema.js';
import { Storage } from '@google/gemini-cli-core';

/**
 * `gemini config` — read and write settings without hand-editing JSON.
 *
 * Ported from omp's `omp config list|get|set|reset|path`. The TUI dialog is
 * fine for a human at a terminal, but a script, a CI job, or an agent editing
 * its own configuration has no way to use it. This gives those a stable,
 * greppable surface.
 *
 * Every value is echoed back after a write. A settings command that fails
 * silently is worse than none, because the caller then has to guess whether
 * it worked.
 */

type Layer = 'user' | 'workspace';

/** Narrow parsed JSON to a plain object, without asserting its shape. */
function isLayer(value: unknown): value is Layer {
  return value === 'user' || value === 'workspace';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow a yargs `layer` option to the two real layers. */
function layerOf(value: unknown): Layer {
  return isLayer(value) ? value : 'user';
}

/**
 * The settings file for a layer.
 *
 * Resolved through the same `Storage` the settings loader uses, so this can
 * never disagree with where the settings actually come from.
 */
function settingsFileFor(layer: Layer): string {
  const storage = new Storage(process.cwd());
  return layer === 'user'
    ? Storage.getGlobalSettingsPath()
    : storage.getWorkspaceSettingsPath();
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonFile(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Read a dotted key path, e.g. `tools.useRipgrep`. */
function getPath(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const segment of dotted.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Write a dotted key path, creating intermediate objects. */
function setPath(
  root: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const segments = dotted.split('.');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!isPlainObject(existing)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    current = existing;
  }
  current[segments[segments.length - 1]] = value;
}

function deletePath(root: Record<string, unknown>, dotted: string): boolean {
  const segments = dotted.split('.');
  let current: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) return false;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, last)) return false;
  delete current[last];
  return true;
}

/** Coerce a CLI string into the type the schema declares for that key. */
function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      // Not JSON after all: fall through and keep it a string.
    }
  }
  return raw;
}

/** Render a settings value; structured values go through JSON. */
function renderValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (value === null || typeof value !== 'object') return String(value);
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/**
 * Every setting key, flattened to dotted paths.
 *
 * Walks the schema returned by `getSettingsSchema()` — the real settings
 * tree. The sibling export
 * `SETTINGS_SCHEMA_DEFINITIONS` is the shared `$defs` map (type references
 * like `MCPServerConfig`), and walking that reports interface field names as
 * if they were settings.
 *
 * A node with a `properties` map is a group and is descended into; anything
 * else with a `type` is a leaf. A `ref` is a type reference, so it is a leaf
 * however object-shaped it looks.
 */
function schemaKeys(): string[] {
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (!isPlainObject(node)) return;
    if ('ref' in node) return;
    const properties = node['properties'];
    if (isPlainObject(properties)) {
      for (const [key, value] of Object.entries(properties)) {
        walk(value, prefix === '' ? key : `${prefix}.${key}`);
      }
      return;
    }
    if ('type' in node && prefix !== '') out.push(prefix);
  };
  for (const [key, value] of Object.entries(getSettingsSchema())) {
    walk(value, key);
  }
  return out;
}

const configCommand: CommandModule = {
  command: 'config',
  describe: 'Read and write settings',
  builder: (yargs: Argv) =>
    yargs
      .middleware((argv) => {
        initializeOutputListenersAndFlush();
        argv['isCommand'] = true;
      })
      .command(
        'list',
        'List every known setting and its current value',
        (yargs: Argv) =>
          yargs
            .option('layer', {
              type: 'string',
              choices: ['user', 'workspace'],
              default: 'user',
            })
            .option('json', { type: 'boolean', default: false }),
        (argv) => {
          const file = settingsFileFor(layerOf(argv['layer']));
          const raw = readJsonFile(file);
          const effective = loadSettings(process.cwd()).merged;
          if (argv['json']) {
            process.stdout.write(`${JSON.stringify(raw, null, 2)}\n`);
            return;
          }
          const lines = schemaKeys().map((key) => {
            const set = getPath(raw, key);
            const now = getPath(effective, key);
            // Objects and arrays must not go through String(): that yields
            // "[object Object]", which tells the caller nothing.
            const shown = renderValue(set === undefined ? now : set);
            const source = set === undefined ? '(default)' : 'set';
            return `${key} = ${shown}  [${source}]`;
          });
          process.stdout.write(`${lines.join('\n')}\n`);
        },
      )
      .command(
        'get <key>',
        'Print one setting and where it comes from',
        (yargs: Argv) =>
          yargs.positional('key', { type: 'string', demandOption: true }),
        (argv) => {
          const key = String(argv['key']);
          const user = getPath(readJsonFile(settingsFileFor('user')), key);
          const workspace = getPath(
            readJsonFile(settingsFileFor('workspace')),
            key,
          );
          const effective = getPath(loadSettings(process.cwd()).merged, key);
          if (user === undefined && workspace === undefined) {
            process.stdout.write(
              `${key} = ${JSON.stringify(effective)}  [default]\n`,
            );
            return;
          }
          const source = workspace !== undefined ? 'workspace' : 'user';
          const value = workspace !== undefined ? workspace : user;
          process.stdout.write(
            `${key} = ${JSON.stringify(value)}  [${source}]\n`,
          );
        },
      )
      .command(
        'set <key> <value>',
        'Set one setting',
        (yargs: Argv) =>
          yargs
            .positional('key', { type: 'string', demandOption: true })
            .positional('value', { type: 'string', demandOption: true })
            .option('layer', {
              type: 'string',
              choices: ['user', 'workspace'],
              default: 'user',
            }),
        (argv) => {
          const key = String(argv['key']);
          const file = settingsFileFor(layerOf(argv['layer']));
          const raw = readJsonFile(file);
          setPath(raw, key, coerce(String(argv['value'])));
          writeJsonFile(file, raw);
          // Echo it back: a write that cannot be confirmed is not a write.
          process.stdout.write(
            `${key} = ${JSON.stringify(getPath(raw, key))} -> ${file}\n`,
          );
        },
      )
      .command(
        'reset <key>',
        'Remove one setting, returning it to its default',
        (yargs: Argv) =>
          yargs
            .positional('key', { type: 'string', demandOption: true })
            .option('layer', {
              type: 'string',
              choices: ['user', 'workspace'],
              default: 'user',
            }),
        (argv) => {
          const key = String(argv['key']);
          const file = settingsFileFor(layerOf(argv['layer']));
          const raw = readJsonFile(file);
          const removed = deletePath(raw, key);
          writeJsonFile(file, raw);
          process.stdout.write(
            removed
              ? `${key} removed from ${file}\n`
              : `${key} was not set in ${file}\n`,
          );
        },
      )
      .command('path', 'Print the settings file locations', {}, () => {
        process.stdout.write(`user      ${settingsFileFor('user')}\n`);
        process.stdout.write(`workspace ${settingsFileFor('workspace')}\n`);
      })
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};

export { configCommand };
