/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build an installable, updatable release package in one shot.
 *
 * `npm run bundle` emits a self-contained ESM program but no package.json, so
 * it cannot be installed with `npm install -g` - that is why the previous
 * release was a bare zip that had to be unzipped by hand. This wraps the
 * bundle in a package manifest, packs it into a .tgz, and optionally attaches
 * it to a GitHub release.
 *
 * Updating is a re-run: bump the version, run this again, and install the new
 * tarball URL. Each version gets its own tag, so the URL is always fresh -
 * npm caches GitHub release downloads per URL, and a new tag is a new URL.
 *
 * Usage:
 *   node scripts/release_bundle.js                 build and pack only
 *   node scripts/release_bundle.js --release       also create the GitHub release
 *   node scripts/release_bundle.js --clobber       replace assets on an existing tag
 *   node scripts/release_bundle.js --tag v1.2.3    override the release tag
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(root, 'bundle');
const outDir = join(root, 'release');

const argv = new Set(process.argv.slice(2));
const shouldRelease = argv.has('--release');
const shouldClobber = argv.has('--clobber');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function run(command, args, opts = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    stdio: 'inherit',
    cwd: root,
    ...opts,
  });
}

const rootPkg = readJson(join(root, 'package.json'));
const version = rootPkg.version;
// The repository enforces a tag protection rule,
// ^v(\d*)(\.(\d*)?\.(\d*)?)?-?(?:[a-zA-Z0-9]*)?$ - dots are allowed only in
// the numeric core, and the suffix permits a single dash followed by
// alphanumerics. An npm version may legally contain dots and dashes in its
// pre-release (`0.63.0-0adc74b84`), so the suffix is flattened to plain
// alphanumerics; anything else is rejected with HTTP 422.
const versionCore = version.split('-')[0];
const versionSuffix = version.slice(versionCore.length + 1);
const defaultTag =
  'v' +
  versionCore +
  (versionSuffix ? '-' + versionSuffix.replace(/[^a-zA-Z0-9]/g, '') : '');

const tagIndex = process.argv.indexOf('--tag');
const tag =
  tagIndex !== -1 && process.argv[tagIndex + 1]
    ? process.argv[tagIndex + 1]
    : defaultTag;
const packageName = 'gemini-cli';

// 1. Build. `npm run bundle` is the same command release CI uses.
if (!argv.has('--skip-build')) {
  run('npm', ['run', 'bundle']);
}

if (!existsSync(join(bundleDir, 'gemini.js'))) {
  console.error(
    'bundle/gemini.js missing - the bundle step did not produce it.',
  );
  process.exit(1);
}

// 2. Give the bundle a manifest so npm can install it.
//
// `type: module` matters: the bundle is ESM with top-level await, and
// without it Node treats the entry as CommonJS and dies on the first import.
const manifest = {
  name: packageName,
  version,
  description: 'Gemini CLI (omp port) - self-contained bundle',
  type: 'module',
  bin: { gemini: './gemini.js' },
  // Everything is bundled; there are no runtime dependencies to resolve, and
  // declaring none is what makes `npm install -g` work offline and instantly.
  license: 'Apache-2.0',
  // No `files` field on purpose: the bundle is a flat directory of chunks and
  // sidecars, and listing them would mean keeping a second copy of the
  // esbuild manifest in sync. npm packs the whole directory instead.
  engines: { node: '>=20.0.0' },
};
writeFileSync(
  join(bundleDir, 'package.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(`wrote bundle/package.json (${packageName}@${version})`);

// 3. Pack. npm pack on a directory produces the tarball npm install expects.
mkdirSync(outDir, { recursive: true });
const packed = execFileSync(
  'npm',
  ['pack', bundleDir, '--pack-destination', outDir],
  {
    cwd: root,
    encoding: 'utf-8',
  },
)
  .trim()
  .split('\n')
  .pop()
  .trim();
const tarball = join(outDir, packed);
console.log(`packed ${tarball}`);

// 4. Optionally publish to a GitHub release.
const repo = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
  cwd: root,
  encoding: 'utf-8',
}).trim();
const url = `https://github.com/${repo}/releases/download/${tag}/${packed}`;

if (shouldRelease) {
  const releaseExists = (() => {
    try {
      execFileSync('gh', ['release', 'view', tag], {
        cwd: root,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  })();

  if (releaseExists && !shouldClobber) {
    console.error(
      `Release ${tag} already exists. Re-run with --clobber to replace its assets.`,
    );
    process.exit(1);
  }

  if (releaseExists) {
    run('gh', ['release', 'upload', tag, tarball, '--clobber']);
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      tarball,
      '--title',
      tag,
      '--notes',
      `Gemini CLI (omp port) ${version}. Install:\n\n\`\`\`sh\nnpm install -g ${url}\n\`\`\``,
    ]);
  }
}

// 5. Report the install path, and be honest about which one actually works.
//
// A release asset on a non-public repository is not downloadable by URL, so
// printing the https command unconditionally would hand out something that
// 404s. The tarball on disk is always installable; the URL only is when the
// repository is public.
const visibility = execSync('gh repo view --json visibility -q .visibility', {
  cwd: root,
  encoding: 'utf-8',
}).trim();
const urlIsPublic = visibility === 'PUBLIC';
const localInstall = `npm install -g ${tarball}`;

console.log('\n--- release bundle ready ---');
console.log(`version  : ${version}`);
console.log(`tag      : ${tag}`);
console.log(`tarball  : ${tarball}`);
console.log(`contents : ${readdirSync(bundleDir).length} files in bundle/`);
console.log(`repo     : ${visibility}`);

console.log('\ninstall (works now, from this machine):');
console.log(`  ${localInstall}`);

if (urlIsPublic) {
  const remoteInstall = `npm install -g ${url}`;
  console.log('\ninstall (any machine, public repo):');
  console.log(`  ${remoteInstall}`);
  console.log('\nupdate: release a new version, then re-run the same command.');
} else {
  console.log(
    `\nNote: the repository is ${visibility}, so release assets are not` +
      '\ndownloadable by URL. `npm install -g <url>` will 404. To get a' +
      '\nURL-installable package, either make the repository public or' +
      '\npublish the same tarball to an npm registry and install from there.',
  );
}

if (!shouldRelease) {
  console.log('\n(--release not passed, so nothing was uploaded)');
}
