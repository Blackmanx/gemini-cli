/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardened store for *managed* skills — skills the model writes for itself from
 * what it learned in earlier tasks.
 *
 * A managed skill is an ordinary `SKILL.md` that lives in a directory this
 * module owns (`~/.gemini/managed-skills` by default), separate from the
 * user-authored skill directories. Once a managed skill is discovered it is
 * listed in the system prompt (`<available_skills>`) and read back in every
 * later session, which makes it a trust boundary rather than a scratch file:
 *
 * - The **name** becomes a path segment under the managed root, so it is
 *   restricted to a character allowlist that cannot escape the root.
 * - The **description** is machine-generated from prior task content and is
 *   interpolated into the system prompt, so it is stripped of anything that
 *   could terminate that prompt structure (`<`, `>`, backticks, `~~`).
 * - The **file system** is treated as hostile: symlinked roots, symlinked skill
 *   directories, symlinked `SKILL.md` files, non-regular files, and hard-linked
 *   files are all refused, so an auto-management pass can never write to (or
 *   delete) something it did not create.
 *
 * Every check below exists for one of those three reasons; the comments say
 * which.
 */
import { constants as fsConstants, type Stats } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dump } from 'js-yaml';
import { Storage } from '../config/storage.js';
import { isNodeError } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import { FRONTMATTER_REGEX, parseFrontmatter } from './skillLoader.js';

/** File name every managed skill uses; matches the discovery glob in `skillLoader.ts`. */
export const MANAGED_SKILL_FILENAME = 'SKILL.md';

/**
 * Hard cap on a managed `SKILL.md` file. Generated skills come from model
 * output, so an unbounded body would let one bad generation blow past the
 * context window in every future session that lists or activates it.
 */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

/**
 * The complete set of legal managed-skill names.
 *
 * Anchored at both ends and single-line, so `..`, `/`, `\`, `.`, whitespace and
 * shell metacharacters can never appear in a path segment composed from it. The
 * leading class excludes `-`, which also rules out the option-like `-rf` and
 * keeps the name usable as a directory name on every supported platform.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Resolves the managed-skills directory the CLI uses by default
 * (`~/.gemini/managed-skills`). Callers that own a different root (a sandbox,
 * a test, a per-project store) pass their own root to the functions below
 * instead; this is only the default wiring point.
 */
export function getManagedSkillsDir(
  agentDir: string = Storage.getGlobalGeminiDir(),
): string {
  return path.join(agentDir, 'managed-skills');
}

/**
 * Validates a managed-skill name and returns the exact on-disk directory name.
 * Throws on anything outside the allowlist so a caller can never compose a path
 * outside the managed root.
 *
 * Surrounding whitespace is trimmed (a stray space from model output is a
 * formatting slip, not an attempt to create a different path), but the case is
 * **not** normalized: `SkillManager` resolves skills case-insensitively
 * (`getSkill`, `setDisabledSkills` both lowercase before comparing), so
 * accepting `Foo` and `foo` would let two distinct directories claim the same
 * skill. Rejecting uppercase keeps one canonical name per skill.
 */
