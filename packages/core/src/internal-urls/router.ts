/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The scheme-spec contract this router depends on. A host registers
 * {@link SchemeSpec}s — and nothing else. The router never names a scheme, so
 * adding `pr://` or `conflict://` to a Gemini CLI build is a registration, not
 * a change here.
 *
 * Every spec declares:
 *
 * - `scheme`      — the token without `://`, matched case-insensitively.
 * - `backing`     — `file` (locatable to bytes on disk), `virtual` (the
 *                   handler renders content), `remote` (another host/service,
 *                   never locatable), `device` (session-bound control surface).
 * - `selectors`   — `lines` to peel a trailing `:<selector>` chain, `none` to
 *                   pass the URL through verbatim, `opaque` for server-defined
 *                   URIs that may end in selector-shaped tails.
 * - `immutable`   — default `InternalResource.immutable`; `write.via: 'file'`
 *                   contradicts it.
 * - `write`       — absent on a read-only scheme. `via: 'file'` means the file
 *                   tools write the located path; `via: 'handler'` means the
 *                   spec's `applyWrite` hook owns the mutation, and file-editing
 *                   tools refuse the URL.
 * - hooks         — `resolve` (required), plus optional `locate`, `applyWrite`,
 *                   `enumerate`, `promptDoc`.
 *
 * Registration order is system-prompt order (see `describe()`).
 *
 * Every method is synchronous and fails CLOSED: an unlocatable, unwritable or
 * unresolvable URL raises an `Error` carrying the diagnosis rather than
 * silently degrading to a filesystem path or a no-op.
 *
 * `readTier()` deliberately scans its argument as a raw substring rather than
 * tokenizing it. A delimited list such as `"a; ssh://h/p"` must not be able to
 * smuggle a higher-tier scheme past the approval gate, so the gate asks "does
 * this text mention a tier-raising scheme anywhere?" and answers with the
 * maximum tier found. Do not "improve" this into a per-token parse.
 */
import * as path from 'node:path';
import {
  looksLikeInternalUrl,
  normalizeSingleSlashAlias,
  peelSelector,
  splitScheme,
  splitSingleSlashAlias,
} from './parse.js';
import {
  TIER_RANK,
  type InternalResource,
  type InternalUrl,
  type InternalWriteResult,
  type LocateOptions,
  type ResolveContext,
  type SchemeHost,
  type SchemeSpec,
  type ToolTier,
  type WriteContext,
} from './types.js';

