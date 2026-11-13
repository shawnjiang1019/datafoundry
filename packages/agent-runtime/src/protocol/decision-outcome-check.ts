import {
  answerChangingDecisions,
  outcomeKey,
  renderOptionResults,
  type AnalysisDecision
} from "./analysis-decisions.js";
import { finalAnswerValue } from "./answer-form-check.js";
import type { DataAnalysisState } from "./protocols/data-analysis.js";
import type { ProtocolRunState } from "./types.js";

/**
 * Decisions whose options lead to different answers, checked against the final text. On 2026-11-12
 * environment-hard-12 wrote that its answer was "invariant" to the beach-scope choice while noting
 * that the other reading made Wollaston Beach lead with 129 against Tenean Beach's 34. Using only
 * what the agent recorded (option_results), this check catches three things and sends the agent
 * back once: a claim that the answer does not depend on a choice that changes it, a final answer
 * that is not the chosen option's result, and an undecided choice whose alternative answer is not
 * reported. It does not pick a reading.
 */

const DEFAULT_MAX_CHALLENGES = 1;

/** Words that say the answer does not depend on a choice ("scale-invariant" is a property, not that claim). */
const INVARIANCE = /(?<![-\w])(?:invariant|unchanged|unaffected|does\s+not\s+(?:change|affect|alter)|doesn't\s+(?:change|affect|alter)|same\s+(?:answer|result)|robust\s+to|regardless\s+of)\b/iu;

const chosenResult = (decision: AnalysisDecision) =>
  (decision.optionResults ?? []).find((result) => result.option === decision.choice);

const mentions = (text: string, value: string): boolean => {
  const needle = value.toLowerCase().trim();
  return needle.length > 0 && text.toLowerCase().includes(needle);
};

/** Why the final text conflicts with the recorded decision outcomes, or undefined. */
export const decisionOutcomeIssue = (decisions: AnalysisDecision[], response: string): string | undefined => {
  const changing = answerChangingDecisions(decisions);
  if (changing.length === 0) return undefined;
  const answer = finalAnswerValue(response);
  const issues: string[] = [];
  for (const decision of changing) {
    const results = decision.optionResults ?? [];
    const outcomes = renderOptionResults(results);
    if (INVARIANCE.test(response)) {
      issues.push(`${decision.id}: your answer says it does not depend on a choice, but the options you ran give `
        + `different answers (${outcomes}). Remove that claim, and either show from the data or the question why the `
        + "other reading does not apply, or report the answer as depending on this choice.");
      continue;
    }
    const chosen = chosenResult(decision);
    if (answer && chosen && outcomeKey(answer) !== outcomeKey(chosen.value)
        && results.some((result) => outcomeKey(result.value) === outcomeKey(answer))) {
      issues.push(`${decision.id}: you chose "${decision.choice}", whose answer is ${chosen.value}, but the final answer `
        + `${answer} is another option's result (${outcomes}). Make the final answer and the recorded choice agree.`);
      continue;
    }
    if (decision.status === "undecided") {
      const unreported = results.filter((result) => result.option !== decision.choice && !mentions(response, result.value));
      if (unreported.length > 0) {
        issues.push(`${decision.id} is undecided and its options give different answers (${outcomes}). Report it as NOT `
          + `CONFIRMED with the alternative answer${unreported.length > 1 ? "s" : ""} ${
            unreported.map((result) => result.value).join(", ")}.`);
      }
    }
  }
  return issues.length > 0 ? issues.join(" ") : undefined;
};

type ScorerRunInput = { output?: unknown } | undefined;

/** A Mastra completion check (isTaskComplete scorer). No model call; at most `maxChallenges` send-backs. */
export const createDecisionOutcomeCheck = (input: { getState: () => ProtocolRunState; maxChallenges?: number }) => {
  let challenges = 0;
  return {
    id: "decision-outcomes",
    name: "Answer agrees with the decisions it depends on",
    run: async (args?: ScorerRunInput): Promise<{ score: number; reason?: string }> => {
      let reason: string | undefined;
      try {
        const state = input.getState();
        const domain = state.domain as DataAnalysisState | undefined;
        if (state.protocolId !== "data-analysis" || !domain?.decisions?.length) return { score: 1 };
        const response = typeof args?.output === "string" ? args.output : "";
        if (!response) return { score: 1 };
        reason = decisionOutcomeIssue(domain.decisions, response);
        console.warn(`[decision-outcome-check] run=${state.runId} issue=${reason ? "yes" : "none"} challenges=${challenges}`);
      } catch (error) {
        console.warn(`[decision-outcome-check] skipped: ${error instanceof Error ? error.message : String(error)}`);
        return { score: 1 };
      }
      if (!reason || challenges >= (input.maxChallenges ?? DEFAULT_MAX_CHALLENGES)) return { score: 1 };
      challenges += 1;
      return { score: 0, reason };
    }
  };
};