export function sanitizeSkillName(raw: string): string {
  const name = raw.trim();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid managed skill name "${raw}". Use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit (for example "release-notes").`,
    );
  }
  return name;
}

/**
 * Whether `name` is already in the exact post-`sanitizeSkillName` shape. Used
 * on values read back from disk: a managed `SKILL.md` that was hand-placed or
 * hand-edited must not be surfaced under a name that would escape the managed
 * root or collide case-insensitively with another skill.
 */
export function isValidManagedSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralizes a machine-generated managed-skill description.
 *
 * Managed descriptions are derived from prior task content and are read back in
 * every later session, where they land verbatim inside the `<description>` of a
 * `<skill>` element in the system prompt. A description containing `</skill>`
 * — or, on the render side, an unescaped `<`/`>` — would let generated text
 * close the prompt structure and pose as system content. So: drop control and
 * format characters (which can also hide text from a reviewer), drop the
 * characters that delimit the prompt structure and Markdown code fences,
 * collapse runs of `~` or `` ` `` to a single character, and fold everything
 * onto one line. Applied on **write and on read** — the read side is what makes
 * already-persisted files safe, including ones written by an older build.
 */
export function sanitizeManagedDescription(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>`]/g, '')
    .replace(/~{2,}/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A managed skill as stored on disk, after sanitization. */
export interface ManagedSkill {
  /** Directory name under the managed root; always matches {@link isValidManagedSkillName}. */
  name: string;
  /** Single-line, prompt-injection-safe description. */
  description: string;
  /** Markdown body with the frontmatter block removed. */
  body: string;
}

/** Whether a write must create a new skill or replace an existing one. */
export type ManagedSkillWriteAction = 'create' | 'update';

/**
 * Resolves the file a managed skill occupies. Every path in this module is
 * built here so there is exactly one place where a name becomes a path.
 */
export function getManagedSkillPath(root: string, name: string): string {
  return path.join(root, sanitizeSkillName(name), MANAGED_SKILL_FILENAME);
}

/**
 * Serializes the frontmatter block. `lineWidth: -1` disables line folding: the
 * description must survive the round trip through `parseFrontmatter` as the
 * same single line the sanitizer produced, and a folded plain scalar is one
 * whitespace change away from re-reading as different text.
 */
function toSkillFrontmatter(name: string, description: string): string {
  const frontmatter = dump(
    { name, description },
    { lineWidth: -1, noRefs: true },
  ).trimEnd();
  return `---\n${frontmatter}\n---\n`;
}

/**
 * `lstat` a path, mapping "does not exist" to `null` and rethrowing anything
 * else. `lstat` (not `stat`) is deliberate: it does not follow the final
 * component, so a symlink is observed as a symlink.
 */
function lstatOrNull(target: string): Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Reject a symlinked managed root. Every child path is composed as
 * `<root>/<name>`, and path resolution follows intermediate components — so a
 * symlinked root would redirect every write and delete to an arbitrary tree
 * (for instance onto the user's authored skills) while still looking like a
 * successful managed-skill operation. Checked before any child path is built.
 */
function assertManagedRootSafe(root: string): void {
  const rootStat = lstatOrNull(root);
  if (rootStat?.isSymbolicLink()) {
    throw new Error(
      `The managed-skills root "${root}" is a symlink; refusing to operate outside the managed directory.`,
    );
  }
  if (rootStat !== null && !rootStat.isDirectory()) {
    throw new Error(
      `The managed-skills root "${root}" is not a directory; refusing to write managed skills there.`,
    );
  }
}

/**
 * Reject when the skill's own directory is a symlink. `lstat` on a child
 * follows the intermediate components, so only this explicit check stops
 * `root/evil -> /somewhere/else` from turning a legal name into an illegal
 * write. This is an intermediate path component, which is exactly the case
 * `O_NOFOLLOW` does not cover.
 */
function assertSkillDirSafeForWrite(name: string, dir: string): void {
  const dirStat = lstatOrNull(dir);
  if (dirStat?.isSymbolicLink()) {
    throw new Error(
      `Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
    );
  }
  if (dirStat !== null && !dirStat.isDirectory()) {
    throw new Error(
      `Managed skill directory "${dir}" is not a directory; refusing to overwrite it.`,
    );
  }
}

/**
 * A managed `SKILL.md` must be a plain single-linked file. A hard link
 * (`nlink > 1`) means the same inode is reachable from a path this module does
 * not own, so a "managed skill" write would silently modify a user-authored
 * file elsewhere; a non-regular file (FIFO, device, socket) would make the
 * truncate+write below block forever or write to a driver.
 */
