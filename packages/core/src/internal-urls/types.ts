/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type model for the internal URL subsystem: the layer that lets `read
 * pr://1428`, `grep` walking `agent://x/output`, and `write conflict://1`
 * travel through the same tools that handle `src/foo.ts`.
 *
 * A scheme is described by a {@link SchemeSpec}. The spec is the single
 * declaration of what a scheme IS (backing, selector grammar, mutability,
 * approval tier) and carries the handler hooks that produce its content. The
 * router in `./router.ts` is registration-driven: it never knows a scheme by
 * name, only through the specs it is handed.
 */
import type { ParsedInternalUrl } from './parse.js';

/**
 * How a scheme's resources exist.
 * - `file`: the resolved content is the byte-identical content of the file the
 *   handler's `locate` returns; `read` routes located URLs through its
 *   filesystem pipeline (paging, images, sqlite, archives).
 * - `virtual`: content is rendered by the handler (it may still `locate` a
 *   backing file for search/bash).
 * - `remote`: content lives on another host or service; never locatable.
 * - `device`: session-bound control surface (processes, tool devices).
 */
export type SchemeBacking = 'file' | 'virtual' | 'remote' | 'device';

/**
 * Read-selector grammar carried after the URL.
 * - `lines`: any trailing `:<selector>` chain is a read selector
 *   (`artifact://3:raw:1-50`).
 * - `none`: never peel; the URL is passed through as written.
 * - `opaque`: server-defined URIs that may legitimately end in
 *   selector-shaped tails (`mcp://`).
 */
export type SchemeSelectors = 'lines' | 'none' | 'opaque';

/**
 * Mutation class of a writable scheme; drives plan-mode and device-only
 * `write` gates.
 * - `workspace`: mutates user/external state; blocked in plan mode and
 *   device-only sessions.
 * - `sandbox`: session scratch space; allowed in plan mode.
 * - `coordination`: peer messaging; always allowed.
 * - `device`: tool-device dispatch; always allowed, the device enforces its own
 *   policy.
 */
export type SchemeWriteScope =
  | 'workspace'
  | 'sandbox'
  | 'coordination'
  | 'device';

/** Capability tier a tool call exercises; determines which approvals cover it. */
export type ToolTier = 'read' | 'write' | 'exec';

/** Ordering of capability tiers, least to most privileged. */
export const TIER_RANK: Readonly<Record<ToolTier, number>> = {
  read: 0,
  write: 1,
  exec: 2,
};

/** A parsed internal URL plus the exact input it was parsed from. */
export interface InternalUrl extends ParsedInternalUrl {
  /** Exact input string this URL was parsed from, before any normalization. */
  readonly href: string;
}

/**
 * Session facts handed to {@link SchemeSpec.promptDoc} to decide which schemes
 * the system prompt advertises. Opaque to the router — the host owns its shape.
 */
export type SchemeHost = Readonly<Record<string, unknown>>;

/** Options for {@link SchemeSpec.locate}. */
export interface LocateOptions {
  /**
   * Locate the containing directory form where a scheme distinguishes it
   * (`skill://<name>` → the skill base dir, not SKILL.md).
   */
  directory?: boolean;
  /**
   * Return the path even when the entry does not exist yet (write/bash
   * targets). Never creates anything.
   */
  create?: boolean;
}

/**
 * Caller-supplied context the router threads into scheme handlers. Every field
 * is optional so a caller that knows only a working directory stays valid.
 */
export interface ResolveContext {
  /** Working directory of the calling session. */
  cwd?: string;
  /** Calling session's session file, when it has one. */
  sessionFile?: string;
  /** Calling session's stable session-manager id. */
  sessionId?: string;
  /** Caller's abort signal. */
  signal?: AbortSignal;
  /** Calling tool session; session-bound schemes require it. */
  session?: unknown;
  /**
   * When set, a handler that would otherwise materialize an expensive
   * directory listing returns the directory shape (`isDirectory: true`) with
   * empty content instead.
   */
  skipDirectoryListing?: boolean;
}

/**
 * Caller context for writes dispatched to a scheme's `applyWrite` hook. Mirrors
 * {@link ResolveContext} so handlers sharing read/write state accept one shape.
 */
export interface WriteContext {
  /** Working directory of the calling session. */
  cwd?: string;
  /** Caller's abort signal. */
  signal?: AbortSignal;
  /** Calling tool session; session-bound writes require it. */
  session?: unknown;
}

/**
 * Transcript-only render state a handler write attaches to the `write` tool
 * result.
 */
export interface InternalWriteDetails {
  /** Short label rendered instead of the URL in the transcript. */
  label?: string;
  /** Extra lines rendered under the result. */
  notes?: string[];
}

/**
 * Model-facing result of a handler-owned write. Replaces the `write` tool's
 * default "Successfully wrote N bytes" result verbatim.
 */
export interface InternalWriteResult {
  /** Text shown to the model in place of the default result. */
  content: string;
  /** Transcript-only render state; never shown to the model. */
  details?: InternalWriteDetails;
}

/**
 * Raw resource payload returned by a scheme's `resolve` hook. The router
 * defaults `immutable` from {@link SchemeSpec.immutable}, so a handler sets it
 * only to override the scheme default for one URL.
 */
