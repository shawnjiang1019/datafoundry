import { describe, expect, it } from "vitest";

import {
  canonicalAssertionIds,
  createAnalysisAssertions,
  createManualAnalysisAssertion,
  resolveRequirementAssertions,
  type AnalysisAssertionDraft
} from "./analysis-contract.js";

describe("analysis contract", () => {
  it("assigns stable server-owned assertion ids and normalizes optional fields", () => {
    const drafts: AnalysisAssertionDraft[] = [{
      kind: "metric",
      description: "计算验证期负利润率",
      sourceTables: ["orders"],
      dimensions: ["region"],
      sqlConstraints: [
        { kind: "aggregate", function: "count", alias: "order_count" },
        {
          kind: "time_range",
          column: "order_date",
          start: "2023-07-01",
          end: "2023-12-31",
          endInclusive: true
        }
      ],
      resultChecks: [{ kind: "non_empty", required: true }],
      claimValues: [{ name: "order_count", field: "order_count", required: true, unit: "orders" }]
    }];

    expect(createAnalysisAssertions("R3", drafts)).toEqual([{
      id: "R3.A1",
      requirementId: "R3",
      kind: "metric",
      description: "计算验证期负利润率",
      required: true,
      sourceTables: ["orders"],
      dimensions: ["region"],
      sqlConstraints: drafts[0]?.sqlConstraints,
      resultChecks: drafts[0]?.resultChecks,
      claimValues: drafts[0]?.claimValues
    }]);
  });

  it("creates an explicit manual assertion instead of pretending an unexpressed requirement is verified", () => {
    expect(createManualAnalysisAssertion("R2", "判断运营策略是否合理")).toMatchObject({
      id: "R2.A1",
      requirementId: "R2",
      kind: "manual",
      description: "判断运营策略是否合理",
      required: true,
      sqlConstraints: [],
      resultChecks: [],
      claimValues: []
    });
  });

  it("rejects query assertion references outside the selected requirements", () => {
    const requirements = [{
      id: "R1",
      assertions: createAnalysisAssertions("R1", [{ kind: "metric", description: "计算订单数" }])
    }];

    expect(() => resolveRequirementAssertions(requirements, ["R1"], ["R2.A1"]))
      .toThrow("ANALYSIS_ASSERTION_NOT_FOUND:R2.A1");
  });

  it("requires every selected requirement to have a selected assertion", () => {
    const requirements = [{
      id: "R1",
      assertions: createAnalysisAssertions("R1", [{ kind: "metric", description: "计算订单数" }])
    }];

    expect(() => resolveRequirementAssertions(requirements, ["R1"], []))
      .toThrow("ANALYSIS_ASSERTION_IDS_REQUIRED:R1");
  });

  describe("canonicalAssertionIds", () => {
    // wildfire-hard-20, 2026-10-12: the agent wrote R1, R1.1, A1, R1_1 and F1.1 for R1.A1..R1.A6.
    const requirements = [{ id: "R1", assertions: createAnalysisAssertions("R1", [
      { kind: "metric", description: "a" },
      { kind: "filter", description: "b" }
    ]) }];

    it("accepts unambiguous variants of a server id", () => {
      expect(canonicalAssertionIds(requirements, ["R1.A1", "R1.1", "A2", "R1_1", "r1-a2"]))
        .toEqual(["R1.A1", "R1.A1", "R1.A2", "R1.A1", "R1.A2"]);
    });

    it("lists the valid ids, and points answer-frame ids to frame_choices", () => {
      expect(() => canonicalAssertionIds(requirements, ["R1"]))
        .toThrow("ANALYSIS_ASSERTION_NOT_FOUND:R1: valid assertion ids are R1.A1, R1.A2.");
      expect(() => canonicalAssertionIds(requirements, ["F1.1"]))
        .toThrow("F1.1 is an answer-frame reading: pass it in frame_choices, not assertion_ids.");
    });

    it("does not guess between requirements", () => {
      const two = [...requirements, { id: "R2", assertions: createAnalysisAssertions("R2", [{ kind: "metric", description: "c" }]) }];
      expect(() => canonicalAssertionIds(two, ["A1"])).toThrow(/ANALYSIS_ASSERTION_NOT_FOUND:A1/u);
      expect(canonicalAssertionIds(two, ["R2.1"])).toEqual(["R2.A1"]);
    });
  });
});
