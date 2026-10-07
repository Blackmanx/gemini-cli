/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');

// Create the bundle directory if it doesn't exist
if (!existsSync(bundleDir)) {
  mkdirSync(bundleDir);
}

// 1. Copy Sandbox definitions (.sb)
const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
for (const file of sbFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

// 2. Copy Policy definitions (.toml)
const policyDir = join(bundleDir, 'policies');
if (!existsSync(policyDir)) {
  mkdirSync(policyDir);
}

// Locate policy files specifically in the core package
const policyFiles = glob.sync('packages/core/src/policy/policies/*.toml', {
  cwd: root,
});

for (const file of policyFiles) {
  copyFileSync(join(root, file), join(policyDir, basename(file)));
}

console.log(`Copied ${policyFiles.length} policy files to bundle/policies/`);

// Also copy policies to a2a-server dist directory for bundled execution
const a2aPolicyDir = join(root, 'packages/a2a-server/dist/policies');
if (!existsSync(a2aPolicyDir)) {
  mkdirSync(a2aPolicyDir, { recursive: true });
}
for (const file of policyFiles) {
  copyFileSync(join(root, file), join(a2aPolicyDir, basename(file)));
}
console.log(
  `Copied ${policyFiles.length} policy files to packages/a2a-server/dist/policies/`,
);

// 3. Copy Documentation (docs/)
const docsSrc = join(root, 'docs');
const docsDest = join(bundleDir, 'docs');
if (existsSync(docsSrc)) {
  cpSync(docsSrc, docsDest, { recursive: true, dereference: true });
  console.log('Copied docs to bundle/docs/');
}

// 4. Copy Built-in Skills (packages/core/src/skills/builtin)
const builtinSkillsSrc = join(root, 'packages/core/src/skills/builtin');
const builtinSkillsDest = join(bundleDir, 'builtin');
if (existsSync(builtinSkillsSrc)) {
  cpSync(builtinSkillsSrc, builtinSkillsDest, {
    recursive: true,
    dereference: true,
  });
  console.log('Copied built-in skills to bundle/builtin/');
}

// 5. Copy bundled chrome-devtools-mcp
const bundleMcpSrc = join(root, 'packages/core/dist/bundled');
const bundleMcpDest = join(bundleDir, 'bundled');
if (!existsSync(bundleMcpSrc)) {
  console.error(
    `Error: chrome-devtools-mcp bundle not found at ${bundleMcpSrc}.\n` +
      `Run "npm run bundle:browser-mcp -w @google/gemini-cli-core" first.`,
  );
  process.exit(1);
}
cpSync(bundleMcpSrc, bundleMcpDest, { recursive: true, dereference: true });
console.log('Copied bundled chrome-devtools-mcp to bundle/bundled/');

// 6. Copy Extension Examples
const extensionExamplesSrc = join(
  root,
  'packages/cli/src/commands/extensions/examples',
);
const extensionExamplesDest = join(bundleDir, 'examples');
const EXCLUDED_EXAMPLE_DIRS = ['node_modules', 'dist'];

if (existsSync(extensionExamplesSrc)) {
  cpSync(extensionExamplesSrc, extensionExamplesDest, {
    recursive: true,
    dereference: true,
    filter: (src) => !EXCLUDED_EXAMPLE_DIRS.some((dir) => src.includes(dir)),
  });
  console.log('Copied extension examples to bundle/examples/');
}

// 7. Vendor ripgrep.
//
// resolveRipgrepPath() looks for `rg-<platform>-<arch>` next to the bundled
// code before falling back to a system binary, and it only accepts a system
// binary from a trusted directory. Without this copy the bundle has neither,
// so it silently drops to the slower GrepTool on any machine whose `rg` lives
// somewhere untrusted — a version manager, a home directory, a workspace root.
const ripgrepSrc = join(root, 'packages/core/vendor/ripgrep');
const ripgrepDest = join(bundleDir, 'vendor', 'ripgrep');

if (!existsSync(ripgrepSrc)) {
  console.error(
    `Error: ripgrep binaries not found at ${ripgrepSrc}.\n` +
      'Run "npx tsx scripts/download-ripgrep-binaries.ts" first.',
  );
  process.exit(1);
}
cpSync(ripgrepSrc, ripgrepDest, { recursive: true });
// The .exe ships 0644 from the download; the rest are already executable, but
// set it unconditionally so an umask or a re-extract cannot strip it.
for (const file of readdirSync(ripgrepDest)) {
  chmodSync(join(ripgrepDest, file), 0o755);
}
console.log(
  `Copied ripgrep binaries to bundle/vendor/ripgrep/ (${readdirSync(ripgrepDest).length})`,
);

// 8. Vendor officecli, the generic Office engine the office-docs and
// pptd-slides skills drive. Optional: a missing copy only costs those skills the
// generic path, because both keep working from their own scripts.
const officecliSrc = join(root, 'packages/core/vendor/officecli');
const officecliDest = join(bundleDir, 'vendor', 'officecli');

if (existsSync(officecliSrc)) {
  cpSync(officecliSrc, officecliDest, { recursive: true });
  for (const file of readdirSync(officecliDest)) {
    chmodSync(join(officecliDest, file), 0o755);
  }
  console.log(
    `Copied officecli to bundle/vendor/officecli/ (${readdirSync(officecliDest).length})`,
  );
} else {
  console.log('officecli not vendored; skipping (optional).');
}
console.log('Assets copied to bundle/');
