import { describe, expect, it } from "vitest";

import { createDecisionsFromReceipt, type AnalysisDecision } from "../analysis-decisions.js";
import { projectCommitObservation, projectDecisionObservation } from "../data-analysis-hooks.js";
import { createDataAnalysisProtocol, reduceDataAnalysisAction, type DataAnalysisState } from "./data-analysis.js";

const contextPackageRef = { packageId: "context-1", revision: 0 };

const decision = (id: string, impact: AnalysisDecision["impact"], options: string[] = []): AnalysisDecision => ({
  id,
  kind: "population",
  question: `${id}?`,
  options,
  impact,
  source: "dtrail",
  status: "open",
  evidenceRefs: [],
  queryAttemptIds: [],
  checks: []
});

/** Runs the protocol to the point where only decisions can block completion. */
const evidencedState = (decisions: AnalysisDecision[], decisionIds: string[] = []) => {
  const protocol = createDataAnalysisProtocol(["inspect_schema", "run_sql_readonly"], [], decisions);
  let state = protocol.createInitialState({ contextPackageRef, runId: "run-1" });
  state = reduceDataAnalysisAction(state, "inspect_schema", {});
  state = reduceDataAnalysisAction(state, "semantic.context.resolve", { mode: "live", trust: "verified" });
  state = reduceDataAnalysisAction(state, "data.query.plan", { sql: "select 1", decision_ids: decisionIds });
  state = reduceDataAnalysisAction(state, "data.query.validate", { valid: true });
  state = reduceDataAnalysisAction(state, "run_sql_readonly", { artifact_id: "artifact-1" });
  state = reduceDataAnalysisAction(state, "analysis.result.validate", { valid: true });
  state = reduceDataAnalysisAction(state, "analysis.evidence.bind", { evidence_refs: ["artifact-1"] });
  return { protocol, state };
};

const record = (state: DataAnalysisState, input: Record<string, unknown>) =>
  reduceDataAnalysisAction(state, "analysis.decision.record", input);

