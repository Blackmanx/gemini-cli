# Gemini CLI

[![Gemini CLI CI](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml)
[![Gemini CLI E2E (Chained)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml)
[![Version](https://img.shields.io/npm/v/@google/gemini-cli)](https://www.npmjs.com/package/@google/gemini-cli)
[![License](https://img.shields.io/github/license/google-gemini/gemini-cli)](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)
[![View Code Wiki](https://assets.codewiki.google/readme-badge/static.svg)](https://codewiki.google/github.com/google-gemini/gemini-cli?utm_source=badge&utm_medium=github&utm_campaign=github.com/google-gemini/gemini-cli)

![Gemini CLI Screenshot](/docs/assets/gemini-screenshot.png)

Gemini CLI is an open-source AI agent that brings the power of Gemini directly
into your terminal. It provides lightweight access to Gemini, giving you the
most direct path from your prompt to our model.

Learn all about Gemini CLI in our [documentation](https://geminicli.com/docs/).

## 🚀 Why Gemini CLI?

- **🎯 Free tier**: 60 requests/min and 1,000 requests/day with personal Google
  account.
- **🧠 Powerful Gemini 3 models**: Access to improved reasoning and 1M token
  context window.
- **🔧 Built-in tools**: Google Search grounding, file operations, shell
  commands, web fetching.
- **🔌 Extensible**: MCP (Model Context Protocol) support for custom
  integrations.
- **💻 Terminal-first**: Designed for developers who live in the command line.
- **🛡️ Open source**: Apache 2.0 licensed.

## 📦 Installation

See
[Gemini CLI installation, execution, and releases](https://www.geminicli.com/docs/get-started/installation)
for recommended system specifications and a detailed installation guide.

### Quick Install

#### Run instantly with npx

```bash
# Using npx (no installation required)
npx @google/gemini-cli
```

#### Install globally with npm

```bash
npm install -g @google/gemini-cli
```

#### Install globally with Homebrew (macOS/Linux)

```bash
brew install gemini-cli
```

#### Install globally with MacPorts (macOS)

```bash
sudo port install gemini-cli
```

#### Install with Anaconda (for restricted environments)

```bash
# Create and activate a new environment
conda create -y -n gemini_env -c conda-forge nodejs
conda activate gemini_env

# Install Gemini CLI globally via npm (inside the environment)
npm install -g @google/gemini-cli
```

#### Install this fork (`feature/omp-port`) — from the release zip

Every release ships `gemini-cli-bundle.zip`: a self-contained build with no
runtime dependencies, no clone, and no npm permissions required. This is the
recommended route.

**1. Get the zip.** From the [releases page][releases] in a browser, or with the
GitHub CLI:

```bash
REPO=Blackmanx/gemini-cli
gh release list -R "$REPO"                       # find the latest tag
gh release download <tag> -R "$REPO" --pattern '*.zip'
```

`-R` is what lets these run from any directory; without it `gh` needs to be
inside a git repository and fails with _"not a git repository"_.

[releases]: https://github.com/Blackmanx/gemini-cli/releases

**2. Unpack it somewhere stable.** The bundle is self-contained, so the location
only has to survive; it does not need to be the source tree.

```bash
mkdir -p ~/opt/gemini-cli
unzip gemini-cli-bundle.zip -d ~/opt/gemini-cli
chmod +x ~/opt/gemini-cli/bundle/gemini.js
chmod +x ~/opt/gemini-cli/bundle/vendor/ripgrep/* 2>/dev/null
```

The second `chmod` is for the vendored ripgrep binaries, and it matters more
than it looks: `unzip` does not reliably restore the executable bit, and without
it the vendored `rg` is present but cannot be spawned. The CLI falls back to its
own grep in that case, which works but is slower — so do run it. There is no
ripgrep on Windows, hence the `2>/dev/null`.

The first `chmod` is a safety net for the same reason. Note the path: the
executable is `bundle/gemini.js` inside a top-level `bundle/` directory, not
`gemini.js` at the root of the archive.

**3. Put it on your `PATH` via a symlink**, so updating later is a one-line swap
rather than editing your shell profile:

```bash
mkdir -p ~/.local/bin
ln -sf ~/opt/gemini-cli/bundle/gemini.js ~/.local/bin/gemini
```

**4. Verify**, from any directory:

```bash
gemini --version   # e.g. 0.63.0-184cf92c5
gemini --help
gemini             # launch the interactive CLI
```

If `gemini` is not found, `~/.local/bin` is not on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # macOS: ~/.zshrc
source ~/.bashrc
```

**To update:** download the new zip, replace the unpacked directory, re-run the
symlink. The symlink target does not move, so that is all.

```bash
rm -rf ~/opt/gemini-cli
mkdir -p ~/opt/gemini-cli
unzip gemini-cli-bundle.zip -d ~/opt/gemini-cli
```

**To uninstall:** remove the symlink and the directory. Nothing else was
touched.

```bash
rm -f ~/.local/bin/gemini
rm -rf ~/opt/gemini-cli
```

This never touches `~/.gemini`, which holds your settings, managed skills and
OAuth credentials, so uninstalling and reinstalling is safe at any time.

##### If `gemini` resolves to the wrong thing

More than one install can put a `gemini` on your `PATH`. Check which one wins:

```bash
which -a gemini
```

An older npm-installed copy is the usual culprit; remove it with
`npm uninstall -g gemini-cli` and check `which -a gemini` again.

##### If file search fails with "Permission denied" or "EACCES"

You skipped the `chmod +x` on `bundle/vendor/ripgrep/*`. The vendored `ripgrep`
binary is then present but cannot be executed, and the CLI selects it and fails
at spawn time rather than falling back to its own grep:

```
error: failed to execute command '.../vendor/ripgrep/rg-linux-x64':
Permission denied (os error 13)
```

Fix it by running the missing `chmod`:

```bash
chmod +x ~/opt/gemini-cli/bundle/vendor/ripgrep/* 2>/dev/null
```

Or, if you would rather not rely on the bundled binary at all, turn ripgrep off
in `~/.gemini/settings.json` and let the CLI use its own (slower) grep:

```json
{ "tools": { "useRipgrep": false } }
```

Setting `tools.useRipgrep` to `false` is also the workaround on hosts where your
system `rg` is not in a trusted directory — a version manager, a home directory
or a workspace root. In that case the CLI logs
`Ripgrep is not available. Falling back to GrepTool.` and search still works.

Do not run the bundle from a read-only or `noexec` mount. The same chmod that
fixes the warning is what makes the binary runnable at all.

##### Or install it as an npm package

The same bundle is a valid npm package, if you would rather have npm manage it:

```bash
git clone --branch feature/omp-port https://github.com/Blackmanx/gemini-cli.git
cd gemini-cli-omp
npm install
npm run release:bundle     # writes release/gemini-cli-bundle.zip and release/*.tgz
cd bundle && npm install -g .
```

Run that last command from `bundle/`, not the repository root: a root package
with `workspaces` cannot be installed globally, and npm rejects it with
_"Workspaces not supported for global packages"_.

To update: `git pull`, `npm run release:bundle`, and repeat the
`npm install -g`. A global install does not pick up source changes on its own.

To uninstall an npm-installed copy:

```bash
npm uninstall -g gemini-cli
```

##### Migrating from an older `gemini`

Safe to run on a machine that has any previous install. Nothing here touches
`~/.gemini`, so settings, managed skills and OAuth credentials survive.

**1. See what is currently installed.** More than one `gemini` can be on the
`PATH`; the first one wins and it may not be the one you expect.

```bash
which -a gemini
```

**2. Remove every old copy.** Run all three lines; the ones that do not apply
report an error you can ignore.

```bash
npm uninstall -g @google/gemini-cli 2>/dev/null   # upstream, via npm
npm uninstall -g gemini-cli 2>/dev/null      # this fork, via npm
rm -f "$(npm config get prefix)/bin/gemini" 2>/dev/null   # any npm install
rm -f ~/.local/bin/gemini                        # the symlink route
rm -rf ~/opt/gemini-cli                          # the unpacked bundle
```

If a clone was linked with `npm link`, drop the link too:

```bash
cd /path/to/gemini-cli-omp/packages/cli 2>/dev/null && npm unlink -g @google/gemini-cli
```

Check that nothing is left:

```bash
which -a gemini    # should print nothing
```

**3. Install the new bundle.** From the [releases page][releases]:

```bash
REPO=Blackmanx/gemini-cli
gh release download <tag> -R "$REPO" --pattern '*.zip'    # or download it in a browser

mkdir -p ~/opt/gemini-cli
unzip gemini-cli-bundle.zip -d ~/opt/gemini-cli
chmod +x ~/opt/gemini-cli/bundle/gemini.js
chmod +x ~/opt/gemini-cli/bundle/vendor/ripgrep/* 2>/dev/null
mkdir -p ~/.local/bin
ln -sf ~/opt/gemini-cli/bundle/gemini.js ~/.local/bin/gemini
```

**4. Verify.** The version must end in `-<base>-<sha>`, which is how you know you
are running this fork and not the upstream package:

```bash
gemini --version
```

If `gemini` is not found afterwards, `~/.local/bin` is not on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # macOS: ~/.zshrc
source ~/.bashrc
```

Nothing above re-authenticates: your existing credentials in `~/.gemini` are
reused, so the CLI is usable as soon as `gemini --version` works.

##### Cutting a new release (maintainers)

One command builds, stamps the version, packs both artifacts and publishes:

```bash
npm run release:bundle -- --release
```

It works in this order:

1. **Stamps the version** to `<base>-<short-sha>` from
   `git rev-parse --short HEAD`, across all eight workspace manifests. The base
   (`0.63.0` here) is whatever the root manifest already had; only the suffix
   moves.
2. **Builds** with `npm run bundle`, which emits a self-contained ESM program.
3. **Writes `bundle/package.json`** so npm can install the bundle directly.
4. **Packs** `release/*.tgz` (for `npm install -g`) and
   `release/gemini-cli-bundle.zip` (for the unzip-and-symlink route).
5. **Creates a GitHub release** whose tag is derived from the version, and
   prints the install commands for both routes.

Commit the version change the stamp produced. It is a real edit to tracked
files, and the next run will re-stamp it if you release from a different commit.

```bash
git add package.json packages/*/package.json
git commit -m "chore: version 0.63.0-$(git rev-parse --short HEAD)"
```

Useful flags:

| Flag                 | Effect                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| `--skip-build`       | Pack whatever is already in `bundle/`. Refused if the version changed, see below |
| `--clobber`          | Replace assets _and_ notes on an existing tag                                    |
| `--no-stamp-version` | Leave the version alone and derive the tag from it as-is                         |
| `--tag v1.2.3`       | Override the derived tag                                                         |

`--skip-build` is only valid when the version did not move. The bundle bakes the
version in at build time, so packing a stale bundle after a version change ships
a package whose `package.json` and whose `gemini --version` disagree — the
script refuses that combination rather than publish it. It is safe for
re-uploading the same build, e.g. after fixing release notes.

Two constraints worth knowing before you tag by hand:

- The repository enforces a tag protection rule,
  `^v(\d*)(\.(\d*)?\.(\d*)?)?-?(?:[a-zA-Z0-9]*)?$`. Dots are allowed only in the
  numeric core, and the suffix takes a **single** dash before alphanumerics. So
  `0.63.0-0adc74b84` must be tagged `v0.63.0-0adc74b84`; the script
  flattens it. Anything else is HTTP 422.
- The release pipeline in `.github/workflows/release-*.yml` is gated on
  `github.repository == 'google-gemini/gemini-cli'`, so it does nothing here.
  That is why this script exists rather than the stock release job.

The tag is a function of the version, so a version left pointing at an older
commit yields a release that claims to be something it is not. Stamping is
therefore on by default; `--no-stamp-version` opts out when you deliberately
want that.

The stamped sha is the commit the bundle was **built from**, not the commit that
records the version. Those are necessarily different: stamping edits the
manifests, so committing that edit creates a child of the sha just stamped. This
is inherent to putting a commit hash in a version, and every project that does
it has the same property. The property that does hold is the useful one — the
sha identifies the source the artifact was produced from.

To keep it exact, commit your code changes first and release from that commit:

```bash
git commit -am "..."                        # HEAD = X
npm run release:bundle -- --release         # stamps 0.63.0-X
git add package.json packages/*/package.json   # optional: record the bump
```

##### If the global npm prefix is not on your PATH

Every `npm install -g` and `npm link` above honours `npm config get prefix`.
Check where that points before anything else:

```bash
npm config get prefix
```

If the printed directory has a `bin` you can write to without `sudo`, and that
`bin` is already on your `PATH`, there is nothing to do — this is the normal
case under `nvm`, `fnm`, `volta` and `asdf`.

If it needs `sudo`, or the `bin` is not on your `PATH`, move npm to a prefix you
own. Do this **once**, and it applies to every later install:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

On macOS use `~/.zshrc` instead of `~/.bashrc`. Verify before installing:

```bash
npm config get prefix          # -> /home/you/.npm-global
which gemini                   # not found yet is expected
```

To undo a machine-global `npm link`, note that the link lives in the _prefix_,
not in your home directory:

```bash
cd gemini-cli-omp/packages/cli && npm unlink -g @google/gemini-cli   # the linked package's own name
rm -f "$(npm config get prefix)/bin/gemini"
```

##### For development: link the working tree instead

When you want `gemini` to run the code you are editing, skip the bundle and link
`packages/cli` directly:

```bash
cd gemini-cli-omp
npm run build
cd packages/cli
npm link
```

This puts `gemini` on your `PATH` via a symlink. The trade-off is that it breaks
if you move or delete the clone, and every source change needs `npm run build`
before it takes effect. Use it while developing; use the bundle above for a
machine you actually work on.

```bash
cd gemini-cli-omp
npm run build   # after every change
```

To undo a link, see the prefix note above; the symlink lives in
`$(npm config get prefix)/bin`.

Either install path needs only Node >= 20 (see `.nvmrc`); the bundle is
self-contained and has no runtime dependency on the clone.

## 🧭 What this fork adds

Everything here lives under the `omp` namespace in settings, so the port can be
identified and removed as a unit. Delete the `omp` block and the fork's
behaviour is upstream's again.

### `/goal` — hold the model to an objective

Sets an objective the model is expected to work toward for the rest of the
session. It gets the objective in its system prompt and can be given a token

```bash
/goal Document CICD Orquestador thoroughly   # set a goal, no token limit
/goal fix the flaky upload test 50000        # ...or with a limit, in tokens
/goal                                         # show the current goal
/goal pause                                    # stop accruing tokens
/goal resume                                   # pick a paused goal back up
/goal drop                                     # abandon it
/goal clear                                    # end it without claiming it was met
```

Any text that is not a subcommand is taken as the objective, so
`/goal <what you want>` is the normal form. `/goal set <objective>` still works.

**There is no token limit unless you give one.** A trailing bare integer sets
it; anything else leaves the goal unbounded. A goal that is meant to get done
should not be cut off by a ceiling nobody chose.

````

The model drives the same lifecycle through the `goal` tool (`op=create`, `get`,
`complete`, `drop`), so it can mark its own work done without you intervening.

**The token budget is the point.** When the budget is reached, the model is
steered to stop and wrap up rather than left to keep spending. The steer is
delivered as an injection into the turn that overspent, and it is deliberately
not gated on model steering the way `user_steering` is — dropping it would waste
the tokens it exists to save.

Only genuinely new tokens are charged. Cached reads of an already-seen prefix
are excluded, because a re-read is not new work.

To have the model keep going on its own when it stops with a goal still open:

```json
{ "omp": { "goal": { "continuation": true } } }
````

Off by default, because it spends tokens without asking. It also stops on its
own after a few consecutive continuations, so a goal the model cannot advance
does not loop forever.

### `/btw` — ask a side question

Asks something tangential without putting it in the conversation. The answer
arrives as its own block, and the main transcript is untouched — a tangent in
the transcript would be carried into every later turn, and the model would start
answering questions nobody asked.

```bash
/btw why did it pick that file?
```

It has no tools and no history, so it cannot act on your workspace. If the
answer needs something only the session knows, it will say so.

### Headless mode: pay for less harness

Every non-interactive run (`gemini -p "..."`) is a fresh process, so the harness
is sent again on every invocation with no cached prefix to amortize it. Measured
on this build, the first request carried ~17.9k tokens before your prompt even
landed: ~5.9k system instruction, ~9.0k tool schemas across 23 tools, and ~3.0k
session context. The interactive flag changed almost none of it — ~118 tokens.

`omp.headlessHarness` decides how much of that gets sent:

```json
{ "omp": { "headlessHarness": "slim" } }
```

| value            | what is sent                                                       | first request |
| ---------------- | ------------------------------------------------------------------ | ------------- |
| `full` (default) | composed system prompt, session context, every tool schema         | ~17.9k        |
| `slim`           | short system prompt, no schemas for tools that cannot run headless | ~12.1k        |
| `api`            | short system prompt, no tools, no session context                  | ~55           |

`slim` is still a working agent: it can read, search, edit and run commands.
`api` is a plain one-shot text call with no file access at all — the prompt
tells the model so outright, because a model that believes it has tools will ask
for them and it will be right to.

Interactive runs ignore this entirely. A `GEMINI_SYSTEM_MD` you wrote yourself
still wins over `slim` and `api`: someone who wrote their own prompt has already
made the call this setting makes for them.

### Tainted commands in YOLO

A command that reuses flags or arguments found in untrusted tool output (a
`web_fetch`, an MCP result) normally outranks the policy engine: it prompts even
in YOLO, and is denied outright in headless YOLO. That is deliberate — the
detection is what makes a prompt-injection attempt visible.

If you would rather YOLO trusted you:

```json
{ "omp": { "allowTaintedCommandsInYolo": true } }
```

Only the extra confirmation goes away. The `<untrusted_context>` marking and the
system prompt directive that tells the model to treat that content as passive
data both stay on, so prompt-injection protection still applies. The setting
does nothing outside YOLO; other approval modes keep asking.

### Context files: `AGENTS.md` and friends

Besides `GEMINI.md`, this build reads the context files other agents use, so a
repo written for another tool works without copying its instructions. The
default order is:

```
AGENTS.md  →  GEMINI.md  →  CLAUDE.md
```

**Only the first one that exists is read.** Loading two would put near-duplicate
instructions into every request, which is the cost you are usually trying to
avoid. `AGENTS.md` is first because it is the cross-agent convention: if a repo
carries one, that is the file the project means for any agent.

Change the order, or the set, to taste via `omp.contextFilePriority`:

```json
{ "omp": { "contextFilePriority": ["AGENTS.md", "GEMINI.md", "CLAUDE.md"] } }
```

Put your own file first to win outright:

```json
{ "omp": { "contextFilePriority": ["CONTRIBUTING.md", "AGENTS.md"] } }
```

Or drop a candidate entirely, if you never want it picked up:

```json
{ "omp": { "contextFilePriority": ["AGENTS.md"] } }
```

The list **replaces** the default rather than adding to it, so whatever you
leave out is gone. It is editable in `/settings` under "OMP: Context File
Priority" as a comma-separated string, and from the command line:

```bash
gemini config set omp.contextFilePriority '["AGENTS.md", "GEMINI.md"]'
```

Prefer your old `context.fileName`? It still wins over all of this, and it takes
a list too:

```json
{ "context": { "fileName": ["AGENTS.md", "CLAUDE.md"] } }
```

The difference: `context.fileName` loads **every** file you list, so use it only
when the files genuinely do not overlap.

### `/settings` while a task is running

`/settings` is safe to open mid-task. A running task otherwise swallows slash
commands, and only those marked concurrent-safe get through. Editing settings is
just config state: it takes effect on the next turn, and the entries that need a
restart already say so in the dialog.

### No autoupdates

This build does not update itself. The upstream updater runs the package manager
against the official package, which on a fork installed from source would
replace your checkout with upstream. There is no update check, no notification,
and no setting to re-enable it. Update by pulling and re-bundling, as in the
install section above.

## Release Channels

See [Releases](https://www.geminicli.com/docs/changelogs) for more details.

### Preview

New preview releases will be published each week at UTC 23:59 on Tuesdays. These
releases will not have been fully vetted and may contain regressions or other
outstanding issues. Please help us test and install with `preview` tag.

```bash
npm install -g @google/gemini-cli@preview
```

### Stable

- New stable releases will be published each week at UTC 20:00 on Tuesdays, this
  will be the full promotion of last week's `preview` release + any bug fixes
  and validations. Use `latest` tag.

```bash
npm install -g @google/gemini-cli@latest
```

### Nightly

- New releases will be published each day at UTC 00:00. This will be all changes
  from the main branch as represented at time of release. It should be assumed
  there are pending validations and issues. Use `nightly` tag.

```bash
npm install -g @google/gemini-cli@nightly
```

## 📋 Key Features

### Code Understanding & Generation

- Query and edit large codebases
- Generate new apps from PDFs, images, or sketches using multimodal capabilities
- Debug issues and troubleshoot with natural language

### Automation & Integration

- Automate operational tasks like querying pull requests or handling complex
  rebases
- Use MCP servers to connect new capabilities, including
  [media generation with Imagen, Veo or Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Run non-interactively in scripts for workflow automation

### Advanced Capabilities

- Ground your queries with built-in
  [Google Search](https://ai.google.dev/gemini-api/docs/grounding) for real-time
  information
- Conversation checkpointing to save and resume complex sessions
- Custom context files (GEMINI.md) to tailor behavior for your projects

### GitHub Integration

Integrate Gemini CLI directly into your GitHub workflows with
[**Gemini CLI GitHub Action**](https://github.com/google-github-actions/run-gemini-cli):

- **Pull Request Reviews**: Automated code review with contextual feedback and
  suggestions
- **Issue Triage**: Automated labeling and prioritization of GitHub issues based
  on content analysis
- **On-demand Assistance**: Mention `@gemini-cli` in issues and pull requests
  for help with debugging, explanations, or task delegation
- **Custom Workflows**: Build automated, scheduled and on-demand workflows
  tailored to your team's needs

## 🔐 Authentication Options

Choose the authentication method that best fits your needs:

### Option 1: Sign in with Google (OAuth login using your Google Account)

**✨ Best for:** Individual developers as well as anyone who has a Gemini Code
Assist License. (see
[quota limits and terms of service](https://cloud.google.com/gemini/docs/quotas)
for details)

**Benefits:**

- **Free tier**: 60 requests/min and 1,000 requests/day
- **Gemini 3 models** with 1M token context window
- **No API key management** - just sign in with your Google account
- **Automatic updates** to latest models

#### Start Gemini CLI, then choose _Sign in with Google_ and follow the browser authentication flow when prompted

```bash
gemini
```

#### If you are using a paid Code Assist License from your organization, remember to set the Google Cloud Project

```bash
# Set your Google Cloud Project
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
gemini
```

### Option 2: Gemini API Key

**✨ Best for:** Developers who need specific model control or paid tier access

**Benefits:**

- **Free tier**: 1000 requests/day with Gemini 3 (mix of flash and pro)
- **Model selection**: Choose specific Gemini models
- **Usage-based billing**: Upgrade for higher limits when needed

```bash
# Get your key from https://aistudio.google.com/apikey
export GEMINI_API_KEY="YOUR_API_KEY"
gemini
```

### Option 3: Vertex AI

**✨ Best for:** Enterprise teams and production workloads

**Benefits:**

- **Enterprise features**: Advanced security and compliance
- **Scalable**: Higher rate limits with billing account
- **Integration**: Works with existing Google Cloud infrastructure

```bash
# Get your key from Google Cloud Console
export GOOGLE_API_KEY="YOUR_API_KEY"
export GOOGLE_GENAI_USE_VERTEXAI=true
gemini
```

For Google Workspace accounts and other authentication methods, see the
[authentication guide](https://www.geminicli.com/docs/get-started/authentication).

## 🚀 Getting Started

### Basic Usage

#### Start in current directory

```bash
gemini
```

#### Include multiple directories

```bash
gemini --include-directories ../lib,../docs
```

#### Use specific model

```bash
gemini -m gemini-2.5-flash
```

#### Non-interactive mode for scripts

Get a simple text response:

```bash
gemini -p "Explain the architecture of this codebase"
```

For more advanced scripting, including how to parse JSON and handle errors, use
the `--output-format json` flag to get structured output:

```bash
gemini -p "Explain the architecture of this codebase" --output-format json
```

For real-time event streaming (useful for monitoring long-running operations),
use `--output-format stream-json` to get newline-delimited JSON events:

```bash
gemini -p "Run tests and deploy" --output-format stream-json
```

### Quick Examples

#### Start a new project

```bash
cd new-project/
gemini
> Write me a Discord bot that answers questions using a FAQ.md file I will provide
```

#### Analyze existing code

```bash
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
gemini
> Give me a summary of all of the changes that went in yesterday
```

## 📚 Documentation

### Getting Started

- [**Quickstart Guide**](https://www.geminicli.com/docs/get-started) - Get up
  and running quickly.
- [**Authentication Setup**](https://www.geminicli.com/docs/get-started/authentication) -
  Detailed auth configuration.
- [**Configuration Guide**](https://www.geminicli.com/docs/reference/configuration) -
  Settings and customization.
- [**Keyboard Shortcuts**](https://www.geminicli.com/docs/reference/keyboard-shortcuts) -
  Productivity tips.

### Core Features

- [**Commands Reference**](https://www.geminicli.com/docs/reference/commands) -
  All slash commands (`/help`, `/chat`, etc).
- [**Custom Commands**](https://www.geminicli.com/docs/cli/custom-commands) -
  Create your own reusable commands.
- [**Context Files (GEMINI.md)**](https://www.geminicli.com/docs/cli/gemini-md) -
  Provide persistent context to Gemini CLI.
- [**Checkpointing**](https://www.geminicli.com/docs/cli/checkpointing) - Save
  and resume conversations.
- [**Token Caching**](https://www.geminicli.com/docs/cli/token-caching) -
  Optimize token usage.

### Tools & Extensions

- [**Built-in Tools Overview**](https://www.geminicli.com/docs/reference/tools)
  - [File System Operations](https://www.geminicli.com/docs/tools/file-system)
  - [Shell Commands](https://www.geminicli.com/docs/tools/shell)
  - [Web Fetch & Search](https://www.geminicli.com/docs/tools/web-fetch)
- [**MCP Server Integration**](https://www.geminicli.com/docs/tools/mcp-server) -
  Extend with custom tools.
- [**Custom Extensions**](https://geminicli.com/docs/extensions/writing-extensions) -
  Build and share your own commands.

### Advanced Topics

- [**Headless Mode (Scripting)**](https://www.geminicli.com/docs/cli/headless) -
  Use Gemini CLI in automated workflows.
- [**IDE Integration**](https://www.geminicli.com/docs/ide-integration) - VS
  Code companion.
- [**Sandboxing & Security**](https://www.geminicli.com/docs/cli/sandbox) - Safe
  execution environments.
- [**Trusted Folders**](https://www.geminicli.com/docs/cli/trusted-folders) -
  Control execution policies by folder.
- [**Enterprise Guide**](https://www.geminicli.com/docs/cli/enterprise) - Deploy
  and manage in a corporate environment.
- [**Telemetry & Monitoring**](https://www.geminicli.com/docs/cli/telemetry) -
  Usage tracking.
- [**Tools reference**](https://www.geminicli.com/docs/reference/tools) -
  Built-in tools overview.
- [**Local development**](https://www.geminicli.com/docs/local-development) -
  Local development tooling.

### Troubleshooting & Support

- [**Troubleshooting Guide**](https://www.geminicli.com/docs/resources/troubleshooting) -
  Common issues and solutions.
- [**FAQ**](https://www.geminicli.com/docs/resources/faq) - Frequently asked
  questions.
- Use `/bug` command to report issues directly from the CLI.

### Using MCP Servers

Configure MCP servers in `~/.gemini/settings.json` to extend Gemini CLI with
custom tools:

```text
> @github List my open pull requests
> @slack Send a summary of today's commits to #dev channel
> @database Run a query to find inactive users
```

See the
[MCP Server Integration guide](https://www.geminicli.com/docs/tools/mcp-server)
for setup instructions.

## 🤝 Contributing

We welcome contributions! Gemini CLI is fully open source (Apache 2.0), and we
encourage the community to:

- Report bugs and suggest features.
- Improve documentation.
- Submit code improvements.
- Share your MCP servers and extensions.

See our [Contributing Guide](./CONTRIBUTING.md) for development setup, coding
standards, and how to submit pull requests.

Check our [Official Roadmap](https://github.com/orgs/google-gemini/projects/11)
for planned features and priorities.

## 📖 Resources

- **[Free Course](https://learn.deeplearning.ai/courses/gemini-cli-code-and-create-with-an-open-source-agent/information)** -
  Learn the basics.
- **[Official Roadmap](./ROADMAP.md)** - See what's coming next.
- **[Changelog](https://www.geminicli.com/docs/changelogs)** - See recent
  notable updates.
- **[NPM Package](https://www.npmjs.com/package/@google/gemini-cli)** - Package
  registry.
- **[GitHub Issues](https://github.com/google-gemini/gemini-cli/issues)** -
  Report bugs or request features.
- **[Security Advisories](https://github.com/google-gemini/gemini-cli/security/advisories)** -
  Security updates.

### Uninstall

See the [Uninstall Guide](https://www.geminicli.com/docs/resources/uninstall)
for removal instructions.

## 📄 Legal

- **License**: [Apache License 2.0](LICENSE)
- **Terms of Service**:
  [Terms & Privacy](https://www.geminicli.com/docs/resources/tos-privacy)
- **Security**: [Security Policy](SECURITY.md)

<p align="left">
 <a href="https://www.star-history.com/google-gemini/gemini-cli">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
   <img alt="Star History Rank" src="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
  </picture>
 </a>
</p>

---

<p align="center">
  Built with ❤️ by Google and the open source community
</p>
