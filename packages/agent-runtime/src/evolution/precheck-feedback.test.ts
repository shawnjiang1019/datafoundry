import { describe, expect, it } from "vitest";

import type { AnalysisDecision } from "../protocol/analysis-decisions.js";
import type { ProtocolRunState } from "../protocol/types.js";
import { precheckFeedback } from "./precheck-feedback.js";

const QUESTION = "Which Boston Harbor beach had the most failed samples on dry days?";

const decision = (overrides: Partial<AnalysisDecision>): AnalysisDecision => ({
  id: "D1",
  kind: "population",
  question: "Which beaches count as Boston Harbor beaches?",
  options: ["Harbor communities only", "Every beach in the dataset's harbor list"],
  impact: "high",
  source: "dtrail",
  status: "resolved",
  evidenceRefs: [],
  queryAttemptIds: [],
  checks: [],
  ...overrides
});

const resolution = (recommended: number, status: "resolved" | "undecided" = "resolved") => ({
  status,
  quote: "Boston Harbor beach",
  quoteVerified: true,
  readings: ["Harbor communities only", "Every beach in the dataset's harbor list"],
  recommended,
  confidence: "medium",
  narrowsQuote: false,
  narrowing: "",
  rationale: ""
});

const state = (decisions: AnalysisDecision[]): ProtocolRunState => ({
  protocolId: "data-analysis",
  actions: [],
  domain: { decisions, reportedClaims: [{ values: [{ name: "beach", value: "Wollaston Beach" }] }] }
}) as unknown as ProtocolRunState;

describe("pre-check feedback", () => {
  it("reports readings kept, overruled, missed and answer-changing (environment-hard-12)", () => {
    const feedback = precheckFeedback({
      question: QUESTION,
      state: state([
        decision({
          id: "D1", resolution: resolution(0), choice: "Every beach in the dataset's harbor list",
          basis: { kind: "evidence", detail: "the harbor list names nine beaches" },
          optionResults: [
            { option: "Harbor communities only", value: "Tenean Beach" },
            { option: "Every beach in the dataset's harbor list", value: "Wollaston Beach" }
          ]
        }),
        decision({ id: "D2", question: "Is a dry day zero rain over three days?", resolution: resolution(1, "undecided"),
          choice: "Every beach in the dataset's harbor list" }),
        decision({ id: "D3", source: "agent", kind: "boundary", question: "Count each station reading as a sample?" })
      ]),
      finalText: "FINAL_ANSWER: Wollaston Beach",
      signals: [{ source: "decision-outcomes", answer: "Tenean Beach", detail: "invariance claim contradicts results" }]
    });
    expect(feedback.observations).toEqual(expect.arrayContaining([
      expect.stringMatching(/resolver recommended "Harbor communities only", but the analysis chose "Every beach.*basis: evidence/u),
      expect.stringMatching(/resolver called "Which beaches count as Boston Harbor beaches\?" resolved, but its readings gave different answers: .*Tenean Beach.*Wollaston Beach/u),
      "The analysis kept the resolver's recommended reading for \"Is a dry day zero rain over three days?\".",
      "The analysis had to decide \"Count each station reading as a sample?\" (boundary), which the pre-check did not list.",
      "A decision-outcomes check sent the analysis back: invariance claim contradicts results"
    ]));
    expect(feedback.values).toEqual(["Wollaston Beach"]);
    expect(feedback.question).toBe(QUESTION);
  });

  it("adds the compressed run's failures, leaving out the protocol's own bookkeeping errors", () => {
    const feedback = precheckFeedback({
      question: QUESTION, state: state([]), finalText: "FINAL_ANSWER: x", signals: [],
      compressed: {
        runId: "r", text: "", tokens: 1, sourceTokens: 2, budgetSatisfied: true, archive: "a", unrepaired: 1, repeated: 0,
        failures: [
          { action: "preview_table", code: "ACTION_EXECUTION_FAILED", count: 1, repaired: false, message: "No files found that match the pattern" },
          { action: "run_sql_readonly", code: "ANALYSIS_ASSERTION_IDS_REQUIRED", count: 2, repaired: true }
        ]
      }
    });
    expect(feedback.observations).toEqual([
      "The compressed run shows preview_table failed 1 time(s) with ACTION_EXECUTION_FAILED, never repaired: No files found that match the pattern"
    ]);
  });

  it("is empty for a run without a data-analysis state", () => {
    expect(precheckFeedback({ question: "q", state: undefined, finalText: "", signals: [] }))
      .toEqual({ question: "q", observations: [], values: [] });
  });
});
