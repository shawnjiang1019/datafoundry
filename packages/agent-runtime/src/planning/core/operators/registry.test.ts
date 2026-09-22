import { describe, expect, it } from "vitest";

import { PlannerError } from "../errors.js";
import {
  assertSixGates,
  EXECUTABLE_OPERATORS,
  executableOperator,
  KNOWN_OBLIGATIONS,
  OPERATOR_VOCABULARY
} from "./registry.js";

describe("operator registry", () => {
  it("carries the full D-Trail logical-plan vocabulary", () => {
    expect(OPERATOR_VOCABULARY.size).toBe(50);
    const byCategory = [...OPERATOR_VOCABULARY.values()].reduce<Record<string, number>>((counts, operator) => ({
      ...counts,
      [operator.category]: (counts[operator.category] ?? 0) + 1
    }), {});
    expect(byCategory).toEqual({ data: 18, analysis: 16, semantic: 5, control: 7, side_effect: 4 });
  });

  it("executes exactly the v1 read-only operator set", () => {
    expect([...EXECUTABLE_OPERATORS.keys()].sort()).toEqual([
      "aggregate", "compare", "composition", "contribution", "distribution", "filter", "growth_rate",
      "join", "limit", "project", "quantile", "rank", "scan", "sort", "trend", "window"
    ]);
  });

  it("admits every executable operator through all six gates", () => {
    expect(() => assertSixGates()).not.toThrow();
    for (const operator of EXECUTABLE_OPERATORS.values()) {
      expect(operator.obligations.every((obligation) => KNOWN_OBLIGATIONS.has(obligation))).toBe(true);
      expect(["none", "read"]).toContain(operator.sideEffectClass);
    }
  });

  it("keeps D-Trail's obligations for the data operators", () => {
    const obligations = (name: string) => [...(EXECUTABLE_OPERATORS.get(name)?.obligations ?? [])];
    expect(obligations("scan")).toEqual(["schema_matches_grounding", "row_budget"]);
    expect(obligations("join")).toEqual(["join_keys_exist", "join_cardinality", "row_budget"]);
    expect(obligations("filter")).toEqual(["filter_columns_exist", "filter_type_compatibility"]);
    expect(obligations("aggregate")).toEqual(["required_aggregation"]);
    expect(obligations("sort")).toEqual(["ordering"]);
    expect(obligations("limit")).toEqual(["result_row_limit"]);
  });

  it("distinguishes unknown, non-executable, and dialect-unsupported operators", () => {
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (error) {
        return error instanceof PlannerError ? error.code : String(error);
      }
    };
    expect(code(() => executableOperator("teleport", "duckdb"))).toBe("OPERATOR_UNKNOWN");
    expect(code(() => executableOperator("forecast", "duckdb"))).toBe("OPERATOR_NOT_EXECUTABLE");
    expect(code(() => executableOperator("sql", "duckdb"))).toBe("OPERATOR_NOT_EXECUTABLE");
    expect(code(() => executableOperator("quantile", "sqlite"))).toBe("OPERATOR_DIALECT_UNSUPPORTED");
    expect(executableOperator("quantile", "postgres").name).toBe("quantile");
  });
});
