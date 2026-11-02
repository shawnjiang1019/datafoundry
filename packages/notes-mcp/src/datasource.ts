import type { GroundingSchema } from "@datafoundry/agent-runtime/grounding";
import { DuckDbAdapter, guardReadonlySql } from "@datafoundry/data-gateway";

/** Rows returned to an agent per query, the same cap DataFoundry's gateway applies. */
export const MAX_ROWS = 1000;

export type SqlRows = { columns: string[]; rows: unknown[][] };

/** A data source the notes service grounds and runs queries against, always read-only. */
export type NotesDatasource = {
  /** Also the cache key for facts read from the data, so it should change when the data does. */
  id: string;
  inspectSchema(): Promise<GroundingSchema>;
  query(sql: string, limit?: number): Promise<SqlRows>;
};

export class ReadonlySqlError extends Error {}

/**
 * A DuckDB file, read through DataFoundry's own DuckDB adapter and read-only guard, so the service
 * sees the same tables, names and types a DataFoundry run on the same file sees (the KramaBench
 * eval builds one such file per domain).
 *
 * The file is opened read-only, so any number of service processes can share it (on 2026-11-02 two
 * services on one file, each opening it writable, failed each other's queries on DuckDB's lock). A
 * process holding the file open writable, such as a DataFoundry server, still locks everyone out:
 * then point the service at a copy.
 */
export const duckDbDatasource = (path: string): NotesDatasource => {
  const adapter = new DuckDbAdapter({ path, read_only: true });
  return {
    id: path,
    inspectSchema: async () => {
      const summary = await adapter.inspectSchema();
      return {
        dialect: "duckdb",
        tables: summary.tables.map((table) => ({
          name: table.name,
          columns: table.columns.map((column) => ({ name: column.name, type: column.type }))
        }))
      };
    },
    query: async (sql, limit = MAX_ROWS) => {
      const guard = guardReadonlySql(sql);
      if (!guard.allowed) throw new ReadonlySqlError(guard.reason);
      const result = await adapter.runSqlReadonly({ sql: guard.normalized_sql, limit: Math.min(limit, MAX_ROWS) });
      return { columns: result.columns, rows: result.rows.map((row) => row.map(jsonSafe)) };
    }
  };
};

/**
 * DuckDB returns BIGINT values (COUNT(*) among them) as JavaScript BigInt, which JSON cannot carry,
 * so a tool result holding one would fail to send. Numbers in the safe range become numbers, larger
 * ones exact strings.
 */
const jsonSafe = (value: unknown): unknown => {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
};
