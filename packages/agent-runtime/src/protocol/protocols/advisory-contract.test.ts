import { describe, expect, it } from "vitest";

import type { AnswerFrame } from "../../grounding/answer-frame.js";
import { createUserAnalysisRequirements } from "../analysis-requirements.js";
import { validateAnalysisResult } from "../data-analysis-hooks.js";
import { createDataAnalysisProtocol, reduceDataAnalysisAction, type DataAnalysisState } from "./data-analysis.js";

// Shaped like wildfire-hard-6 (2026-10-09): the contract model labelled the answer a "comparison" and four
// intermediate totals "metric", so the commit demanded every total before the answer could be reported.
const requirements = createUserAnalysisRequirements([{
  kind: "metric",
  description: "Correlation of the yearly differences",
  acceptanceCriteria: ["One number to three decimals"],
  assertions: [
    {
      kind: "metric",
      description: "NOAA fires per year",
      sourceTables: ["fires"],
      sqlConstraints: [{ kind: "filter", column: "year", operator: "gte", value: 2000 }],
      resultChecks: [{ kind: "row_count", required: true, min: 20 }],
      claimValues: [{ name: "noaa_fires", field: "noaa_fires", required: true }]
    },
    {
      kind: "comparison",
      description: "correlation",
      sourceTables: ["fires", "stations"],
      sqlConstraints: [{
        kind: "join",
        tables: ["fires", "stations"],
        anyOf: [{ left: { table: "fires", column: "station_ref" }, right: { table: "stations", column: "nws_id" } }],
        condition: "fires.station_ref = stations.nws_id"
      }],
      claimValues: [{ name: "corr", field: "corr", required: false }]
    }
  ]
}]);

const FRAME: AnswerFrame = {
  warnings: [],
  decisions: [{
    aspect: "population",
    questionPhrase: "since 2000",
    options: [
      { label: "2000 onward", table: "fires", sqlWhere: "\"year\" >= 2000", keyColumns: ["year"], rows: 25, units: 25, status: "checked" },
      { label: "after 2000", table: "fires", sqlWhere: "\"year\" > 2000", keyColumns: ["year"], rows: 24, units: 24, status: "checked" }
    ]
  }]
};

const grounded = (advisory: boolean, frame = false): DataAnalysisState => {
  let state = createDataAnalysisProtocol([], requirements)
    .createInitialState({ contextPackageRef: { packageId: "p", revision: 0 }, runId: "run-advisory" });
  state = reduceDataAnalysisAction(state, "inspect_schema", { schema_id: "s", tables: [{ name: "fires" }, { name: "stations" }] });
  state = reduceDataAnalysisAction(state, "semantic.context.resolve", {
    mode: "live",
    trust: "verified",
    ...(frame
      ? { value: { evidence_grounding: { facts: [], candidates: [], duplicateTables: [], warnings: [], frame: FRAME, binding: { frame: true } } } }
      : {})
  });
  return reduceDataAnalysisAction(state, "analysis.contract.ground", { requirements, ...(advisory ? { advisory: true } : {}) });
};

const validated = (state: DataAnalysisState, sql: string, assertionIds: string[], frameChoices?: string[]) =>
  reduceDataAnalysisAction(
    reduceDataAnalysisAction(state, "data.query.plan", {
      sql,
      assertion_ids: assertionIds,
      ...(frameChoices ? { frame_choices: frameChoices } : {})
    }),
    "data.query.validate",
    { valid: true }
  );

// Execute, verify and bind the current attempt as the runtime does after a successful query.
const evidenced = (state: DataAnalysisState, values: Array<{ name: string; value: number; assertionId: string }>) => {
  const id = state.currentQueryAttemptId ?? "Q";
  let next = reduceDataAnalysisAction(state, "run_sql_readonly", {
    result: { artifact_id: `artifact-${id}`, audit_log_id: `audit-${id}`, columns: values.map((value) => value.name) }
  });
  next = reduceDataAnalysisAction(next, "analysis.result.validate", {
    valid: true,
    validation_findings: [],
    verified_values: values.map((value) => ({ ...value, tolerance: 0 }))
  });
  return reduceDataAnalysisAction(next, "analysis.evidence.bind", {
    artifact_id: `artifact-${id}`,
    audit_log_id: `audit-${id}`,
    evidence_refs: [`artifact-${id}`]
  });
};

