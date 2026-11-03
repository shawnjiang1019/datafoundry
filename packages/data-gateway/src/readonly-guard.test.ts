import { describe, expect, it } from "vitest";

import { guardReadonlySql } from "./readonly-guard.js";

describe("guardReadonlySql", () => {
  it("allows read-only statements", () => {
    expect(guardReadonlySql("SELECT 1").allowed).toBe(true);
    expect(guardReadonlySql("WITH t AS (SELECT 1 AS a) SELECT * FROM t").allowed).toBe(true);
  });

  it("blocks statements that write or change session state", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "SELECT 1; DROP TABLE t",
      "CREATE OR REPLACE VIEW v AS SELECT 1",
      "REPLACE INTO t VALUES (1)",
      "SET memory_limit = '1GB'",
      "ATTACH 'other.db'",
      "CALL pragma_database_list()",
      "SELECT * FROM t; SELECT * FROM u"
    ]) {
      expect(guardReadonlySql(sql).allowed, sql).toBe(false);
    }
  });

  it("allows REPLACE used as a scalar function", () => {
    // Blocking this cost 55 queries in the KramaBench runs: agents strip thousands
    // separators with REPLACE(col, ',', '') and were forced into workarounds.
    const result = guardReadonlySql(`SELECT TRY_CAST(REPLACE("amount", ',', '') AS BIGINT) AS n FROM "t"`);
    expect(result.allowed).toBe(true);
    expect(guardReadonlySql("SELECT replace(a, 'x', 'y') FROM t").allowed).toBe(true);
    expect(guardReadonlySql("SELECT REPLACE (a, 'x', 'y') FROM t").allowed).toBe(true);
  });

  it("still blocks a keyword that only looks like a call site", () => {
    expect(guardReadonlySql("SELECT 1 FROM t WHERE x = 1 REPLACE INTO u VALUES (1)").allowed).toBe(false);
  });
});
