/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deploy the built `bundle/` to `~/opt/gemini-cli-<version>` safely.
 *
 * The naive flow (`rm -rf` the old install, `cp -r` the new one in place, then
 * flip the `~/.local/bin/gemini` symlink) has two failure modes when a gemini
 * session is running during the deploy:
 *
 *   1. `rm -rf` unlinks the files under the live process; any lazy `import()`
 *      or child tool started afterwards fails with ENOENT, and
 *   2. the symlink can briefly point at a half-copied directory, and
 *   3. two sessions (old + new) end up racing on the shared auth state under
 *      `~/.gemini` (non-atomic credential writes), which can corrupt or
 *      regress the stored refresh token — the user sees a login error and has
 *      to re-authenticate.
 *
 * This script makes deploys safe for live sessions:
 *
 *   - the new version is staged to a hidden temp dir and renamed into place
 *     (atomic within `~/opt`), so a directory never exists half-copied;
 *   - the `~/.local/bin/gemini` symlink is swapped atomically (prepare a temp
 *     symlink, `rename(2)` over the old one);
 *   - install directories in use by a running process are NEVER deleted (they
 *     are kept for a later cleanup pass instead);
 *   - replacing a version directory that is itself in use aborts unless
 *     `--force` is passed.
 *
 * `~/.gemini` (credentials, settings, sessions) is never touched.
 *
 * Usage:
 *   node scripts/deploy_release.js                deploy bundle/ safely
 *   node scripts/deploy_release.js --dry-run      print the plan, touch nothing
 *   node scripts/deploy_release.js --force        replace even an in-use target
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');

const bundleDir = path.join(repoRoot, 'bundle');
const bundlePkgPath = path.join(bundleDir, 'package.json');
if (
  !existsSync(bundlePkgPath) ||
  !existsSync(path.join(bundleDir, 'gemini.js'))
) {
  console.error(
    'No usable bundle/ found (needs package.json and gemini.js).\n' +
      'Run `node scripts/release_bundle.js` first.',
  );
  process.exit(1);
}
const version = JSON.parse(readFileSync(bundlePkgPath, 'utf8')).version;
if (!/^[\w.-]+$/.test(version)) {
  console.error(`Refusing to deploy suspicious version string: ${version}`);
  process.exit(1);
}

const optDir = path.join(os.homedir(), 'opt');
const binDir = path.join(os.homedir(), '.local', 'bin');
const binLink = path.join(binDir, 'gemini');
const targetDir = path.join(optDir, `gemini-cli-${version}`);
const targetScript = path.join(targetDir, 'gemini.js');

/**
 * PIDs whose command line references `needle`, read straight from /proc so we
 * never match our own helper process. Empty cmdline (zombies) never matches.
 */
function pidsUsing(needle) {
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes(needle)) pids.push(Number(entry));
    } catch {
      // Process exited between readdir and read; ignore.
    }
  }
  return pids;
}

// Any gemini session: launched via an absolute install path, or via the
// ~/.local/bin/gemini symlink (argv keeps the invoked path, not the target).
const installDirNeedle = path.join(optDir, 'gemini-cli-');
const anyGeminiPids = [
  ...new Set([...pidsUsing(installDirNeedle), ...pidsUsing(binLink)]),
];
// Sessions pinned to the exact target dir (relevant when redeploying the same
// version) vs. sessions that ran via the symlink and cannot be attributed to
// a specific install dir.
const targetPids = pidsUsing(targetDir);
const unattributedPids = anyGeminiPids.filter(
  (pid) => !targetPids.includes(pid),
);

// Directories of older installs (and abandoned versions of the target).
const staleDirs = existsSync(optDir)
  ? readdirSync(optDir)
      .filter((name) => name.startsWith('gemini-cli-'))
      .map((name) => path.join(optDir, name))
      .filter((dir) => dir !== targetDir)
  : [];

const plan = [];
let abort = null;

if (existsSync(targetDir)) {
  if (targetPids.length > 0 && !force) {
    abort =
      `${targetDir} is in use by PID(s) ${targetPids.join(', ')}.\n` +
      'Close those gemini sessions, or re-run with --force to replace anyway.';
  } else {
    if (targetPids.length > 0) {
      plan.push(
        `! --force: replacing ${targetDir} used by PID(s) ${targetPids.join(', ')}`,
      );
    }
    plan.push(`remove old ${path.basename(targetDir)}`);
  }
}

plan.push(
  `stage bundle/ -> ${path.join(optDir, `.staging-${version}-${process.pid}`)}`,
);
plan.push(`atomic rename -> ${path.basename(targetDir)}`);
plan.push(`atomic symlink swap ${binLink} -> ${targetScript}`);

const keep = [];
const clean = [];
for (const dir of staleDirs) {
  const pids = pidsUsing(dir);
  if (pids.length > 0) {
    keep.push(
      `${path.basename(dir)} (live session: PID(s) ${pids.join(', ')})`,
    );
  } else if (unattributedPids.length > 0) {
    // A gemini session is alive but we cannot prove which old install it
    // loaded from; keep the dir rather than delete files under it.
    keep.push(`${path.basename(dir)} (a session is live via ${binLink})`);
  } else {
    clean.push(path.basename(dir));
  }
}

console.log(`gemini-cli deploy ${version}`);
for (const step of plan) console.log(`  -> ${step}`);
for (const name of clean) console.log(`  -> cleanup ${name}`);
for (const name of keep) console.log(`  -> keep    ${name} [not deleted]`);

if (abort) {
  console.error(`\nABORT: ${abort}`);
  process.exit(1);
}
if (dryRun) {
  console.log('\nDry run: nothing was changed.');
  process.exit(0);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}
mkdirSync(optDir, { recursive: true });
const stagingDir = path.join(optDir, `.staging-${version}-${process.pid}`);
cpSync(bundleDir, stagingDir, { recursive: true });
renameSync(stagingDir, targetDir);

mkdirSync(binDir, { recursive: true });
const tmpLink = path.join(binDir, `.gemini-${process.pid}.tmp`);
symlinkSync(targetScript, tmpLink);
renameSync(tmpLink, binLink);

for (const name of clean) {
  rmSync(path.join(optDir, name), { recursive: true, force: true });
}

console.log(`\nDeployed ${version} -> ${targetDir}`);
console.log(`Symlink    ${binLink} -> ${targetScript}`);