describe("data-analysis decisions", () => {
  it("blocks completion on an open high-impact decision until it is recorded", () => {
    const { protocol, state } = evidencedState([decision("D1", "high"), decision("D2", "low")]);

    expect(protocol.completionPolicy({ contextPackageRef, state })).toMatchObject({
      status: "continue",
      reasons: ["ANALYSIS_DECISION_OPEN:D1"],
      allowedActions: ["analysis.decision.record"]
    });

    const resolved = record(state, {
      decision_id: "D1",
      options: ["keep flagged rows", "drop flagged rows"],
      choice: "drop flagged rows",
      basis: { kind: "evidence", detail: "every non-serous row is flagged" },
      evidence_refs: ["artifact-1"]
    });
    expect(protocol.completionPolicy({ contextPackageRef, state: resolved }).status).toBe("completed");
    expect(resolved.decisions[0]).toMatchObject({
      status: "resolved",
      choice: "drop flagged rows",
      options: ["keep flagged rows", "drop flagged rows"],
      evidenceRefs: ["artifact-1"]
    });
  });

  it("offers decision recording in every phase", () => {
    const protocol = createDataAnalysisProtocol([], [], [decision("D1", "high")]);
    for (const phase of Object.values(protocol.phases)) {
      expect(phase.allowedActions).toContain("analysis.decision.record");
    }
  });

  it("links SQL attempts to the decisions they apply and rejects unknown ids", () => {
    const { state } = evidencedState([decision("D1", "high")], ["D1"]);

    expect(state.queryAttempts[0]?.decisionIds).toEqual(["D1"]);
    expect(state.decisions[0]?.queryAttemptIds).toEqual(["Q1"]);
    expect(() => reduceDataAnalysisAction(state, "data.query.plan", { sql: "select 1", decision_ids: ["D9"] }))
      .toThrow("ANALYSIS_DECISION_NOT_FOUND:D9");
  });

  it("validates a record against the decision, its options and the run's evidence", () => {
    const { state } = evidencedState([decision("D1", "high", ["keep", "drop"])]);
    const basis = { kind: "question_span", detail: "the question says 'in the study'" };

    expect(() => record(state, { decision_id: "D7", choice: "keep", basis }))
      .toThrow("ANALYSIS_DECISION_NOT_FOUND:D7");
    expect(() => record(state, { decision_id: "D1", choice: "average", basis }))
      .toThrow("ANALYSIS_DECISION_CHOICE_NOT_AN_OPTION:D1");
    expect(() => record(state, { decision_id: "D1", choice: "keep" }))
      .toThrow("ANALYSIS_DECISION_BASIS_REQUIRED");
    expect(() => record(state, { decision_id: "D1", choice: "keep", basis: { kind: "evidence", detail: "x" } }))
      .toThrow("ANALYSIS_DECISION_EVIDENCE_REQUIRED");
    expect(() => record(state, {
      decision_id: "D1",
      choice: "keep",
      basis: { kind: "evidence", detail: "x" },
      evidence_refs: ["artifact-unknown"]
    })).toThrow("ANALYSIS_DECISION_EVIDENCE_UNKNOWN:artifact-unknown");
  });

  it("lets the agent raise a decision mid-run with the next id", () => {
    const { state } = evidencedState([decision("D1", "low")]);
    const next = record(state, {
      kind: "boundary",
      question: "Does 'below 30%' include 30%?",
      options: ["exclusive", "inclusive"],
      choice: "inclusive",
      basis: { kind: "unresolved", detail: "the question does not say" }
    });

    expect(next.decisions[1]).toMatchObject({
      id: "D2",
      kind: "boundary",
      source: "agent",
      status: "resolved",
      choice: "inclusive"
    });
    expect(() => record(state, { choice: "x", basis: { kind: "unresolved", detail: "y" } }))
      .toThrow("ANALYSIS_DECISION_QUESTION_REQUIRED");
  });

  it("reports open decisions in the record and commit observations", () => {
    const { state } = evidencedState([decision("D1", "high"), decision("D2", "high")]);
    const resolved = record(state, {
      decision_id: "D1",
      choice: "drop",
      basis: { kind: "convention", detail: "study cohort excludes flagged cases" }
    });

    expect(projectDecisionObservation({ decision_id: "D1" }, resolved)).toEqual({
      decision_result: {
        decision_id: "D1",
        status: "resolved",
        choice: "drop",
        open_decision_ids: ["D2"],
        instruction: "Recorded. Still open: D2."
      }
    });
    expect(projectCommitObservation({}, resolved)).toMatchObject({
      commit_result: { open_decision_ids: ["D2"], instruction: expect.stringContaining("resolve open decisions D2") }
    });
  });
});

describe("createDecisionsFromReceipt", () => {
  it("turns every unconfirmed receipt item into an open decision, in order", () => {
    const decisions = createDecisionsFromReceipt({
      assumptions: [
        { clause: "serous maps to Histologic_type", impact: "high" },
        { clause: "flagged rows count", impact: "high", residual: "drop Case_excluded='Yes'?" },
        { clause: "units are per Mbp", impact: "unknown" }
      ],
      trees: [
        { status: "confirmed", claim: null },
        { status: "partial", claim: null, scalar: { confidence: 0.5 } },
        { status: "text_only", claim: null }
      ]
    });

    expect(decisions.map((item) => [item.id, item.impact, item.level, item.question])).toEqual([
      ["D1", "high", "partial", "drop Case_excluded='Yes'?"],
      ["D2", "medium", "text_only", "Does this hold for this question: units are per Mbp?"]
    ]);
    expect(decisions[0]).toMatchObject({ source: "dtrail", status: "open", confidence: 0.5, options: [] });
    expect(createDecisionsFromReceipt(undefined)).toEqual([]);
  });
});
