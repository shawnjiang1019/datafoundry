import { checkAnswer } from "../grounding/answer-check.js";
import type { DataAnalysisState } from "./protocols/data-analysis.js";
import type { AnalysisScalar } from "./analysis-contract.js";
import type { AnalysisQueryAttempt } from "./analysis-requirements.js";
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

const DEFAULT_MAX_CHALLENGES = 2;

/**
 * The query the answer came from. With the answer text: the latest query whose result holds the answer
 * value, the rule d-trail's post-run check uses (find_backing). Otherwise, or when no result holds it,
 * the last query that ran and was verified, else the last that ran. On legal-hard-18 (2026-11-12) the
 * agent ran a query that read the stated share after the challenge, then answered 126000 from an
 * earlier one; checking only the last query let the wrong answer through.
 */
export const finalAnswerSql = (domain: DataAnalysisState, answerText?: string): string | undefined => {
  const ran = domain.queryAttempts.filter((attempt) => attempt.sql && (attempt.status === "evidenced" || attempt.status === "executed"));
  const answer = answerText === undefined ? undefined : finalAnswerValue(answerText);
  const backing = answer === undefined ? undefined : [...ran].reverse().find((attempt) => attemptHolds(attempt, answer));
  return (backing ?? ran.filter((attempt) => attempt.status === "evidenced").at(-1) ?? ran.at(-1))?.sql;
};

type AnswerValue = { number: number; tolerance: number } | string | AnswerValue[];

/** The value on the run's last FINAL_ANSWER line, or undefined when there is none. */
export const finalAnswerValue = (text: string): AnswerValue | undefined => {
  const line = [...text.matchAll(/FINAL_ANSWER\s*[:：]\s*(.+)/giu)].at(-1)?.[1];
  return line === undefined ? undefined : parseAnswer(line);
};

const parseAnswer = (text: string): AnswerValue => {
  let value = text.trim().replace(/^`+|`+$/gu, "").trim();
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === "\"")) value = value.slice(1, -1).trim();
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => parseAnswer(String(item)));
    } catch {
      // not a JSON list: read it as a single value
    }
  }
  return asNumber(value) ?? value;
};

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/u;

/** The number with half a unit of its last written decimal place as tolerance, as written answers round. */
const asNumber = (value: unknown): { number: number; tolerance: number } | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? { number: value, tolerance: 0 } : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replaceAll(",", "");
  if (!NUMBER.test(text)) return undefined;
  const [mantissa = "", exponent = "0"] = text.split(/[eE]/u);
  const decimals = mantissa.split(".")[1]?.length ?? 0;
  return { number: Number(text), tolerance: 0.5 * 10 ** (Number(exponent) - decimals) };
};

const cellMatches = (cell: AnalysisScalar, answer: AnswerValue): boolean => {
  if (Array.isArray(answer)) return false;
  if (typeof answer === "string") return cell !== null && String(cell).trim().toLowerCase() === answer.trim().toLowerCase();
  const number = asNumber(cell);
  return number !== undefined && Math.abs(number.number - answer.number) <= answer.tolerance + 1e-9 * Math.max(1, Math.abs(answer.number));
};

/** A list answer needs every item in one column; a single value may sit in any cell or verified value. */
const attemptHolds = (attempt: AnalysisQueryAttempt, answer: AnswerValue): boolean => {
  const rows = attempt.resultRows ?? [];
  if (Array.isArray(answer)) {
    if (answer.length === 0) return false;
    const width = Math.max(0, ...rows.map((row) => row.length));
    return Array.from({ length: width }, (_, column) => rows.map((row) => row[column] ?? null))
      .some((cells) => answer.every((item) => cells.some((cell) => cellMatches(cell, item))));
  }
  return rows.some((row) => row.some((cell) => cellMatches(cell, answer)))
    || attempt.verifiedValues.some((verified) => cellMatches(verified.value, answer));
};

const answerLabel = (text: string): string | undefined =>
  [...text.matchAll(/FINAL_ANSWER\s*[:：]\s*(.+)/giu)].at(-1)?.[1]?.trim();

/**
 * Multi-stage notes: in check mode the agent never sees the frame. When it tries to finish, the query its
 * answer came from is checked against the readings counted in the data, and on strong evidence of a
 * conflict it is sent back with one specific reason (at most `maxChallenges` times). When the same
 * challenge comes back with the same answer, the reason says so, so a query rewritten without changing
 * the answer is not taken as a fix. An answer with no conflict goes out as the agent wrote it.
 */
export const createAnswerCheck = (input: { getState: () => ProtocolRunState; maxChallenges?: number }) => {
  let challenges = 0;
  let last: { code: string; answer: string | undefined } | undefined;
  return {
    id: "answer-check",
    name: "Answer checked against the notes",
    run: async (context?: { output?: unknown }): Promise<{ score: number; reason?: string }> => {
      let reason: string | undefined;
      try {
        const state = input.getState();
        const domain = state.domain as DataAnalysisState | undefined;
        if (state.protocolId !== "data-analysis" || !domain?.evidenceGrounding?.binding?.check) return { score: 1 };
        const text = typeof context?.output === "string" ? context.output : undefined;
        const sql = finalAnswerSql(domain, text);
        if (!sql) return { score: 1 };
        const challenge = checkAnswer({ question: domain.evidenceGrounding.question ?? "", sql, grounding: domain.evidenceGrounding });
        const answer = text === undefined ? undefined : answerLabel(text);
        const repeated = challenge !== undefined && answer !== undefined
          && last?.code === challenge.code && last.answer === answer;
        reason = challenge
          ? `${challenge.code}: ${repeated ? `Your answer is still ${answer}, and the query it comes from has the same problem. ` : ""}${challenge.message}`
          : undefined;
        if (challenge) last = { code: challenge.code, answer };
        console.warn(`[answer-check] run=${state.runId} challenge=${challenge?.code ?? "none"} challenges=${challenges}`
          + `${repeated ? " repeated" : ""}`);
      } catch (error) {
        console.warn(`[answer-check] state unreadable: ${error instanceof Error ? error.message : String(error)}`);
        return { score: 1 };
      }
      if (!reason || challenges >= (input.maxChallenges ?? DEFAULT_MAX_CHALLENGES)) return { score: 1 };
      challenges += 1;
      return { score: 0, reason };
    }
  };
};
