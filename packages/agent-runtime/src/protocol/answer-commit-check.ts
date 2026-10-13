import type { DataAnalysisState } from "./protocols/data-analysis.js";
import type { ProtocolRunState } from "./types.js";

const DEFAULT_MAX_NUDGES = 2;

/**
 * With frame binding on, the chosen reading is enforced when the answer is committed. An agent that
 * ends on a text answer skips that check: on 2026-10-12, 23 of 25 bound wildfire runs never committed,
 * and wildfire-hard-17 reported a value whose query ignored the reading the agent itself chose.
 * Returns why the run may not end yet, or undefined when it may.
 */
export const uncommittedAnswerReason = (state: ProtocolRunState): string | undefined => {
  if (state.protocolId !== "data-analysis" || (state.status !== "active" && state.status !== "waiting")) return undefined;
  const domain = state.domain as DataAnalysisState | undefined;
  if (!domain?.evidenceGrounding?.binding?.frame) return undefined;
  const open = domain.requirements.filter((requirement) =>
    !requirement.id.startsWith("CORE") && requirement.status !== "reported");
  if (open.length === 0) return undefined;
  const choices = domain.frameChoices ?? [];
  return `The answer is not committed (${open.map((requirement) => requirement.id).join(", ")}), so it has not been `
    + "checked against your answer-frame reading. Call analysis_requirements_commit with the answer value from "
    + (choices.length > 0
      ? `a verified query that applies your frame choices (${choices.join(", ")}). `
      : "a verified query, passing frame_choices on that query. ")
    + "If the commit is rejected, fix the query as the error says and commit again; then give the final answer.";
};

/**
 * A Mastra completion check (isTaskComplete scorer) that sends the agent back to commit its answer,
 * at most `maxNudges` times per run so an agent that cannot commit still finishes. No model call.
 */
export const createAnswerCommitCheck = (input: { getState: () => ProtocolRunState; maxNudges?: number }) => {
  let nudges = 0;
  return {
    id: "answer-committed",
    name: "Answer committed",
    run: async (): Promise<{ score: number; reason?: string }> => {
      let reason: string | undefined;
      let state: ProtocolRunState;
      try {
        state = input.getState();
        reason = uncommittedAnswerReason(state);
      } catch (error) {
        console.warn(`[answer-commit-check] state unreadable: ${error instanceof Error ? error.message : String(error)}`);
        return { score: 1 };
      }
      const nudge = reason !== undefined && nudges < (input.maxNudges ?? DEFAULT_MAX_NUDGES);
      console.warn(`[answer-commit-check] run=${state.runId} protocol=${state.protocolId} status=${state.status} `
        + `uncommitted=${reason !== undefined} nudges=${nudges} -> ${nudge ? "send back" : "pass"}`);
      if (!nudge) return { score: 1 };
      nudges += 1;
      return { score: 0, reason: reason as string };
    }
  };
};
