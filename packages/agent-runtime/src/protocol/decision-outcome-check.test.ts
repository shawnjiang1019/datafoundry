import { describe, expect, it } from "vitest";

import { distinctOutcomes, recordDecision, type AnalysisDecision } from "./analysis-decisions.js";
import { createDecisionOutcomeCheck, decisionOutcomeIssue } from "./decision-outcome-check.js";
import type { ProtocolRunState } from "./types.js";

const SCOPE_OPTIONS = [
  "Boston Harbor communities in the state sample records",
  "Every beach in the boston_harbor_beaches list (all datasheets)"
];

const seeded = (): AnalysisDecision[] => [{
  id: "D5",
  kind: "population",
  question: "Which beaches count as Boston Harbor beaches?",
  options: [...SCOPE_OPTIONS],
  impact: "high",
  source: "dtrail",
  status: "open",
  evidenceRefs: [],
  queryAttemptIds: [],
  checks: []
}];

const HARD_12_RESULTS = [
  { option: "1", value: "Tenean Beach", evidence_ref: "a1" },
  { option: "2", value: "Wollaston Beach", evidence_ref: "a2" }
];

describe("decisions whose options change the answer", () => {
  it("records option results by the option they name", () => {
    const [decision] = recordDecision(seeded(), {
      decision_id: "D5", choice: "2", basis: { kind: "evidence", detail: "the dataset lists Wollaston" },
      evidence_refs: ["a2"], option_results: HARD_12_RESULTS
    }, []);
    expect(decision?.optionResults).toEqual([
      { option: SCOPE_OPTIONS[0], value: "Tenean Beach", evidenceRef: "a1" },
      { option: SCOPE_OPTIONS[1], value: "Wollaston Beach", evidenceRef: "a2" }
    ]);
    expect(distinctOutcomes(decision?.optionResults ?? [])).toBe(2);
  });

  it("refuses a convention basis when the options give different answers (environment-hard-12)", () => {
    expect(() => recordDecision(seeded(), {
      decision_id: "D5", choice: "1", basis: { kind: "convention", detail: "canonical population frame" },
      option_results: HARD_12_RESULTS
    }, [])).toThrow(/OUTCOME_DEPENDS_ON_CHOICE:D5.*Tenean Beach.*Wollaston Beach.*undecided/su);
    // The same choice may stay undecided, and a convention is fine when the answer does not change.
    expect(() => recordDecision(seeded(), {
      decision_id: "D5", choice: "1", status: "undecided", basis: { kind: "convention", detail: "frame" },
      option_results: HARD_12_RESULTS
    }, [])).not.toThrow();
    expect(() => recordDecision(seeded(), {
      decision_id: "D5", choice: "1", basis: { kind: "convention", detail: "frame" },
      option_results: [{ option: "1", value: "0.50" }, { option: "2", value: "0.5" }]
    }, [])).not.toThrow();
  });

  it("catches an invariance claim the recorded results contradict", () => {
    const decisions = recordDecision(seeded(), {
      decision_id: "D5", choice: "1", status: "undecided", basis: { kind: "convention", detail: "frame" },
      option_results: HARD_12_RESULTS
    }, []);
    const response = "The answer is invariant to that boundary; under the other reading Wollaston Beach leads.\n"
      + "FINAL_ANSWER: Tenean Beach";
    expect(decisionOutcomeIssue(decisions, response)).toMatch(/D5: your answer says it does not depend/u);
  });

  it("catches a final answer that is another option's result, and an unreported alternative", () => {
    const decisions = recordDecision(seeded(), {
      decision_id: "D5", choice: "1", status: "undecided", basis: { kind: "convention", detail: "frame" },
      option_results: HARD_12_RESULTS
    }, []);
    expect(decisionOutcomeIssue(decisions, "FINAL_ANSWER: Wollaston Beach")).toMatch(/final answer Wollaston Beach is another option's result/u);
    expect(decisionOutcomeIssue(decisions, "Scope is NOT CONFIRMED.\nFINAL_ANSWER: Tenean Beach"))
      .toMatch(/undecided.*alternative answer Wollaston Beach/su);
    expect(decisionOutcomeIssue(decisions, "NOT CONFIRMED: the list reading gives Wollaston Beach.\nFINAL_ANSWER: Tenean Beach"))
      .toBeUndefined();
  });

  it("stays quiet when no recorded options change the answer", () => {
    const decisions = recordDecision(seeded(), {
      decision_id: "D5", choice: "2", basis: { kind: "evidence", detail: "list" }, evidence_refs: ["a2"]
    }, []);
    expect(decisionOutcomeIssue(decisions, "The answer is unchanged.\nFINAL_ANSWER: Wollaston Beach")).toBeUndefined();
  });

  it("compares answer values only, and does not read \"scale-invariant\" as a claim (2026-11-13 check run)", () => {
    const narrative = recordDecision(seeded(), {
      decision_id: "D5", choice: "2", basis: { kind: "convention", detail: "list" },
      option_results: [
        { option: "1", value: "Excluded: the boston_harbor_beaches list has all nine beaches, so this reading drops one." },
        { option: "2", value: "Wollaston Beach" }
      ]
    }, []);
    expect(distinctOutcomes(narrative[0]?.optionResults ?? [])).toBe(1);
    const decisions = recordDecision(seeded(), {
      decision_id: "D5", choice: "1", status: "undecided", basis: { kind: "convention", detail: "frame" },
      option_results: [{ option: "1", value: "0.206" }, { option: "2", value: "0.198" }]
    }, []);
    expect(decisionOutcomeIssue(decisions, "Pearson correlation is scale-invariant. Reading 2 gives 0.198.\nFINAL_ANSWER: 0.206"))
      .toBeUndefined();
  });

  it("sends the agent back once, then lets the run end", async () => {
    const decisions = recordDecision(seeded(), {
      decision_id: "D5", choice: "1", status: "undecided", basis: { kind: "convention", detail: "frame" },
      option_results: HARD_12_RESULTS
    }, []);
    const state = { protocolId: "data-analysis", status: "active", runId: "r1", domain: { decisions } } as unknown as ProtocolRunState;
    const check = createDecisionOutcomeCheck({ getState: () => state });
    const args = { output: "invariant to scope\nFINAL_ANSWER: Tenean Beach" };
    expect((await check.run(args)).score).toBe(0);
    expect(await check.run(args)).toEqual({ score: 1 });
  });
});