export interface InternalResource {
  /** Canonical URL that was resolved. */
  url: string;
  /** Resolved text content. */
  content: string;
  /** MIME type. */
  contentType: 'text/markdown' | 'application/json' | 'text/plain';
  /** Content size in bytes. */
  size?: number;
  /** Underlying filesystem path (for debugging, not exposed to the model). */
  sourcePath?: string;
  /** Additional notes about resolution. */
  notes?: string[];
  /**
   * `value` marks a discrete extracted value (`agent://<id>/<json-path>`) that
   * `read` returns as-is: no line selectors, no paging. Default `document`.
   */
  shape?: 'document' | 'value';
  /**
   * True when the content cannot be edited by the agent (sealed artifacts,
   * harness docs, machine-generated summaries). Edit affordances are suppressed
   * for immutable resources.
   */
  immutable?: boolean;
  /**
   * True when the resource is a directory listing rather than file content.
   * `search` refuses to grep such a resource when it has no `sourcePath` — a
   * remote listing has no local path to recurse, so its text must never be
   * mistaken for the directory's contents.
   */
  isDirectory?: boolean;
}

/** Write policy for a writable scheme. Absent on read-only schemes. */
export interface SchemeWritePolicy {
  /**
   * Who performs the write.
   * - `file`: tools (`write`, `edit`, `ast_edit`) write the file `locate`
   *   returns with `{ create: true }`; no `applyWrite` hook exists.
   * - `handler`: {@link SchemeSpec.applyWrite} performs it (messages, stdin,
   *   settings, remote hosts, devices); file-editing tools refuse the URL even
   *   when it locates a backing file.
   */
  via: 'file' | 'handler';
  /**
   * `text`: model-authored text; `write` strips copied display prefixes and,
   * unless the scheme is a `device`, rejects content that ends with a
   * read-truncation notice. `verbatim`: raw payload; neither transform
   * applies.
   */
  payload: 'text' | 'verbatim';
  scope: SchemeWriteScope;
  /**
   * Approval tier for `write`/`edit`/`ast_edit` targeting this URL. Synchronous
   * and total: a scheme that cannot decide must return `exec` (fail closed).
   */
  tier(
    url: InternalUrl,
    content: string | undefined,
    session: unknown,
  ): ToolTier;
  /** True when `write` may omit `content` for this URL (`proc://<id>/kill`). */
  contentOptional?(url: InternalUrl): boolean;
}

/**
 * Declared facts about a scheme, plus the hooks that produce its content.
 * Consumed by tools (routing, approval, gates), the TUI (selector peeling,
 * transcript cards) and renderers (hyperlinks).
 */
export interface SchemeSpec {
  /** The scheme this spec serves, without `://`. Matched case-insensitively. */
  readonly scheme: string;
  backing: SchemeBacking;
  selectors: SchemeSelectors;
  /** Default immutability of resolved resources; a resource may override it. */
  immutable: boolean;
  /** A trailing `:N` with no path after the authority is a port, not a selector (`ssh://host:2222`). */
  portAuthority?: boolean;
  /** The authority is the first path segment under one root (`local://a/b`), so a glob may start there. */
  pathAuthority?: true;
  /** Resources are session artifact storage; located read pages skip the artifact spill. */
  artifactStore?: true;
  /** Approval tier for reading/searching this scheme. Default `read`. */
  defaultReadTier?: ToolTier;
  /** Read output bypasses result truncation limits. */
  unbounded?: boolean;
  /** Renderers may call `locate` to hyperlink these URLs: local, cheap, never spawns or fetches. */
  linkable?: boolean;
  /** Transcript read cards collapse like plain files instead of expanding. */
  compactTranscript?: boolean;
  /** `read` peels a trailing `?q=<question>` as an image question. */
  imageQuestion?: true;
  /** The single-slash `scheme:/x` spelling is an alias of `scheme://x`. */
  singleSlashAlias?: true;
  write?: SchemeWritePolicy;
  /**
   * Resolve an internal URL to its content. The router defaults
   * {@link InternalResource.immutable} from {@link SchemeSpec.immutable}.
   * Throws an `Error` with a user-friendly message when resolution fails.
   */
  resolve(url: InternalUrl, context?: ResolveContext): InternalResource;
  /**
   * Absolute path of the local file or directory backing `url`, without
   * materializing content. `null` when the URL has no local backing (a
   * virtual/remote target, or a missing entry without
   * {@link LocateOptions.create}). Throws on malformed URLs and containment
   * violations with the same messages `resolve` uses.
   */
  locate?(
    url: InternalUrl,
    context?: ResolveContext,
    options?: LocateOptions,
  ): string | null;
  /**
   * Handler-owned write. Present exactly when `write.via` is `handler` (the
   * router enforces this at registration).
   */
  applyWrite?(
    url: InternalUrl,
    content: string,
    context?: WriteContext,
  ): InternalWriteResult | void;
  /**
   * Expand a virtual container URL into its searchable leaf documents for
   * `grep`/`find`. Leaf `url`s must round-trip through `resolve`.
   */
  enumerate?(
    url: InternalUrl,
    context?: ResolveContext,
  ): Array<{ url: string; content: string }>;
  /**
   * One-line system-prompt entry when the scheme is usable in the session
   * described by `host`; `undefined` omits the scheme.
   */
  promptDoc?(host?: SchemeHost): string | undefined;
}
