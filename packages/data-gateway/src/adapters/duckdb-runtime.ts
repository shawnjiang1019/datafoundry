import type * as DuckDbModule from "duckdb";

/**
 * Shared DuckDB process helpers.
 *
 * `new duckdb.Database(path)` opens the file asynchronously. Calling connect() before
 * that open settles hides a real failure (on Windows a second process holding the file
 * reports "IO Error: ... used by another process") behind the misleading
 * "Connection was never established or has been closed already". openDuckDb waits for
 * the open callback so callers see the actual cause.
 */
export const loadDuckDb = async (): Promise<typeof DuckDbModule> => {
  const loaded = await import("duckdb") as unknown as { default?: typeof DuckDbModule } & typeof DuckDbModule;
  return loaded.default ?? loaded;
};

export type DuckDbOpenOptions = {
  /**
   * Open the file read-only. Any number of processes can then read it at once, as long as
   * none holds it open read-write; writable opens allow one process per file.
   */
  readOnly?: boolean;
};

export const openDuckDb = async (path: string, options: DuckDbOpenOptions = {}): Promise<DuckDbModule.Database> => {
  const duckdb = await loadDuckDb();
  return await new Promise<DuckDbModule.Database>((resolve, reject) => {
    const settle = (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    };
    const database = options.readOnly
      ? new duckdb.Database(path, duckdb.OPEN_READONLY, settle)
      : new duckdb.Database(path, settle);
  });
};

/**
 * One open Database per file, shared by every query on it and kept for the lifetime of
 * the process.
 *
 * Written when DuckDB kept a process-level lock on a closed file: reopening the same path
 * failed with `IO Error: ... File is already open in <this process>`, so opening per query
 * failed from the second query onwards (the "Connection was already closed" errors seen
 * across the KramaBench runs). DuckDB 1.4.4 reopens a closed file (checked 2026-11-05), but
 * the handle is still opened once and reused: connections, not Databases, are the
 * per-query unit, and no query can find its database closed under it.
 *
 * Consequence for external writers: while this process has a .duckdb file open, another
 * process cannot open it read-write. Re-ingesting a file that is already in use needs a
 * new path or a restart. `:memory:` is never shared: each caller gets its own database.
 */
export type DuckDbHandle = {
  database: DuckDbModule.Database;
  release(): Promise<void>;
};

const shared = new Map<string, Promise<DuckDbModule.Database>>();
const noRelease = async (): Promise<void> => undefined;

export const acquireDuckDb = async (path: string, options: DuckDbOpenOptions = {}): Promise<DuckDbHandle> => {
  if (path === ":memory:") {
    const database = await openDuckDb(path);
    return { database, release: async () => duckDbCloseDatabase(database) };
  }
  const key = sharedKey(path, options);
  let pending = shared.get(key);
  if (!pending) {
    pending = openDuckDb(path, options);
    shared.set(key, pending);
    // A failed open must not be cached, so the next call can retry.
    pending.catch(() => shared.delete(key));
  }
  return { database: await pending, release: noRelease };
};

/** Read-only and writable handles to one file are different databases to DuckDB, so they are cached apart. */
const sharedKey = (path: string, options: DuckDbOpenOptions): string => options.readOnly ? `${path}\u0000readonly` : path;

/**
 * Close shared handles (shutdown, tests). A later acquire opens the file again.
 */
export const closeSharedDuckDb = async (path?: string): Promise<void> => {
  const entries = [...shared.entries()]
    .filter(([key]) => !path || key === sharedKey(path, {}) || key === sharedKey(path, { readOnly: true }));
  for (const [key, pending] of entries) {
    shared.delete(key);
    await pending.then((database) => duckDbCloseDatabase(database)).catch(() => undefined);
  }
};

export const duckDbRun = async (
  connection: DuckDbModule.Connection,
  sql: string,
  signal?: AbortSignal | undefined
): Promise<void> =>
  await new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(signal?.reason instanceof Error ? signal.reason : new Error("RUN_CANCELLED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    connection.run(sql, (error) => {
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

export const duckDbAll = async (
  connection: DuckDbModule.Connection,
  sql: string,
  signal?: AbortSignal | undefined
): Promise<DuckDbModule.TableData> =>
  await new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(signal?.reason instanceof Error ? signal.reason : new Error("RUN_CANCELLED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    connection.all(sql, (error, rows) => {
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve(rows);
      }
    });
  });

export const duckDbClose = async (connection: DuckDbModule.Connection): Promise<void> =>
  await new Promise((resolve, reject) => {
    connection.close((error) => error ? reject(error) : resolve());
  });

export const duckDbCloseDatabase = async (database: DuckDbModule.Database): Promise<void> =>
  await new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve());
  });
