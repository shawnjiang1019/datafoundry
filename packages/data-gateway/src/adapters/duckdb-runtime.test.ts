import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  acquireDuckDb,
  closeSharedDuckDb,
  duckDbAll,
  duckDbClose,
  duckDbRun
} from "./duckdb-runtime.js";

const directory = mkdtempSync(join(tmpdir(), "duckdb-runtime-"));
const databasePath = join(directory, "test.duckdb");

afterAll(async () => {
  await closeSharedDuckDb();
  // The files stay locked for this process's lifetime, so removal is best-effort.
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Left for the OS temp sweeper.
  }
});

const query = async (path: string, sql: string): Promise<unknown[]> => {
  const handle = await acquireDuckDb(path);
  const connection = handle.database.connect();
  try {
    return await duckDbAll(connection, sql);
  } finally {
    await duckDbClose(connection);
    await handle.release();
  }
};

describe("acquireDuckDb", () => {
  it("serves repeated queries on one file", async () => {
    const handle = await acquireDuckDb(databasePath);
    const connection = handle.database.connect();
    await duckDbRun(connection, "CREATE TABLE t AS SELECT 1 AS a");
    await duckDbClose(connection);
    await handle.release();

    // Opening the file per query fails here: DuckDB still holds the process lock.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await query(databasePath, "SELECT a FROM t")).toEqual([{ a: 1 }]);
    }
  });

  it("serves concurrent queries on one file", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => query(databasePath, "SELECT a FROM t"))
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => [{ a: 1 }]));
  });

  it("reuses one handle per path and gives :memory: callers their own database", async () => {
    const first = await acquireDuckDb(databasePath);
    const second = await acquireDuckDb(databasePath);
    expect(second.database).toBe(first.database);
    await first.release();
    await second.release();

    const memoryA = await acquireDuckDb(":memory:");
    const memoryB = await acquireDuckDb(":memory:");
    expect(memoryB.database).not.toBe(memoryA.database);
    await memoryA.release();
    await memoryB.release();
  });

  it("reopens a file after its shared handle is closed", async () => {
    // DuckDB 1.4.4 releases the file on close() (checked 2026-11-05). This used to assert the
    // opposite, the lock that the shared handle was first written around.
    const scratchPath = join(directory, "closed.duckdb");
    await query(scratchPath, "SELECT 1 AS a");
    await closeSharedDuckDb(scratchPath);
    await expect(query(scratchPath, "SELECT 1 AS a")).resolves.toEqual([{ a: 1 }]);
  });

  it("reports the real open failure instead of a closed-connection error", async () => {
    // Connecting before the open settles turns "cannot open file" into the misleading
    // "Connection was never established or has been closed already".
    await expect(query(join(directory, "missing-dir", "x.duckdb"), "SELECT 1"))
      .rejects.toThrow(/IO Error|Cannot open/iu);
  });
});
