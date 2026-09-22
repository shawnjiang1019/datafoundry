import { DatabaseSync } from "node:sqlite";

import { guardReadonlySql } from "@datafoundry/data-gateway";
import { describe, expect, it } from "vitest";

import { resolveDialect, type PlannerDialect, type PlannerDialectName } from "./dialect.js";
import { renderLiteral } from "./expressions.js";
import { EXECUTABLE_OPERATORS } from "./registry.js";
import { renderOrderBy, type AnyExecutableOperator, type ConformanceCase, type RenderInput } from "./types.js";

/**
 * Gate 6: every executable operator's conformance cases run on real engines (DuckDB,
 * SQLite), and every dialect's rendering passes the data-gateway read-only guard.
 */

type Row = Record<string, unknown>;

const loadDuckDb = async (): Promise<typeof import("duckdb")> => {
  const loaded = await import("duckdb") as unknown as { default?: typeof import("duckdb") } & typeof import("duckdb");
  return loaded.default ?? loaded;
};

/** Build the case query exactly as the compiler will: inputs as CTEs, operator body, top-level order. */
const caseQuery = (operator: AnyExecutableOperator, testCase: ConformanceCase, dialect: PlannerDialect): {
  sql: string;
  columns: string[];
} => {
  const isScan = operator.arity.max === 0;
  const inputs: RenderInput[] = isScan ? [] : testCase.inputs.map((table, index) => ({
    alias: `in${index}`,
    columns: table.columns,
    ...(table.ordering ? { ordering: table.ordering } : {})
  }));
  const rendered = operator.render(operator.parameterSchema.parse(testCase.parameters), {
    dialect,
    inputs,
    tableColumns: (table) => isScan && table === "source" ? testCase.inputs[0]?.columns : undefined
  });
  const inputCtes = inputs.map((input, index) => `${input.alias} AS (SELECT * FROM t${index})`);
  const orderBy = rendered.ordering
    ? ` ORDER BY ${renderOrderBy({ dialect, inputs: [], tableColumns: () => undefined }, {
        alias: "result",
        columns: rendered.columns
      }, rendered.ordering)}`
    : "";
  return {
    sql: `WITH ${[...inputCtes, `result AS (${rendered.sql})`].join(", ")} SELECT * FROM result${orderBy}`,
    columns: rendered.columns
  };
};

const createTableSql = (name: string, table: ConformanceCase["inputs"][number], dialect: PlannerDialect): string => {
  const columns = table.columns.map((column) => dialect.quoteIdent(column)).join(", ");
  const rows = table.rows
    .map((row) => `(${row.map((value) => renderLiteral(value as never, dialect)).join(", ")})`)
    .join(", ");
  return dialect.name === "sqlite"
    ? `CREATE TABLE ${name} (${columns}); INSERT INTO ${name} VALUES ${rows};`
    : `CREATE TABLE ${name} AS SELECT * FROM (VALUES ${rows}) AS v(${columns});`;
};

const tableNamesFor = (operator: AnyExecutableOperator, testCase: ConformanceCase): string[] =>
  testCase.inputs.map((_, index) => operator.arity.max === 0 ? "source" : `t${index}`);

const runDuckDb = async (setup: string, query: string): Promise<Row[]> => {
  const duckdb = await loadDuckDb();
  const database = new duckdb.Database(":memory:");
  try {
    await new Promise<void>((resolve, reject) => database.exec(setup, (error) => error ? reject(error) : resolve()));
    return await new Promise<Row[]>((resolve, reject) =>
      database.all(query, (error, rows) => error ? reject(error) : resolve(rows as Row[])));
  } finally {
    await new Promise<void>((resolve) => database.close(() => resolve()));
  }
};

const runSqlite = (setup: string, query: string): Row[] => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(setup);
    return database.prepare(query).all() as Row[];
  } finally {
    database.close();
  }
};

const normalize = (value: unknown): unknown => typeof value === "bigint" ? Number(value) : value;

const cellsEqual = (actual: unknown, expected: unknown): boolean => {
  const left = normalize(actual);
  if (typeof left === "number" && typeof expected === "number") {
    return Math.abs(left - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  }
  return left === expected;
};

const sortKey = (row: unknown[]): string => JSON.stringify(row.map(normalize));

const assertRows = (actual: Row[], testCase: ConformanceCase, columns: string[]): void => {
  expect(columns).toEqual(testCase.expected.columns);
  if (actual[0]) {
    expect(Object.keys(actual[0])).toEqual(testCase.expected.columns);
  }
  let rows = actual.map((row) => testCase.expected.columns.map((column) => normalize(row[column])));
  let expected = testCase.expected.rows;
  if (!testCase.expected.ordered) {
    rows = [...rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expected = [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }
  expect(rows.length, `row count\n${JSON.stringify(rows)}`).toBe(expected.length);
  rows.forEach((row, index) => {
    const want = expected[index] as unknown[];
    const matches = row.length === want.length && row.every((cell, cellIndex) => cellsEqual(cell, want[cellIndex]));
    expect(matches, `row ${index}: got ${JSON.stringify(row)}, want ${JSON.stringify(want)}`).toBe(true);
  });
};

const operators = [...EXECUTABLE_OPERATORS.values()];
const casesFor = (operator: AnyExecutableOperator, dialect: PlannerDialectName): ConformanceCase[] =>
  operator.dialects.includes(dialect)
    ? operator.conformance.filter((testCase) => !testCase.dialects || testCase.dialects.includes(dialect))
    : [];

describe.each(operators.map((operator) => [operator.name, operator] as const))("operator %s conformance", (_, operator) => {
  it.each(casesFor(operator, "duckdb").map((testCase) => [testCase.name, testCase] as const))(
    "duckdb: %s",
    async (__, testCase) => {
      const dialect = resolveDialect("duckdb");
      const query = caseQuery(operator, testCase, dialect);
      const setup = testCase.inputs
        .map((table, index) => createTableSql(tableNamesFor(operator, testCase)[index] as string, table, dialect))
        .join("\n");
      assertRows(await runDuckDb(setup, query.sql), testCase, query.columns);
    }
  );

  it.each(casesFor(operator, "sqlite").map((testCase) => [testCase.name, testCase] as const))(
    "sqlite: %s",
    (__, testCase) => {
      const dialect = resolveDialect("sqlite");
      const query = caseQuery(operator, testCase, dialect);
      const setup = testCase.inputs
        .map((table, index) => createTableSql(tableNamesFor(operator, testCase)[index] as string, table, dialect))
        .join("\n");
      assertRows(runSqlite(setup, query.sql), testCase, query.columns);
    }
  );

  it("renders guard-clean read-only SQL for every supported dialect", () => {
    for (const dialectName of operator.dialects) {
      const dialect = resolveDialect(dialectName);
      for (const testCase of casesFor(operator, dialectName)) {
        const { sql } = caseQuery(operator, testCase, dialect);
        const guard = guardReadonlySql(sql);
        expect(guard.allowed, `${dialectName} ${testCase.name}: ${guard.allowed ? "" : guard.reason}\n${sql}`).toBe(true);
      }
    }
  });
});