function assertManagedSkillFileSafeForUpdate(
  name: string,
  fileStat: Stats,
): void {
  if (!fileStat.isFile()) {
    throw new Error(
      `Managed skill "${name}" ${MANAGED_SKILL_FILENAME} is not a regular file; refusing to overwrite it.`,
    );
  }
  if (fileStat.nlink > 1) {
    throw new Error(
      `Managed skill "${name}" ${MANAGED_SKILL_FILENAME} has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
    );
  }
}

/**
 * Build the file content and enforce every content invariant that does not
 * need the file system, so an oversized or empty skill is rejected before any
 * directory is created.
 */
function buildManagedSkillContent(
  name: string,
  description: string,
  body: string,
): string {
  const safeDescription = sanitizeManagedDescription(description);
  const safeBody = body.trim();
  // An all-whitespace description sanitizes to "" and an all-whitespace body
  // to "". Both would be written and then silently dropped by discovery (which
  // requires a non-empty description), so the tool would report success for a
  // skill that never appears. Refuse instead.
  if (!safeDescription) {
    throw new Error(
      `Managed skill "${name}" needs a non-empty description (it must survive sanitization).`,
    );
  }
  if (!safeBody) {
    throw new Error(`Managed skill "${name}" needs a non-empty body.`);
  }
  const content = `${toSkillFrontmatter(name, safeDescription)}\n${safeBody}\n`;
  // Cap the UTF-8 byte size of the FINAL file (frontmatter + body), not the
  // UTF-16 length of the body: a description and non-ASCII body both inflate
  // the bytes on disk relative to the code-unit count the model produced.
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_MANAGED_SKILL_BYTES) {
    throw new Error(
      `Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or the description.`,
    );
  }
  return content;
}

/**
 * Create or replace a managed `SKILL.md` under `root`.
 *
 * Mutations are synchronous end to end. That is a hardening property, not a
 * limitation: there is no `await` between the `lstat` checks, the open and the
 * write, so two mutations of the same skill can never interleave the way two
 * concurrent `fs/promises` calls in one tool batch can.
 *
 * `action` defaults to `'create'`, the non-destructive branch: omitting it can
 * never clobber an existing file.
 *
 * @throws Error with a human-readable reason for every refusal (bad name,
 * symlinked root/dir/file, non-regular or hard-linked file, missing file on
 * update, existing file on create, empty or oversized content).
 */
export function writeManagedSkill(
  root: string,
  skill: ManagedSkill,
  action: ManagedSkillWriteAction = 'create',
): void {
  const name = sanitizeSkillName(skill.name);
  const content = buildManagedSkillContent(name, skill.description, skill.body);

  assertManagedRootSafe(root);
  const dir = path.join(root, name);
  const file = path.join(dir, MANAGED_SKILL_FILENAME);
  assertSkillDirSafeForWrite(name, dir);

  if (action === 'create') {
    fs.mkdirSync(dir, { recursive: true });
    try {
      // `wx` == O_CREAT | O_EXCL | O_WRONLY. Exclusive create is atomic: it
      // closes the check-then-write window in which a parallel create could
      // both observe "missing" and write, and it fails on an existing
      // `SKILL.md` — including one that is a symlink, which would otherwise be
      // followed and written through.
      fs.writeFileSync(file, content, { flag: 'wx' });
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new Error(
          `Managed skill "${name}" already exists. Use action "update" to change it.`,
        );
      }
      throw error;
    }
    return;
  }

  const fileStat = lstatOrNull(file);
  if (fileStat === null) {
    throw new Error(
      `Managed skill "${name}" does not exist. Use action "create" to add it.`,
    );
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(
      `Managed skill "${name}" ${MANAGED_SKILL_FILENAME} is a symlink; refusing to overwrite it.`,
    );
  }
  assertManagedSkillFileSafeForUpdate(name, fileStat);

  // `O_NOFOLLOW` closes the window between the `lstat` above and the write: if
  // the path were swapped for a symlink in between, the open fails with ELOOP
  // instead of writing through it. Re-check the type and link count on the open
  // descriptor, which is the object actually written, not the path.
  let fd: number;
  try {
    fd = fs.openSync(file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new Error(
        `Managed skill "${name}" ${MANAGED_SKILL_FILENAME} is a symlink; refusing to overwrite it.`,
      );
    }
    throw error;
  }
  try {
    assertManagedSkillFileSafeForUpdate(name, fs.fstatSync(fd));
    fs.ftruncateSync(fd, 0);
    // Writing through the descriptor also avoids a second path resolution.
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove a managed skill directory. Returns `false` when there was nothing to
 * remove (the caller decides whether that is an error). Still throws when the
 * directory exists but is a symlink, because deleting it would remove the
 * target's contents instead.
 */
export function deleteManagedSkill(root: string, name: string): boolean {
  const safe = sanitizeSkillName(name);
  assertManagedRootSafe(root);
  const dir = path.join(root, safe);
  if (lstatOrNull(dir) === null) {
    return false;
  }
  const dirStat = fs.lstatSync(dir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(
      `Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`,
    );
  }
  fs.rmSync(dir, { recursive: true });
  return true;
}

/**
 * Read one managed skill back. The description is re-sanitized on the way out:
 * a file on disk may predate this sanitizer, or may have been edited by hand or
 * by another program, and the discovery path renders whatever it returns
 * straight into the system prompt.
 *
 * Returns `undefined` for anything that is not a well-formed managed skill —
 * missing, symlinked, non-regular, frontmatter absent, an unsafe or mismatched
 * frontmatter name, or an empty description/body. Discovery keys skills by
 * name, so a file whose `frontmatter.name` disagrees with its directory would
 * register under an identity this module never approved.
 */
export function readManagedSkill(
  root: string,
  name: string,
): ManagedSkill | undefined {
  const safe = sanitizeSkillName(name);
  const file = path.join(root, safe, MANAGED_SKILL_FILENAME);
  const fileStat = lstatOrNull(file);
  if (fileStat === null) {
    return undefined;
  }
  if (fileStat.isSymbolicLink()) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": ${MANAGED_SKILL_FILENAME} is a symlink.`,
    );
    return undefined;
  }
  if (!fileStat.isFile()) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": ${MANAGED_SKILL_FILENAME} is not a regular file.`,
    );
    return undefined;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    debugLogger.debug(`Failed to read managed skill "${safe}":`, error);
    return undefined;
  }

  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": no frontmatter block.`,
    );
    return undefined;
  }
  const frontmatter = parseFrontmatter(match[1]);
  if (!frontmatter) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": unparseable frontmatter.`,
    );
    return undefined;
  }
  if (frontmatter.name !== safe) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": frontmatter name "${frontmatter.name}" does not match its directory.`,
    );
    return undefined;
  }

  const description = sanitizeManagedDescription(frontmatter.description);
  const body = match[2]?.trim() ?? '';
  if (!description || !body) {
    debugLogger.debug(
      `Skipping managed skill "${safe}": empty description or body after sanitization.`,
    );
    return undefined;
  }

  return { name: safe, description, body };
}

/**
 * Every well-formed managed skill under `root`, sorted by name so the listing
 * is stable across file systems.
 *
 * Symlinked entries are skipped rather than followed (`readdir`'s `Dirent`
 * reports the link itself, never the target), and any file that
 * {@link readManagedSkill} rejects is omitted instead of surfaced.
 */
export function listManagedSkills(root: string): ManagedSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const skills: ManagedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidManagedSkillName(entry.name)) {
      continue;
    }
    const skill = readManagedSkill(root, entry.name);
    if (skill) {
      skills.push(skill);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
