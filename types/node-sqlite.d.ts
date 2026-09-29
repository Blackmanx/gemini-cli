/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type declarations for `node:sqlite`.
 *
 * The module is experimental and its types arrived in `@types/node` 22. This
 * workspace pins `@types/node` 20 per-package, so whether `node:sqlite`
 * typechecks has been depending on which copy of the types happened to be
 * hoisted where - the same source compiled clean under `packages/core` and
 * failed under `packages/a2a-server`. A build should not depend on that.
 *
 * The shapes here are taken from the running engine (Node 22), not from
 * documentation, because getting them wrong is worse than not having them:
 * a wrong declaration type-checks code that then fails at runtime. In
 * particular `StatementSync.sourceSQL` is a real getter and `columns()` is a
 * real method - both are used on the empty-result path, and a shim that
 * omitted them made that path a latent `TypeError`.
 *
 * It lives at the workspace root and is listed in the root tsconfig's
 * `files`, which every package inherits even when it overrides `include`.
 * When the repo pins `@types/node` 22, delete this file.
 */
declare module 'node:sqlite' {
  /** A value SQLite accepts as a bound parameter. */
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  /** A value SQLite can return in a cell. */
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  /** One column of a result set, as `StatementSync.columns()` reports it. */
  export interface ColumnMetadata {
    /** The underlying column name, or `null` for an expression. */
    column: string | null;
    /** The name the result column is addressed by. */
    name: string;
    /** Declared type, or `null`. */
    type: string | null;
    /** Schema the column lives in. */
    database: string | null;
    /** Table the column lives in. */
    table: string | null;
  }

  export interface StatementSync {
    /** The statement text this statement was prepared from. */
    readonly sourceSQL: string;
    /** The result columns, available before any row is fetched. */
    columns(): ColumnMetadata[];
    /** Run a statement that changes rows. */
    run(...params: SQLInputValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    /** Run a query and return every row. */
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    /** Run a query and return the first row, or `undefined`. */
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    /** Iterate the result rows. */
    iterate(
      ...params: SQLInputValue[]
    ): IterableIterator<Record<string, SQLOutputValue>>;
    /** Accept named parameters without the `:`/`@`/`$` sigil. */
    setAllowBareNamedParameters(enabled: boolean): void;
    /** Accept parameters the statement does not declare. */
    setAllowUnknownNamedParameters(enabled: boolean): void;
    /** Return `BIGINT` cells as `bigint` rather than losing precision. */
    setReadBigInts(enabled: boolean): void;
    /** Return rows as arrays rather than objects. */
    setReturnArrays(enabled: boolean): void;
  }

  export interface DatabaseSyncOptions {
    /** Open the file read-only. */
    readOnly?: boolean;
    /** Create the file if it is missing. */
    open?: boolean;
    /** Enforce foreign key constraints. */
    enableForeignKeyConstraints?: boolean;
    /** Allow a read-only connection to share a cache. */
    readOnlyAllowSharedCache?: boolean;
    /** How long to wait on a locked database, in milliseconds. */
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    /** Prepare a statement. */
    prepare(source: string): StatementSync;
    /** Run one or more statements, discarding any results. */
    exec(source: string): void;
    /** Close the database. */
    close(): void;
    /** The file or `:memory:` this handle is bound to. */
    readonly location: string;
    /** Run a function inside a transaction, rolling back if it throws. */
    transaction<T extends (...args: never[]) => unknown>(
      fn: T,
    ): (...args: Parameters<T>) => ReturnType<T>;
    /** Open a backup of this database at `destination`. */
    backup(destination: string): Promise<number>;
  }
}
