import { guardReadonlySql } from "@datafoundry/data-gateway";
import { describe, expect, it } from "vitest";

import { PlannerError } from "../errors.js";
import { resolveDialect } from "./dialect.js";
import { exprSchema, predicateSchema, renderExpr, renderPredicate, type ExpressionScope } from "./expressions.js";

const scope = (dialect: string, columns = ["amount", "region", "day"]): ExpressionScope => ({
  dialect: resolveDialect(dialect),
  columns
});

const plannerCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof PlannerError ? error.code : String(error);
  }
};

describe("resolveDialect", () => {
  it("maps gateway dialect names and refuses the rest", () => {
    expect(resolveDialect("csv").name).toBe("duckdb");
    expect(resolveDialect("XLSX").name).toBe("duckdb");
    expect(resolveDialect("postgresql").name).toBe("postgres");
    expect(plannerCode(() => resolveDialect("snowflake"))).toBe("PLANNER_DIALECT_UNSUPPORTED");
    expect(plannerCode(() => resolveDialect(undefined))).toBe("PLANNER_DIALECT_UNSUPPORTED");
  });
});

describe("expression rendering", () => {
  it("accepts a bare string as a column reference", () => {
    expect(exprSchema.parse("amount")).toEqual({ kind: "column", name: "amount" });
  });

  it("escapes string literals per dialect, including MySQL backslashes", () => {
    const predicate = predicateSchema.parse({
      kind: "compare",
      op: "=",
      left: "region",
      right: { kind: "literal", value: "o'brien\\x" }
    });
    expect(renderPredicate(predicate, scope("duckdb"))).toBe(`("region" = 'o''brien\\x')`);
    expect(renderPredicate(predicate, scope("mysql"))).toBe("(`region` = 'o''brien\\\\x')");
  });

  it("quotes identifiers so embedded quotes cannot break out", () => {
    const tricky = 'a"b';
    expect(renderExpr({ kind: "column", name: tricky }, scope("postgres", [tricky]))).toBe('"a""b"');
  });

  it("renders division as real-valued and zero-safe", () => {
    expect(renderExpr(exprSchema.parse({ kind: "arith", op: "/", left: "amount", right: "amount" }), scope("sqlite")))
      .toBe('(CAST("amount" AS REAL) / NULLIF("amount", 0))');
  });

  it("rejects columns outside the node's input scope", () => {
    expect(plannerCode(() => renderExpr({ kind: "column", name: "secret" }, scope("duckdb")))).toBe("COLUMN_NOT_IN_SCOPE");
  });

  it("rejects malformed date literals and non-finite numbers", () => {
    expect(plannerCode(() => renderExpr({ kind: "date", value: "2024-13-45x" }, scope("duckdb")))).toBe("DATE_LITERAL_INVALID");
    expect(exprSchema.safeParse({ kind: "literal", value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("produces guard-clean SQL for date grains in every dialect", () => {
    for (const dialect of ["duckdb", "sqlite", "postgres", "mysql"]) {
      for (const grain of ["year", "quarter", "month", "week", "day"] as const) {
        const sql = renderExpr({ kind: "call", fn: "date_trunc", grain, args: [{ kind: "column", name: "day" }] }, scope(dialect));
        const guard = guardReadonlySql(`SELECT ${sql} AS d FROM t`);
        expect(guard.allowed, `${dialect}/${grain}: ${sql}`).toBe(true);
      }
    }
  });

  it("flags a MySQL identifier that collides with a guard keyword", () => {
    // Backtick-quoted names are not stripped by the gateway guard, so the compiler must
    // check every unit; this documents why that compile-time check exists.
    const sql = `SELECT ${renderExpr({ kind: "column", name: "set" }, scope("mysql", ["set"]))} FROM t`;
    expect(guardReadonlySql(sql).allowed).toBe(false);
    const quoted = `SELECT ${renderExpr({ kind: "column", name: "set" }, scope("duckdb", ["set"]))} FROM t`;
    expect(guardReadonlySql(quoted).allowed).toBe(true);
  });
});
