import { answerChangingDecisions, outcomeKey } from "../protocol/analysis-decisions.js";
import { finalAnswerText } from "../protocol/final-answer.js";
import type { DataAnalysisState } from "../protocol/protocols/data-analysis.js";
import type { ProtocolRunState } from "../protocol/types.js";
import type { RunSignal } from "./run-signals.js";

/**
 * A run's trajectory, cut down to what a lesson can come from: how it decided, what it committed,
 * where checks sent it back and what it did next, and which actions failed. Every flag comes from the
 * run itself; nothing here knows the expected answer, so lessons cannot carry answers forward.
 */
/**
 * One run compressed by the trajectory compressor service (text_compresor, V5 graph, zero LLM calls):
 * the packet text the lesson writer reads, and the failure digest computed from the full run. The full
 * trajectory stays in DataFoundry's database; packet references resolve to its exact events.
 */
export type CompressedTrajectory = {
  runId: string;
  text: string;
  tokens: number;
  sourceTokens: number;
  budgetSatisfied: boolean;
  archive: string;
  failures: Array<{ action: string; code: string; count: number; message?: string; repaired: boolean }>;
  unrepaired: number;
  repeated: number;
};

export type TrajectorySummary = {
  runId: string;
  /** The conversation the run belongs to: a follow-up turn on the same question shares it. */
  sessionId?: string;
  question: string;
  finalAnswer?: string;
  committedValues: string[];
  decisions: Array<{
    id: string;
    kind: string;
    status: string;
    basis?: string;
    changesAnswer: boolean;
    question: string;
  }>;
  queries: { executed: number; evidenced: number; notExecuted: number };
  /** Failed actions by reason code, with the first failure's own message: what the error asked for. */
  failedActions: Array<{ action: string; reason: string; count: number; message?: string; repaired?: boolean }>;
  /** The compressed run(s) of this question, when compression is on: a follow-up turn adds its own. */
  compressed?: CompressedTrajectory[];
  signals: RunSignal[];
  /** Problems visible in the run itself, phrased for the lesson writer. */
  flags: string[];
};

const MAX_QUESTION_CHARS = 500;
const MAX_TEXT = 160;

export const summarizeTrajectory = (input: {
  runId: string;
  sessionId?: string;
  question: string;
  state: ProtocolRunState | undefined;
  finalText: string;
  signals: RunSignal[];
  compressed?: CompressedTrajectory | undefined;
}): TrajectorySummary => {
  const domain = (input.state?.protocolId === "data-analysis" ? input.state.domain : undefined) as DataAnalysisState | undefined;
  const finalAnswer = finalAnswerText(input.finalText);
  const committedValues = (domain?.reportedClaims ?? [])
    .flatMap((claim) => claim.values ?? [])
    .map((value) => String(value.value))
    .filter((value) => value.length > 0);
  const decisions = (domain?.decisions ?? []).map((decision) => ({
    id: decision.id,
    kind: decision.kind,
    status: decision.status,
    ...(decision.basis?.kind ? { basis: decision.basis.kind } : {}),
    changesAnswer: answerChangingDecisions([decision]).length > 0,
    question: short(decision.question)
  }));
  const attempts = domain?.queryAttempts ?? [];
  const queries = {
    executed: attempts.filter((attempt) => attempt.status === "executed" || attempt.status === "evidenced").length,
    evidenced: attempts.filter((attempt) => attempt.status === "evidenced").length,
    notExecuted: attempts.filter((attempt) => attempt.status === "planned" || attempt.status === "validated").length
  };
  const failures = new Map<string, { action: string; reason: string; count: number; message?: string }>();
  for (const action of input.state?.actions ?? []) {
    if (action.status !== "rejected" && action.status !== "failed") continue;
    const full = action.reasonCode ?? action.status;
    const reason = full.split(":")[0] ?? action.status;
    const key = `${action.actionName}|${reason}`;
    // Without the message, the lesson writer guessed: ANALYSIS_CLAIM_VALUE_UNKNOWN became "commit only
    // values the data states", while the error asks for a value a verified query returned (trial 1).
    const message = errorGuidance(full);
    const entry = failures.get(key) ?? { action: action.actionName, reason, count: 0, ...(message ? { message } : {}) };
    entry.count += 1;
    failures.set(key, entry);
  }
  // With a compressed run, failures come from its digest: it reads the whole run, including actions the
  // protocol state does not keep, and says whether a later attempt repaired each one.
  const failedActions: TrajectorySummary["failedActions"] = input.compressed
    ? failuresFromCompressed(input.compressed)
    : [...failures.values()].sort((left, right) => right.count - left.count).slice(0, 8);

  const flags: string[] = [];
  if (!finalAnswer) flags.push("The run ended without a FINAL_ANSWER line.");
  if (domain && committedValues.length === 0) flags.push("No answer value was committed before the final answer.");
  if (finalAnswer && committedValues.length > 0
      && !committedValues.some((value) => outcomeKey(value) === outcomeKey(finalAnswer))) {
    flags.push("The final answer is not one of the committed values.");
  }
  for (const signal of input.signals) {
    if (signal.answer !== undefined && finalAnswer !== undefined) {
      flags.push(outcomeKey(signal.answer) === outcomeKey(finalAnswer)
        ? `The ${signal.source} check sent the agent back, and the final answer stayed the same.`
        : `The ${signal.source} check sent the agent back, and the agent changed its answer.`);
    }
  }
  for (const decision of domain?.decisions ?? []) {
    if (answerChangingDecisions([decision]).length > 0 && (decision.basis?.kind === "convention" || decision.status === "undecided")) {
      flags.push(`Decision ${decision.id} (${decision.kind}) changes the answer and was left ${decision.status === "undecided" ? "undecided" : "to a convention"}.`);
    }
  }
  const repeated = failedActions.filter((failure) => failure.count >= 3);
  for (const failure of repeated) {
    flags.push(`${failure.action} failed ${failure.count} times with ${failure.reason}${
      failure.repaired === false ? ", and no later attempt succeeded" : ""}.`);
  }
  for (const failure of failedActions.filter((item) => item.repaired === false && item.count < 3)) {
    flags.push(`${failure.action} failed with ${failure.reason}, and no later attempt succeeded.`);
  }
  if (queries.executed >= 25) flags.push(`The run executed ${queries.executed} queries.`);

  return {
    runId: input.runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    question: input.question.slice(0, MAX_QUESTION_CHARS),
    ...(finalAnswer ? { finalAnswer } : {}),
    committedValues: [...new Set(committedValues)].slice(0, 8),
    decisions,
    queries,
    failedActions,
    signals: input.signals,
    flags: [...new Set(flags)],
    ...(input.compressed ? { compressed: [input.compressed] } : {})
  };
};

const failuresFromCompressed = (compressed: CompressedTrajectory): TrajectorySummary["failedActions"] =>
  compressed.failures.slice(0, 8).map((failure) => {
    const message = failure.message ? errorGuidance(failure.message) ?? short(failure.message) : undefined;
    return {
      action: failure.action,
      reason: failure.code,
      count: failure.count,
      ...(message ? { message } : {}),
      repaired: failure.repaired
    };
  });

/** The part of an error after its code and ids, shortened: the instruction the error gives. */
const errorGuidance = (reasonCode: string): string | undefined => {
  const text = reasonCode.replace(/^[A-Z_]+(?::[^:\s]+)*:\s*/u, "").trim();
  return text && text !== reasonCode.trim() ? short(text) : undefined;
};

const short = (value: string): string => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value);
