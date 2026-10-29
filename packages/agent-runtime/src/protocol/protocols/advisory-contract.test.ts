import { describe, expect, it } from "vitest";

import { renderAnswerFrame, type AnswerFrame } from "../../grounding/answer-frame.js";
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
      { label: "after 2000", table: "fires", sqlWhere: "\"year\" > 2000", keyColumns: ["year"], rows: 24, units: 24, status: "checked" },
      // A linked reading gives the decision the strong evidence it needs to be shown.
      { label: "fires near a station", table: "fires", sqlWhere: "\"year\" >= 2000 AND EXISTS (SELECT 1 FROM \"stations\")", keyColumns: ["year"], rows: 20, units: 20, status: "checked" }
    ]
  }]
};

// Bound options are shown in a seeded order; find the "2000 onward" reading's id as the agent would.
const onwardChoice = (() => {
  const bound = renderAnswerFrame(FRAME, { binding: true }) as { decisions: Array<{ options: Array<{ id: string; reading: string }> }> };
  const id = bound.decisions[0]?.options.find((option) => option.reading === "2000 onward")?.id ?? "";
  return { id, choice: `${id}: since 2000, including 2000` };
})();

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
    const side = validated(grounded(true, true), "SELECT COUNT(*) AS noaa_fires FROM fires", ["R1.A1"], [onwardChoice.choice]);
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

  it("keeps a one-row result committable by column name when the contract's own claim field is missing", () => {
    // wildfire, 2026-10-12: a missing contract field emptied the verified values, so 8 of 12 bound runs
    // could not commit anything ("allowed names: none").
    const state = validated(grounded(true), "SELECT COUNT(*) AS n_fires FROM fires", ["R1.A1"]);
    const result = validateAnalysisResult(
      { result: { columns: ["n_fires"], rows: [[42]], row_count: 1, audit_log_id: "audit-1" } },
      {},
      state
    );

    expect(result.valid).toBe(true);
    expect(result.verified_values).toEqual([expect.objectContaining({ name: "n_fires", value: 42, assertionId: "R1.A1" })]);
  });

  it("makes each cell of a small grouped result committable as <column>[<row label>]", () => {
    // wildfire-hard-18, 2026-10-12: a two-group comparison had nothing committable, so the run ended uncommitted.
    const state = validated(grounded(true), "SELECT strategy, AVG(duration) AS avg_duration FROM fires GROUP BY 1", ["R1.A1"]);
    const result = validateAnalysisResult(
      { result: { columns: ["strategy", "avg_duration"], rows: [["Full Suppression", 51.83], ["Other", 12.31]], row_count: 2, audit_log_id: "audit-2" } },
      {},
      state
    );
    const many = validateAnalysisResult(
      { result: { columns: ["strategy", "n"], rows: Array.from({ length: 11 }, (_, index) => [`s${index}`, index]), row_count: 11, audit_log_id: "audit-3" } },
      {},
      state
    );

    expect(result.verified_values).toEqual([
      expect.objectContaining({ name: "avg_duration[Full Suppression]", value: 51.83 }),
      expect.objectContaining({ name: "avg_duration[Other]", value: 12.31 })
    ]);
    expect(many.verified_values).toEqual([]);
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

  it("asks for the frame choice even when the contract fell back to manual, and records the reading as a warning", () => {
    // legal-hard-1, 2026-10-09: the contract failed validation, so the frame's correct reading was never chosen.
    const manual = createUserAnalysisRequirements([{
      kind: "metric",
      description: "Average reports for large metro areas",
      acceptanceCriteria: ["One number"]
    }]);
    let state = createDataAnalysisProtocol([], manual)
      .createInitialState({ contextPackageRef: { packageId: "p", revision: 0 }, runId: "run-manual" });
    state = reduceDataAnalysisAction(state, "inspect_schema", { schema_id: "s", tables: [{ name: "fires" }] });
    state = reduceDataAnalysisAction(state, "semantic.context.resolve", {
      mode: "live",
      trust: "verified",
      value: { evidence_grounding: { facts: [], candidates: [], duplicateTables: [], warnings: [], frame: FRAME, binding: { frame: true } } }
    });
    state = reduceDataAnalysisAction(state, "analysis.contract.ground", { requirements: manual, advisory: true });
    const plan = (frameChoices?: string[]) => reduceDataAnalysisAction(state, "data.query.plan", {
      sql: "SELECT COUNT(*) AS n FROM fires",
      requirement_ids: ["R1"],
      ...(frameChoices ? { frame_choices: frameChoices } : {})
    });

    expect(state.requirements.find((requirement) => requirement.id === "R1")?.assertions.map((assertion) => assertion.kind))
      .toEqual(["manual"]);
    expect(() => plan()).toThrow(/ANALYSIS_FRAME_CHOICE_REQUIRED/u);
    const checked = reduceDataAnalysisAction(plan([onwardChoice.choice]), "data.query.validate", { valid: true });
    expect(checked.currentQueryValidated).toBe(true);
    expect(checked.queryAttempts.at(-1)?.validationFindings).toEqual([
      expect.objectContaining({ code: `SQL_SEMANTIC_FRAME_READING_MISSING:${onwardChoice.id}`, severity: "warning" })
    ]);
  });

  it("lets a manual-fallback answer be committed by column name, from the query that applied the reading", () => {
    // wildfire-hard-17, 2026-10-12: the manual contract named no claim values, so ten commits failed with
    // "allowed names: none" and the run ended on an unchecked text answer.
    const manual = createUserAnalysisRequirements([{ kind: "metric", description: "Average", acceptanceCriteria: ["One number"] }]);
    let state = createDataAnalysisProtocol([], manual)
      .createInitialState({ contextPackageRef: { packageId: "p", revision: 0 }, runId: "run-manual-commit" });
    state = reduceDataAnalysisAction(state, "inspect_schema", { schema_id: "s", tables: [{ name: "fires" }] });
    state = reduceDataAnalysisAction(state, "semantic.context.resolve", {
      mode: "live",
      trust: "verified",
      value: { evidence_grounding: { facts: [], candidates: [], duplicateTables: [], warnings: [], frame: FRAME, binding: { frame: true } } }
    });
    state = reduceDataAnalysisAction(state, "analysis.contract.ground", { requirements: manual, advisory: true });
    const run = (current: DataAnalysisState, sql: string, value: number) => {
      const validated = reduceDataAnalysisAction(reduceDataAnalysisAction(current, "data.query.plan", {
        sql, requirement_ids: ["R1"], frame_choices: [onwardChoice.choice]
      }), "data.query.validate", { valid: true });
      const result = { columns: ["n"], rows: [[value]], row_count: 1, audit_log_id: `audit-${value}` };
      const checked = validateAnalysisResult({ result }, {}, validated);
      const id = validated.currentQueryAttemptId ?? "Q";
      let next = reduceDataAnalysisAction(validated, "run_sql_readonly", { result: { artifact_id: `artifact-${id}`, ...result } });
      next = reduceDataAnalysisAction(next, "analysis.result.validate", checked);
      return { checked, state: reduceDataAnalysisAction(next, "analysis.evidence.bind", {
        artifact_id: `artifact-${id}`, audit_log_id: `audit-${value}`, evidence_refs: [`artifact-${id}`]
      }) };
    };
    const skipped = run(state, "SELECT COUNT(*) AS n FROM fires", 30);
    const applied = run(skipped.state, "SELECT COUNT(*) AS n FROM fires WHERE \"year\" >= 2000", 25);
    const commitN = (current: DataAnalysisState, value: number) => reduceDataAnalysisAction(current, "analysis.requirements.commit", {
      claims: [{ requirement_id: "R1", claim: `n is ${value}`, values: [{ name: "n", value }] }]
    });

    expect(skipped.checked.verified_values).toEqual([expect.objectContaining({ name: "n", value: 30 })]);
    expect(() => commitN(applied.state, 30)).toThrow(/ANALYSIS_ANSWER_FRAME_MISMATCH:R1:n/u);
    expect(commitN(applied.state, 25).requirements.find((requirement) => requirement.id === "R1")?.status).toBe("reported");
  });
});
