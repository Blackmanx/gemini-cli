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
  rmSync,
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

// The zip is the other half of the install story: `npm install -g` needs the
// tarball, but unzipping to ~/opt and symlinking needs no npm global write
// permission at all, which is what people without a writable prefix use.
// Both ship on the release.
const zipName = 'gemini-cli-bundle.zip';
const zipPath = join(outDir, zipName);
const bundleFiles = [];
for (const entry of readdirSync(bundleDir, {
  recursive: true,
  withFileTypes: true,
})) {
  if (entry.isFile()) {
    bundleFiles.push(join(entry.parentPath ?? entry.path, entry.name));
  }
}
rmSync(zipPath, { force: true });
execFileSync(
  'python3',
  [
    '-c',
    // Arcnames are made relative to the repo root so entries keep their
    // `bundle/...` prefix and directory structure. Flattening to a basename
    // silently drops files that share a name in different directories.
    'import sys,zipfile,os\n' +
      'zf=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\n' +
      'for p in sys.argv[3:]:\n' +
      '    arc=os.path.relpath(p, sys.argv[2]).replace(os.sep,"/")\n' +
      '    zi=zipfile.ZipInfo(arc, (1980,1,1,0,0,0))\n' +
      '    zi.compress_type=zipfile.ZIP_DEFLATED\n' +
      '    zi.external_attr=(0o755 if os.path.basename(arc)=="gemini.js" else 0o644)<<16\n' +
      '    with open(p,"rb") as fh, zf.open(zi,"w") as out: out.write(fh.read())\n' +
      'zf.close()',
    zipPath,
    root,
    ...bundleFiles,
  ],
  { cwd: root },
);
console.log(`zipped ${zipPath} (${bundleFiles.length} files, mode 0755)`);

// 4. Optionally publish to a GitHub release.
const repo = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
  cwd: root,
  encoding: 'utf-8',
}).trim();
const url = `https://github.com/${repo}/releases/download/${tag}/${packed}`;
const zipUrl = `https://github.com/${repo}/releases/download/${tag}/${zipName}`;

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

  const assets = [tarball, zipPath];
  const notes = `Gemini CLI (omp port) ${version}.

Unzip and symlink (no npm permissions needed):

\`\`\`sh
unzip ${zipName} -d ~/opt/gemini-cli
chmod +x ~/opt/gemini-cli/bundle/gemini.js
mkdir -p ~/.local/bin
ln -sf ~/opt/gemini-cli/bundle/gemini.js ~/.local/bin/gemini
\`\`\`

Or install as a package:

\`\`\`sh
npm install -g ${url}
\`\`\``;

  if (releaseExists) {
    // --clobber only replaces assets; the notes are set separately so a
    // re-release cannot leave stale install instructions behind.
    run('gh', ['release', 'upload', tag, ...assets, '--clobber']);
    run('gh', ['release', 'edit', tag, '--notes', notes]);
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      ...assets,
      '--title',
      tag,
      '--notes',
      notes,
    ]);
  }
}

// 5. Report both install paths. The unzip route is listed first because it
// needs no writable npm prefix at all, which is the common case here.
const visibility = execSync('gh repo view --json visibility -q .visibility', {
  cwd: root,
  encoding: 'utf-8',
}).trim();

console.log('\n--- release bundle ready ---');
console.log(`version  : ${version}`);
console.log(`tag      : ${tag}`);
console.log(`tarball  : ${tarball}`);
console.log(`zip      : ${zipPath}`);
console.log(`contents : ${bundleFiles.length} files in bundle/`);
console.log(`repo     : ${visibility}`);

console.log('\ninstall by unzipping (no npm permissions needed):');
console.log(`  unzip ${zipName} -d ~/opt/gemini-cli`);
console.log(`  chmod +x ~/opt/gemini-cli/bundle/gemini.js`);
console.log('  mkdir -p ~/.local/bin');
console.log('  ln -sf ~/opt/gemini-cli/bundle/gemini.js ~/.local/bin/gemini');

console.log('\ninstall as an npm package instead:');
console.log(`  cd ${bundleDir} && npm install -g .`);
console.log(`  npm install -g ${tarball}`);

if (shouldRelease) {
  console.log(`\nfrom the release (org members):`);
  console.log(`  ${zipUrl}`);
  console.log(`  ${url}`);
  console.log('\nupdate: release a new version, then repeat the same install.');
}

if (!shouldRelease) {
  console.log('\n(--release not passed, so nothing was uploaded)');
}
