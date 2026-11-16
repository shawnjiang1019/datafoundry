import { answerChangingDecisions, matchOption, renderOptionResults, type AnalysisDecision } from "../protocol/analysis-decisions.js";
import { finalAnswerText } from "../protocol/final-answer.js";
import type { DataAnalysisState } from "../protocol/protocols/data-analysis.js";
import type { ProtocolRunState } from "../protocol/types.js";
import type { RunSignal } from "./run-signals.js";

/**
 * Feedback for the D-TRAIL pre-check: what this analysis did with the readings the pre-check gave
 * it. D-TRAIL learns from it (runtime evolution of its conditioner and resolver). Every sentence
 * comes from the run itself, never from an expected answer. The run's answer and committed values
 * go along only so D-TRAIL's lesson filter can refuse a lesson that repeats them.
 */
export type PrecheckFeedback = {
  question: string;
  observations: string[];
  values: string[];
};

const MAX_OBSERVATIONS = 20;
const MAX_TEXT = 160;

export const precheckFeedback = (input: {
  question: string;
  state: ProtocolRunState | undefined;
  finalText: string;
  signals: RunSignal[];
}): PrecheckFeedback => {
  const domain = (input.state?.protocolId === "data-analysis" ? input.state.domain : undefined) as DataAnalysisState | undefined;
  const decisions = domain?.decisions ?? [];
  const observations: string[] = [];
  for (const decision of decisions) {
    observations.push(...observe(decision));
  }
  for (const signal of input.signals) {
    observations.push(`A ${signal.source} check sent the analysis back: ${short(signal.detail)}`);
  }
  const committed = (domain?.reportedClaims ?? []).flatMap((claim) => claim.values ?? []).map((value) => String(value.value));
  const answer = finalAnswerText(input.finalText);
  return {
    question: input.question.slice(0, 600),
    observations: [...new Set(observations)].slice(0, MAX_OBSERVATIONS),
    values: [...new Set([...(answer ? [answer] : []), ...committed])].filter((value) => value.length > 0).slice(0, 10)
  };
};

const observe = (decision: AnalysisDecision): string[] => {
  const what = `"${short(decision.question)}"`;
  if (decision.source === "agent") {
    // The pre-check listed no assumption for a choice the analysis had to make.
    return [`The analysis had to decide ${what} (${decision.kind}), which the pre-check did not list.`];
  }
  const lines: string[] = [];
  const resolution = decision.resolution;
  const recommended = resolution?.readings[resolution.recommended];
  if (recommended && decision.choice) {
    const kept = matchOption(recommended, [decision.choice]) !== undefined || recommended === decision.choice;
    lines.push(kept
      ? `The analysis kept the resolver's recommended reading for ${what}.`
      : `For ${what} the resolver recommended "${short(recommended)}", but the analysis chose "${short(decision.choice)}"`
        + `${decision.basis ? ` (basis: ${decision.basis.kind}, ${short(decision.basis.detail)})` : ""}.`);
  }
  if (resolution?.status === "resolved" && answerChangingDecisions([decision]).length > 0) {
    lines.push(`The resolver called ${what} resolved, but its readings gave different answers: ${
      short(renderOptionResults(decision.optionResults ?? []))}.`);
  }
  if (decision.status === "undecided") {
    lines.push(`The analysis could not settle ${what} either, and reported it as not confirmed.`);
  } else if (decision.status === "open") {
    lines.push(`The analysis never recorded a choice for ${what}.`);
  }
  return lines;
};

const short = (value: string): string => {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}...` : flat;
};
