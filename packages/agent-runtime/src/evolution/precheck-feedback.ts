import { answerChangingDecisions, matchOption, renderOptionResults, type AnalysisDecision } from "../protocol/analysis-decisions.js";
import { finalAnswerText } from "../protocol/final-answer.js";
import type { DataAnalysisState } from "../protocol/protocols/data-analysis.js";
import type { ProtocolRunState } from "../protocol/types.js";
import type { RunSignal } from "./run-signals.js";
import type { CompressedTrajectory } from "./trajectory.js";

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
  /** The run compressed by the trajectory compressor: its failure digest becomes observations. */
  compressed?: CompressedTrajectory | undefined;
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
  observations.push(...compressedObservations(input.compressed));
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

/**
 * What the compressed run shows about failures: actions that failed and whether a later attempt
 * repaired them. A failure the pre-check could have prevented (a missing file or column, a reading
 * the data does not support) is for D-TRAIL's lesson writer to recognise; the protocol's own
 * bookkeeping errors are left out, since no assumption could have avoided them.
 */
const compressedObservations = (compressed: CompressedTrajectory | undefined): string[] => {
  if (!compressed) return [];
  return compressed.failures
    .filter((failure) => !PROTOCOL_ONLY_CODES.has(failure.code))
    .slice(0, MAX_COMPRESSED_OBSERVATIONS)
    .map((failure) => `The compressed run shows ${failure.action} failed ${failure.count} time(s) with ${failure.code}`
      + `${failure.repaired ? ", repaired by a later attempt" : ", never repaired"}${failure.message ? `: ${short(failure.message)}` : "."}`);
};

const MAX_COMPRESSED_OBSERVATIONS = 5;

/** Errors about the protocol's own steps (ids, phases, commit order): no assumption could have prevented them. */
const PROTOCOL_ONLY_CODES = new Set([
  "ANALYSIS_ASSERTION_IDS_REQUIRED",
  "ACTION_NOT_ALLOWED_IN_PHASE",
  "ANALYSIS_REQUIREMENTS_COMMIT_REQUIRED"
]);

const short = (value: string): string => {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}...` : flat;
};
