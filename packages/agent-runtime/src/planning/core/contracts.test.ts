import { describe, expect, it } from "vitest";

import {
  analysisLogicalPlanSchema,
  analysisPhysicalPlanSchema,
  executableUnitSchema,
  groundedAnalysisTaskSchema
} from "./contracts.js";

describe("planning contracts", () => {
  it("fills logical-node defaults so plans round-trip through JSON", () => {
    const plan = analysisLogicalPlanSchema.parse({
      planId: "LP1",
      taskId: "run-1",
      skillId: "aggregate-lookup-v1",
      source: "model",
      outputNodeIds: ["n2"],
      nodes: [
        { nodeId: "n1", operator: "scan", parameters: { table: "orders" } },
        { nodeId: "n2", operator: "aggregate", inputs: ["n1"], satisfies: { requirementIds: ["R1"] } }
      ]
    });
    expect(plan.schemaVersion).toBe("1.0");
    expect(plan.nodes[0]).toMatchObject({ inputs: [], sideEffectClass: "none", verificationObligations: [] });
    expect(plan.nodes[1]?.satisfies).toEqual({ requirementIds: ["R1"], assertionIds: [] });
    expect(analysisLogicalPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("restricts physical executors to the compiled SQL dialects", () => {
    const base = {
      planId: "PP1",
      logicalPlanId: "LP1",
      taskId: "run-1",
      optimizer: "greedy-v1",
      estimate: { cost: 1, queries: 1, latencyMs: 1, risk: 0, value: 1 },
      nodes: [{ nodeId: "p_n1", logicalRef: "n1", executor: "sql:duckdb", operator: "scan", inputs: [], parameters: {}, estimatedCost: 1 }]
    };
    expect(analysisPhysicalPlanSchema.safeParse(base).success).toBe(true);
    const python = { ...base, nodes: [{ ...base.nodes[0], executor: "python" }] };
    expect(analysisPhysicalPlanSchema.safeParse(python).success).toBe(false);
  });

  it("requires a SHA-256 content hash on executable units", () => {
    const unit = {
      unitId: "u1",
      nodeId: "p_n1",
      executor: "sql:duckdb",
      role: "output",
      inputs: [],
      contentHash: "a".repeat(64),
      payload: {
        sql: "WITH n1 AS (SELECT 1) SELECT * FROM n1",
        dialect: "duckdb",
        limit: 100,
        datasourceId: "ds",
        datasourceRevision: "1",
        schemaFingerprint: "fp"
      }
    };
    expect(executableUnitSchema.parse(unit).compiledBy).toBe("cte-compiler-v1");
    expect(executableUnitSchema.safeParse({ ...unit, contentHash: "not-a-hash" }).success).toBe(false);
  });

  it("accepts a minimal grounded task", () => {
    const task = groundedAnalysisTaskSchema.parse({
      taskId: "run-1",
      intentText: "revenue by region",
      datasource: { id: "ds", dialect: "duckdb", revision: "1" },
      tables: [{ name: "orders", columns: [{ name: "region" }, { name: "revenue", type: "DOUBLE" }] }],
      schemaFingerprint: "fp",
      requirements: [{ id: "R1", description: "revenue by region", required: true }],
      eligibleBindings: { tables: ["orders"], columns: { orders: ["region", "revenue"] } }
    });
    expect(task.tables[0]?.columns[0]?.type).toBe("unknown");
    expect(task.semantic.warnings).toEqual([]);
  });
});
