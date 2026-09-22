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

export const openDuckDb = async (path: string): Promise<DuckDbModule.Database> => {
  const duckdb = await loadDuckDb();
  return await new Promise<DuckDbModule.Database>((resolve, reject) => {
    const database = new duckdb.Database(path, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    });
  });
};

/**
 * One open Database per file, shared by every query on it and kept for the lifetime of
 * the process.
 *
 * DuckDB takes a process-level lock on a database file and never releases it back to
 * the same process: after close() (and even after a forced GC) reopening the same path
 * fails with `IO Error: ... File is already open in <this process>`. Opening per query
 * therefore fails from the second query onwards — the cause of the "Connection was
 * already closed" errors seen across the KramaBench runs. Connections, not Databases,
 * are the per-query unit, so the handle is opened once and reused.
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

export const acquireDuckDb = async (path: string): Promise<DuckDbHandle> => {
  if (path === ":memory:") {
    const database = await openDuckDb(path);
    return { database, release: async () => duckDbCloseDatabase(database) };
  }
  let pending = shared.get(path);
  if (!pending) {
    pending = openDuckDb(path);
    shared.set(path, pending);
    // A failed open must not be cached, so the next call can retry.
    pending.catch(() => shared.delete(path));
  }
  return { database: await pending, release: noRelease };
};

/**
 * Close shared handles (shutdown, tests). The paths stay unusable in this process
 * afterwards, since DuckDB will not reopen a file it has already opened.
 */
export const closeSharedDuckDb = async (path?: string): Promise<void> => {
  const entries = path
    ? (shared.has(path) ? [[path, shared.get(path) as Promise<DuckDbModule.Database>] as const] : [])
    : [...shared.entries()];
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