const commit = (state: DataAnalysisState, values: Array<{ name: string; value: number }>) =>
  reduceDataAnalysisAction(state, "analysis.requirements.commit", {
    claims: [{ requirement_id: "R1", claim: "Correlation is 0.519", values }]
  });

describe("advisory contract", () => {
  it("turns the contract model's SQL rules into warnings but still blocks a join on another key", () => {
    const ruleBroken = validated(grounded(true), "SELECT COUNT(*) AS noaa_fires FROM fires", ["R1.A1"]);
    const wrongJoin = validated(
      grounded(true),
      "SELECT CORR(a, b) AS corr FROM fires f JOIN stations s ON f.station_ref = s.station_id",
      ["R1.A2"]
    );
    const strict = validated(grounded(false), "SELECT COUNT(*) AS noaa_fires FROM fires", ["R1.A1"]);

    expect(ruleBroken.currentQueryValidated).toBe(true);
    expect(ruleBroken.queryAttempts.at(-1)?.validationFindings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(wrongJoin.currentQueryValidated).toBe(false);
    expect(wrongJoin.queryAttempts.at(-1)?.validationFindings.find((finding) => finding.severity === "error")?.code)
      .toBe("SQL_SEMANTIC_JOIN_MISSING:fires:stations");
    expect(strict.currentQueryValidated).toBe(false);
  });

  it("commits the answer value without the values the contract listed, but never with no value", () => {
    let state = validated(
      grounded(true),
      "SELECT CORR(a, b) AS corr FROM fires f JOIN stations s ON f.station_ref = s.nws_id",
      ["R1.A2"]
    );
    state = evidenced(state, [{ name: "corr", value: 0.519, assertionId: "R1.A2" }]);

    expect(commit(state, [{ name: "corr", value: 0.519 }]).requirements.find((requirement) => requirement.id === "R1")?.status)
      .toBe("reported");
    expect(() => commit(state, [])).toThrow("ANALYSIS_CLAIM_VALUE_REQUIRED:R1: submit the answer value from a verified query; verified names: corr.");
    expect(() => commit(state, [{ name: "corr", value: 0.9 }])).toThrow(/ANALYSIS_CLAIM_VALUE_MISMATCH/u);
  });

  it("enforces the chosen frame reading on the query the committed value came from", () => {
    const side = validated(grounded(true, true), "SELECT COUNT(*) AS noaa_fires FROM fires", ["R1.A1"], ["F1.1"]);
    const skipped = evidenced(
      validated(side, "SELECT CORR(a, b) AS corr FROM fires f JOIN stations s ON f.station_ref = s.nws_id", ["R1.A2"]),
      [{ name: "corr", value: 0.5, assertionId: "R1.A2" }]
    );
    const applied = evidenced(
      validated(
        side,
        "SELECT CORR(a, b) AS corr FROM fires f JOIN stations s ON f.station_ref = s.nws_id WHERE \"year\" >= 2000",
        ["R1.A2"]
      ),
      [{ name: "corr", value: 0.519, assertionId: "R1.A2" }]
    );

    // A side query that ignores the reading still runs; only the answer's own query must follow it.
    expect(side.currentQueryValidated).toBe(true);
    expect(() => commit(skipped, [{ name: "corr", value: 0.5 }])).toThrow(/ANALYSIS_ANSWER_FRAME_MISMATCH:R1:corr/u);
    expect(commit(applied, [{ name: "corr", value: 0.519 }]).requirements.find((requirement) => requirement.id === "R1")?.status)
      .toBe("reported");
  });

  it("reports the contract's result checks as warnings", () => {
    const state = validated(grounded(true), "SELECT COUNT(*) AS noaa_fires FROM fires", ["R1.A1"]);
    const result = validateAnalysisResult(
      { result: { columns: ["noaa_fires"], rows: [[1]], row_count: 1, audit_log_id: "audit-1" } },
      {},
      state
    );

    expect(result.valid).toBe(true);
    expect(result.validation_findings).toEqual([expect.objectContaining({ severity: "warning" })]);
  });
});
