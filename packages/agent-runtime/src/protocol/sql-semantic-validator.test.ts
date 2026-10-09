import { describe, expect, it } from "vitest";

import { createAnalysisAssertions } from "./analysis-contract.js";
import { validateSqlSemantics } from "./sql-semantic-validator.js";

describe("SQL semantic validator", () => {
  it("accepts SQL that satisfies source, aggregate, grain and inclusive end-date constraints", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "按大区计算完整验证期订单数",
      sourceTables: ["orders"],
      sqlConstraints: [
        { kind: "aggregate", function: "count", alias: "order_count" },
        { kind: "group_by", columns: ["region"] },
        {
          kind: "time_range",
          column: "order_date",
          start: "2023-07-01",
          end: "2023-12-31",
          endInclusive: true
        }
      ]
    }]);
    const sql = `
      SELECT region, COUNT(*) AS order_count
      FROM orders
      WHERE order_date >= '2023-07-01' AND order_date < '2024-01-01'
      GROUP BY region
    `;

    expect(validateSqlSemantics(sql, "sqlite", assertions)).toEqual([]);
  });

  it("accepts COUNT star when the grounded contract requires the star operand", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "计算订单总数",
      sourceTables: ["orders"],
      sqlConstraints: [{ kind: "aggregate", function: "COUNT", column: "*", alias: "order_count" }]
    }]);

    const findings = validateSqlSemantics(
      "SELECT COUNT(*) AS order_count FROM orders",
      "sqlite",
      assertions
    );

    expect(findings).toEqual([]);
  });

  it("rejects a query against the wrong source table", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "统计订单",
      sourceTables: ["orders"]
    }]);

    const findings = validateSqlSemantics("SELECT COUNT(*) FROM customers", "sqlite", assertions);

    expect(findings[0]?.code).toBe("SQL_SEMANTIC_SOURCE_MISSING:orders");
  });

  it("rejects an aggregate with the wrong function or alias", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "统计订单数",
      sqlConstraints: [{ kind: "aggregate", function: "count", alias: "order_count" }]
    }]);

    const findings = validateSqlSemantics("SELECT SUM(amount) AS order_count FROM orders", "sqlite", assertions);

    expect(findings[0]?.code).toBe("SQL_SEMANTIC_AGGREGATE_MISSING:count");
    expect(findings[0]?.message).toContain("Expected COUNT AS order_count");
    expect(findings[0]?.message).toContain("observed SUM(amount) AS order_count");
  });

  it("reports the exact expected and observed aliases for aggregate mismatches", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "统计订单数",
      sqlConstraints: [{ kind: "aggregate", function: "COUNT", column: "*", alias: "total_orders" }]
    }]);

    const findings = validateSqlSemantics(
      "SELECT COUNT(*) AS order_count FROM orders",
      "sqlite",
      assertions
    );

    expect(findings[0]?.message).toContain("Expected COUNT(*) AS total_orders");
    expect(findings[0]?.message).toContain("observed COUNT(*) AS order_count");
  });

  it("rejects a missing group-by grain", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "grain",
      description: "按大区统计",
      sqlConstraints: [{ kind: "group_by", columns: ["region"] }]
    }]);

    const findings = validateSqlSemantics("SELECT COUNT(*) FROM orders", "sqlite", assertions);

    expect(findings[0]?.code).toBe("SQL_SEMANTIC_GROUP_BY_MISSING:region");
  });

  it("rejects an inclusive end date that omits the final day", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "filter",
      description: "包含完整验证期",
      sqlConstraints: [{
        kind: "time_range",
        column: "order_date",
        start: "2023-07-01",
        end: "2023-12-31",
        endInclusive: true
      }]
    }]);
    const sql = "SELECT COUNT(*) FROM orders WHERE order_date >= '2023-07-01' AND order_date < '2023-12-31'";

    const findings = validateSqlSemantics(sql, "sqlite", assertions);

    expect(findings.map((finding) => finding.code)).toContain("SQL_SEMANTIC_TIME_END_MISSING:order_date");
  });

  it("returns a stable finding for unparseable SQL", () => {
    const findings = validateSqlSemantics("SELECT FROM", "sqlite", []);

    expect(findings[0]?.code).toBe("SQL_SEMANTIC_PARSE_FAILED");
    expect(findings[0]?.severity).toBe("warning");
  });

  it("parses DuckDB SQL with PostgreSQL syntax", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "count fires",
      sourceTables: ["fires"],
      sqlConstraints: [{ kind: "aggregate", function: "count", alias: "n" }]
    }]);
    const sql = `SELECT COUNT(*) AS n FROM "fires" WHERE "Acres"::DOUBLE > 100 AND "Name" ILIKE '%creek%'`;

    expect(validateSqlSemantics(sql, "duckdb", assertions)).toEqual([]);
  });

  it("reads PostgreSQL-shaped column references in DuckDB filters, groups and aggregates", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "median variants per histologic type",
      sourceTables: ["samples"],
      sqlConstraints: [
        { kind: "column", column: "Log2_variant" },
        { kind: "filter", column: "Histologic type", operator: "eq", value: "Serous" },
        { kind: "filter", column: "year", operator: "gte", value: 2000 },
        { kind: "group_by", columns: ["Histologic type"] },
        { kind: "aggregate", function: "MEDIAN", column: "Log2_variant", alias: "median_variant" },
        { kind: "aggregate", function: "COUNT", column: "sample_id", alias: "n" }
      ]
    }]);
    const sql = `
      SELECT "Histologic type", MEDIAN(Log2_variant) AS median_variant, COUNT(sample_id) AS n
      FROM samples
      WHERE "Histologic type" = 'Serous' AND year >= 2000
      GROUP BY "Histologic type"
    `;

    expect(validateSqlSemantics(sql, "duckdb", assertions)).toEqual([]);
  });

  const yearlyFires = createAnalysisAssertions("R1", [{
    kind: "metric",
    description: "average yearly fires since 2000",
    sourceTables: ["nifc_wildfires"],
    sqlConstraints: [
      { kind: "filter", column: "Year", operator: "gte", value: 2000 },
      { kind: "group_by", columns: ["Year"] },
      { kind: "aggregate", function: "MAX", column: "Fires" }
    ]
  }]);

  it("finds constraints satisfied inside a FROM subquery", () => {
    const sql = `
      SELECT AVG(yearly) AS avg_fires
      FROM (SELECT Year, MAX(Fires) AS yearly FROM nifc_wildfires WHERE Year >= 2000 GROUP BY Year) t
    `;

    expect(validateSqlSemantics(sql, "duckdb", yearlyFires)).toEqual([]);
  });

  it("finds constraints satisfied inside a CTE", () => {
    const sql = `
      WITH yearly AS (SELECT Year, MAX(Fires) AS fires FROM nifc_wildfires WHERE Year >= 2000 GROUP BY Year)
      SELECT AVG(fires) AS avg_fires FROM yearly
    `;

    expect(validateSqlSemantics(sql, "duckdb", yearlyFires)).toEqual([]);
  });

  it("matches an aggregate wrapped in, and wrapping, cleanup expressions", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "average elevation",
      sourceTables: ["stations"],
      sqlConstraints: [{ kind: "aggregate", function: "AVG", column: "Elevation", alias: "avg_elevation" }]
    }]);

    const findings = validateSqlSemantics(
      `SELECT ROUND(AVG(CAST(REPLACE("Elevation", ',', '') AS DOUBLE)), 1) AS avg_elevation FROM stations`,
      "duckdb",
      assertions
    );

    expect(findings).toEqual([]);
  });

  it("treats QUANTILE_CONT(x, 0.5) as MEDIAN and reads CORR", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "median and correlation",
      sourceTables: ["samples"],
      sqlConstraints: [
        { kind: "aggregate", function: "MEDIAN", column: "variant", alias: "median_variant" },
        { kind: "aggregate", function: "CORR", column: "hec", alias: "size_vs_wind" }
      ]
    }]);
    const sql = "SELECT quantile_cont(variant, 0.5) AS median_variant, corr(hec, wind) AS size_vs_wind FROM samples";

    expect(validateSqlSemantics(sql, "duckdb", assertions)).toEqual([]);
  });

  describe("inclusive year ranges", () => {
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "fires per year 2000-2030",
      sourceTables: ["fires"],
      sqlConstraints: [{ kind: "time_range", column: "start_year", start: "2000", end: "2030", endInclusive: true }]
    }]);
    const codes = (where: string) => validateSqlSemantics(
      `SELECT start_year, COUNT(*) AS n FROM fires WHERE ${where} GROUP BY start_year`,
      "duckdb",
      assertions
    ).map((finding) => finding.code);

    it("accepts <= end year, < end year + 1, and BETWEEN", () => {
      expect(codes("start_year >= 2000 AND start_year <= 2030")).toEqual([]);
      expect(codes("start_year >= 2000 AND start_year < 2031")).toEqual([]);
      expect(codes("start_year BETWEEN 2000 AND 2030")).toEqual([]);
    });

    it("rejects an end that leaves out the last year", () => {
      expect(codes("start_year >= 2000 AND start_year < 2030")).toEqual(["SQL_SEMANTIC_TIME_END_MISSING:start_year"]);
    });
  });

  it("still rejects a filter on a different value inside a subquery", () => {
    const sql = `
      SELECT AVG(yearly) AS avg_fires
      FROM (SELECT Year, MAX(Fires) AS yearly FROM nifc_wildfires WHERE Year >= 1990 GROUP BY Year) t
    `;

    expect(validateSqlSemantics(sql, "duckdb", yearlyFires).map((finding) => finding.code))
      .toEqual(["SQL_SEMANTIC_FILTER_MISSING:Year:gte"]);
  });

  it("resolves an aggregated column through a CTE rename", () => {
    // wildfire-hard-17, 2026-10-08: COUNT(nws_id) over a CTE that renames "NWS ID" was rejected.
    const assertions = createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "stations used",
      sourceTables: ["raws"],
      sqlConstraints: [{ kind: "aggregate", function: "COUNT", column: "NWS ID", alias: "matched_rows" }]
    }]);
    const sql = `WITH ra AS (SELECT DISTINCT TRY_CAST(TRIM(CAST("NWS ID" AS VARCHAR)) AS DOUBLE) AS nws_id FROM raws)
      SELECT COUNT(nws_id) AS matched_rows FROM ra`;

    expect(validateSqlSemantics(sql, "duckdb", assertions)).toEqual([]);
  });

  it("reads a distinct count however the contract spells it", () => {
    // wildfire-hard-17, 2026-10-09: "COUNT DISTINCT" never matched COUNT(DISTINCT x), 13 rejections in a row.
    const contract = (spelled: string) => createAnalysisAssertions("R1", [{
      kind: "metric",
      description: "stations",
      sourceTables: ["raws"],
      sqlConstraints: [{ kind: "aggregate", function: spelled, column: "NWS ID", alias: "stations" }]
    }]);
    const distinct = `SELECT COUNT(DISTINCT "NWS ID") AS stations FROM raws`;

    for (const spelled of ["COUNT DISTINCT", "count(distinct)", "COUNT_DISTINCT"]) {
      expect(validateSqlSemantics(distinct, "duckdb", contract(spelled))).toEqual([]);
    }
    expect(validateSqlSemantics(`SELECT COUNT("NWS ID") AS stations FROM raws`, "duckdb", contract("COUNT DISTINCT"))[0]?.message)
      .toBe("Expected COUNT(DISTINCT nws id) AS stations, but observed COUNT(nws id) AS stations.");
    expect(validateSqlSemantics(distinct, "duckdb", contract("COUNT"))).toEqual([]);
  });
});