/** Selectors a mutating tool accepts: display modes that do not change which bytes are addressed. */
const WHOLE_FILE_SELECTOR_RE = /^(?:raw|conflicts)$/i;
// A `?` opening `key=value` pairs starts a query; any other `?` is a glob.
const QUERY_START_RE = /\?[\w.-]*=/;
const GLOB_CHARS_RE = /[*?[{]/;

/** A registered hierarchical URL after single-slash alias normalization. */
interface RegisteredUrl {
  /** Normalized `scheme://…` input, selector included. */
  url: string;
  /** Lowercased scheme. */
  scheme: string;
  spec: SchemeSpec;
  /** Parsed form of `url`, with its selector chain intact. */
  parsed: InternalUrl;
}

/**
 * Routed read/search target.
 * - `file`: a file-backed scheme whose URL located a local path; read it through
 *   the filesystem pipeline (paging, images, sqlite, archives).
 * - `resource`: anything else, already resolved by the handler.
 */
export type UrlTarget =
  | { kind: 'file'; path: string; selector: string | undefined }
  | {
      kind: 'resource';
      resource: InternalResource;
      selector: string | undefined;
    };

/** Where a write to `input` should land. */
export type WriteTarget =
  | { kind: 'file'; path: string; selector: string | undefined }
  | { kind: 'handler'; url: InternalUrl; spec: SchemeSpec };

/** Process-wide scheme registry; tools route internal URLs through its spec-driven API. */
export class InternalUrlRouter {
  readonly #specs = new Map<string, SchemeSpec>();

  /**
   * @param specs Schemes in registration order, which is system-prompt order.
   *   Each one is validated exactly as {@link register} would validate it.
   */
  constructor(specs: readonly SchemeSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  /**
   * Install (or replace) a spec. Throws when the spec's write policy disagrees
   * with its hooks: `applyWrite` exists exactly for `write.via: 'handler'`;
   * `write.via: 'file'` needs a mutable file-backed spec with `locate`; a
   * `sandbox` scope needs a linkable spec with `locate` so `sandboxRoots()` can
   * find its root.
   */
  register(spec: SchemeSpec): void {
    const { scheme, backing, write } = spec;
    const via = write?.via;
    if (via === 'handler' && !spec.applyWrite) {
      throw new Error(
        `${scheme}:// spec.write.via is "handler" but the spec lacks applyWrite()`,
      );
    }
    if (via !== 'handler' && spec.applyWrite) {
      throw new Error(
        `${scheme}:// spec has applyWrite() but spec.write.via is ${
          via === undefined ? 'absent' : `"${via}"`
        }`,
      );
    }
    if (via === 'file') {
      if (backing !== 'file') {
        throw new Error(
          `${scheme}:// spec.write.via "file" requires backing "file", not "${backing}"`,
        );
      }
      if (!spec.locate) {
        throw new Error(
          `${scheme}:// spec.write.via "file" requires a locate() hook`,
        );
      }
      if (spec.immutable) {
        throw new Error(
          `${scheme}:// spec.write.via "file" contradicts spec.immutable`,
        );
      }
    }
    if (write?.scope === 'sandbox' && (!spec.linkable || !spec.locate)) {
      throw new Error(
        `${scheme}:// spec.write.scope "sandbox" requires spec.linkable and a locate() hook`,
      );
    }
    this.#specs.set(scheme.toLowerCase(), spec);
  }

  /** Whether `scheme` is registered (case-insensitive). */
  hasScheme(scheme: string): boolean {
    return this.#specs.has(scheme.toLowerCase());
  }

  /** Declared spec of a registered scheme (case-insensitive). */
  spec(scheme: string): SchemeSpec | undefined {
    return this.#specs.get(scheme.toLowerCase());
  }

  /** Specs of every registered scheme, in registration order. */
  specs(): ReadonlyMap<string, SchemeSpec> {
    return new Map(this.#specs);
  }

  /**
   * Rewrite a registered scheme's single-slash alias (`local:/x`,
   * {@link SchemeSpec.singleSlashAlias}) to `scheme://x`; other inputs pass
   * through unchanged.
   */
  normalize(input: string): string {
    const scheme =
      splitScheme(input)?.scheme ?? splitSingleSlashAlias(input)?.scheme;
    if (scheme === undefined) return input;
    return this.#normalizeAlias(scheme, input);
  }

  /**
   * Split `input` into its URL and its read selector, honoring the registered
   * spec's `selectors` and `portAuthority`. Non-URLs and unknown schemes pass
   * through unchanged.
   */
  split(input: string): { path: string; sel?: string } {
    const registered = this.#registered(input);
    if (!registered) return { path: this.normalize(input) };
    return peelSelector(
      registered.url,
      registered.spec.selectors,
      registered.spec.portAuthority,
    );
  }

  /**
   * A mutating tool's URL target (normalized) with a whole-file display
   * selector (`:raw`/`:conflicts`) peeled, so it names the file `read` does.
   * Any other selector — a line range, `raw:1-20`, a malformed `:-10` — throws:
   * the tool addresses a whole file, and dropping the selector would mutate a
   * file the caller never named. Non-URLs pass through.
   */
  peelWriteSelector(input: string, tool = 'write'): string {
    const { path, sel } = this.split(input);
    if (sel === undefined || WHOLE_FILE_SELECTOR_RE.test(sel)) return path;
    throw new Error(
      `${tool} does not accept the trailing selector ":${sel}" — it addresses a whole file. ` +
        `Remove ":${sel}", or if the filename truly ends with it, percent-encode the ":" as %3A.`,
    );
  }

  /**
   * Route a read/search target. `null` when `input` is not a registered
   * internal URL; the caller then treats it as a filesystem path.
   *
   * A file-backed scheme whose `locate` returns a path is a `file` target;
   * everything else (including a file-backed URL that does not exist yet) is
   * resolved by the handler into a `resource`.
   */
  async target(
    input: string,
    context?: ResolveContext,
  ): Promise<UrlTarget | null> {
    const registered = this.#registered(input);
    if (!registered) return null;
    const { path: bare, sel } = this.split(input);
    const { spec } = registered;
    const url = this.#at(registered, bare);

    if (spec.backing === 'file' && spec.locate) {
      const located = spec.locate(url, context);
      if (located !== null)
        return { kind: 'file', path: located, selector: sel };
    }

    const resolved = await spec.resolve(url, context);
    return {
      kind: 'resource',
      resource: {
        ...resolved,
        immutable: resolved.immutable ?? spec.immutable,
      },
      selector: sel,
    };
  }

  /**
   * Absolute local path backing `input`, or an `Error` naming the scheme when
   * the URL has no local file (a virtual/remote target, a missing entry
   * without {@link LocateOptions.create}, or an unknown scheme).
   */
  locate(
    input: string,
    context?: ResolveContext,
    options?: LocateOptions,
  ): string {
    const registered = this.#registered(input);
    if (!registered) {
      throw new Error(
        `Cannot locate ${input}: not an internal URL (use a filesystem path)`,
      );
    }
    const { path: bare } = this.split(input);
    const { spec } = registered;
    if (!spec.locate) {
      throw new Error(
        `Cannot locate ${registered.scheme}:// URLs: no local file backs them`,
      );
    }
    const located = spec.locate(this.#at(registered, bare), context, options);
    if (located === null) {
      throw new Error(`Cannot locate ${input}: no local file backs it`);
    }
    return located;
  }

  /**
   * `locate`, or an error that preserves the diagnosis: a locatable, immutable,
   * non-remote scheme diagnoses its own miss (so the user sees which ids exist),
   * and a remote/virtual scheme is told to `read` the URL instead.
   */
  async requireLocal(
    input: string,
    action: string,
    context?: ResolveContext,
    options?: LocateOptions,
  ): Promise<string> {
    const registered = this.#registered(input);
    if (!registered) {
      throw new Error(
        `Cannot ${action} ${input}: not an internal URL (use a filesystem path)`,
      );
    }
    const { path: bare } = this.split(input);
    const { spec } = registered;
    const url = this.#at(registered, bare);

    if (spec.locate) {
      const located = spec.locate(url, context, options);
      if (located !== null) return located;
      if (spec.immutable && spec.backing !== 'remote') {
        // Let the handler name the miss (`Cannot find artifact://9: …`), but
        // never swallow the caller's abort.
        try {
          await spec.resolve(url, context);
        } catch (error) {
          if (context?.signal?.aborted) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Cannot ${action} ${input}: ${reason}`);
        }
      }
    }

    const message = `Cannot ${action} ${registered.scheme}:// URL: no local file backs ${input}`;
    if (spec.backing === 'remote' || spec.backing === 'virtual') {
      throw new Error(`${message}. Use \`read ${input}\` to inspect it.`);
    }
    throw new Error(message);
  }

  /**
   * Whether file-editing tools (`edit`, `ast_edit`) may write the file `input`
   * locates: its scheme is mutable and tools own its writes
   * (`spec.write.via === 'file'`).
   */
  fileWritable(input: string): boolean {
    const spec = this.#registered(input)?.spec;
    return spec?.write?.via === 'file' && !spec.immutable;
  }

  /**
   * Where a write to `input` should land. Throws the read-only error for a
   * registered scheme with no write policy, so a read-only scheme is never
   * silently treated as a filesystem path.
   */
  writeTarget(input: string, context?: ResolveContext): WriteTarget {
    const registered = this.#registered(input);
    if (!registered) {
      throw new Error(`Cannot write ${input}: not an internal URL`);
    }
    const { path: bare, sel } = this.split(input);
    const { spec } = registered;
    const policy = spec.write;
    if (!policy) {
      throw new Error(`${registered.scheme}:// URLs are read-only`);
    }
    const url = this.#at(registered, bare);
    if (policy.via === 'handler') return { kind: 'handler', url, spec };
    const located = spec.locate?.(url, context, { create: true });
    if (located === null || located === undefined) {
      throw new Error(`Cannot write ${input}: no local file backs it`);
    }
    return { kind: 'file', path: located, selector: sel };
  }

  /**
   * Approval tier for writing `input`: its scheme's `spec.write.tier`. A
   * non-URL is `write`; a read-only scheme is `exec` (the gate is asked after
   * `writeTarget` rejected it, and `exec` is the fail-closed answer).
   */
  writeTier(input: string, content?: string, session?: unknown): ToolTier {
    const registered = this.#registered(input);
    if (!registered) return 'write';
    const policy = registered.spec.write;
    if (!policy) return 'exec';
    return policy.tier(registered.parsed, content, session);
  }

  /**
   * Max `defaultReadTier` over every registered `scheme://` occurring ANYWHERE
   * in `text` (substring, fail-closed for delimited paths). Default `read`.
   */
  readTier(text: string): ToolTier {
    const lower = text.toLowerCase();
    let tier: ToolTier = 'read';
    for (const [scheme, spec] of this.#specs) {
      const schemeTier = spec.defaultReadTier ?? 'read';
      if (TIER_RANK[schemeTier] <= TIER_RANK[tier]) continue;
      if (lower.includes(`${scheme}://`)) tier = schemeTier;
    }
    return tier;
  }

  /**
   * Whether `input` is a registered URL with a glob segment. The authority
   * counts as the first segment unless it is a host
   * ({@link SchemeSpec.portAuthority}). The query and fragment never glob, so
   * `issue://?search=fix*` is no glob while `memory://root/?.md` is.
   */
  isGlob(input: string): boolean {
    const registered = this.#registered(input);
    if (!registered) return false;
    const rest = registered.url.slice(registered.url.indexOf('://') + 3);

    const fragment = rest.indexOf('#');
    const beforeFragment = fragment === -1 ? rest : rest.slice(0, fragment);
    const query = beforeFragment.search(QUERY_START_RE);
    const segments = (
      query === -1 ? beforeFragment : beforeFragment.slice(0, query)
    ).split('/');
    return segments.some(
      (segment, index) =>
        (index > 0 || !registered.spec.portAuthority) &&
        GLOB_CHARS_RE.test(segment),
    );
  }

  /**
   * Searchable leaf documents behind `input`; `null` when its scheme cannot
   * enumerate (search then treats the URL as a single document).
   */
  async enumerate(
    input: string,
    context?: ResolveContext,
  ): Promise<Array<{ url: string; content: string }> | null> {
    const registered = this.#registered(input);
    if (!registered?.spec.enumerate) return null;
    return registered.spec.enumerate(registered.parsed, context);
  }

  /**
   * Absolute roots of every `sandbox`-scope writable scheme (the roots plan
   * mode keeps writable), located through the spec's `locate`.
   */
  sandboxRoots(context?: ResolveContext): string[] {
    const roots: string[] = [];
    for (const [scheme, spec] of this.#specs) {
      if (spec.write?.scope !== 'sandbox' || !spec.locate) continue;
      const registered = this.#registered(`${scheme}://`);
      if (!registered) continue;
      const located = spec.locate(registered.parsed, context);
      if (located !== null) roots.push(path.resolve(located));
    }
    return roots;
  }

  /**
   * Rendered `promptDoc` lines, registration order, for the schemes available
   * under `host`.
   */
  describe(host?: SchemeHost): string[] {
    const lines: string[] = [];
    for (const spec of this.#specs.values()) {
      const line = spec.promptDoc?.(host);
      if (line !== undefined) lines.push(line);
    }
    return lines;
  }

  /**
   * Resolve a registered internal URL through its handler, defaulting
   * `immutable` from the spec.
   */
  async resolve(
    input: string,
    context?: ResolveContext,
  ): Promise<InternalResource> {
    const registered = this.#required(input);
    const { path: bare } = this.split(input);
    const resource = await registered.spec.resolve(
      this.#at(registered, bare),
      context,
    );
    return {
      ...resource,
      immutable: resource.immutable ?? registered.spec.immutable,
    };
  }

  /**
   * Write a registered internal URL through its handler. `null`/a non-URL is
   * rejected — file writes are the tools' job, not the router's.
   */
  async write(
    input: string,
    content: string,
    context?: WriteContext,
  ): Promise<InternalWriteResult | void> {
    const registered = this.#required(input);
    const { path: bare } = this.split(input);
    const { spec } = registered;
    if (spec.write?.via !== 'handler' || !spec.applyWrite) {
      throw new Error(
        `${registered.scheme}:// URLs are read-only for handler writes`,
      );
    }
    return spec.applyWrite(this.#at(registered, bare), content, context);
  }

  #normalizeAlias(scheme: string, input: string): string {
    if (!this.#specs.get(scheme)?.singleSlashAlias) return input;
    return normalizeSingleSlashAlias(scheme, input);
  }

  #required(input: string): RegisteredUrl {
    const registered = this.#registered(input);
    if (registered) return registered;
    const scheme = splitScheme(this.normalize(input))?.scheme;
    if (!scheme) throw new Error(`Unknown internal URL: ${input}`);
    const available = Array.from(this.#specs.keys())
      .map((candidate) => `${candidate}://`)
      .join(', ');
    throw new Error(
      `Unknown protocol: ${scheme}://\nSupported: ${available || 'none'}`,
    );
  }

  /** Normalized hierarchical URL of a registered scheme, with its spec; undefined otherwise. */
  #registered(input: string): RegisteredUrl | undefined {
    if (!looksLikeInternalUrl(input)) return undefined;
    const url = this.normalize(input);
    const split = splitScheme(url);
    if (!split) return undefined;
    const spec = this.#specs.get(split.scheme);
    if (!spec) return undefined;
    const parsed: InternalUrl = {
      scheme: split.scheme,
      rest: split.rest,
      selector: undefined,
      isScheme: true,
      href: url,
    };
    return { url, scheme: split.scheme, spec, parsed };
  }

  /** The spec's view of `bare` — the URL with its selector chain peeled. */
  #at(registered: RegisteredUrl, bare: string): InternalUrl {
    const rest = bare.slice(bare.indexOf('://') + 3);
    return {
      scheme: registered.scheme,
      rest,
      selector: undefined,
      isScheme: true,
      href: bare,
    };
  }
}

let singleton: InternalUrlRouter | undefined;

/**
 * The process-wide router. The first caller gets an empty registry; a host
 * installs its schemes with {@link InternalUrlRouter.register}.
 */
export function internalUrlRouter(): InternalUrlRouter {
  singleton ??= new InternalUrlRouter();
  return singleton;
}

/** Replace the process-wide router (host bootstrap, tests). */
export function setInternalUrlRouter(
  router: InternalUrlRouter | undefined,
): void {
  singleton = router;
}

/** Build an isolated router from `specs` without touching the singleton. */
export function createInternalUrlRouter(
  specs: readonly SchemeSpec[] = [],
): InternalUrlRouter {
  return new InternalUrlRouter(specs);
}
