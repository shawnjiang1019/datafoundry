import { blockedUnfaithfulWords, type FrameDecision, type FrameOption } from "./answer-frame.js";
import type { EvidenceGroundingContext } from "./types.js";
import { intersect, terms } from "./vocabulary.js";

/** Readings this far apart are a real difference in the answer, not a rounding of the population. */
const MIN_POPULATION_GAP = 0.25;
/** A flag that marks fewer rows than this share is not worth a challenge. */
const MIN_FLAGGED_SHARE = 0.05;

export type AnswerChallenge = {
  code: "LINKED_POPULATION_IGNORED" | "EXCLUSION_FLAG_IGNORED" | "READING_IGNORES_QUESTION";
  message: string;
  evidence: Record<string, unknown>;
};

/**
 * The final-answer check (multi-stage notes): the agent answers on its own, without seeing the frame,
 * and this compares the query its answer came from with readings checked in the data. It never sees
 * the correct answer. It returns one challenge only on strong evidence, else undefined, so an answer
 * the agent already gets right goes out untouched: showing every reading up front let the agent pick a
 * plausible wrong one on tasks it solved alone (archeology-easy-11, wildfire-hard-7, 2026-10-12).
 *
 * The checks read the final SQL conservatively: a reading counts as applied when the SQL mentions the
 * table or column that defines it, however it uses it, so a join written differently is not challenged.
 */
export const checkAnswer = (input: {
  question: string;
  sql: string;
  grounding: EvidenceGroundingContext | undefined;
}): AnswerChallenge | undefined => {
  const decisions = input.grounding?.frame?.decisions ?? [];
  const sql = input.sql;
  const asked = terms(input.question);
  for (const decision of decisions) {
    const whole = decision.options.find((option) => option.status === "checked" && option.sqlWhere === null);
    for (const option of decision.options) {
      if (option.status !== "checked" || !readsTable(sql, option.table)) continue;
      const defined = option.definedBy;
      if (defined?.kind === "link" && whole && !mentions(sql, defined.fromTable)
        && intersect(asked, terms(defined.fromTable)).length > 0 && gap(whole.rows, option.rows) >= MIN_POPULATION_GAP) {
        return {
          code: "LINKED_POPULATION_IGNORED",
          message: `Your answer uses every row of ${option.table} (${whole.rows}), but the question refers to `
            + `${defined.fromTable}, and only ${option.rows} rows of ${option.table} are referenced by it (a link verified `
            + `in the data). Check whether the question means those ${option.rows} rows; if so, recompute.`,
          evidence: { table: option.table, allRows: whole.rows, linkedRows: option.rows, linkedFrom: defined.fromTable }
        };
      }
      if (defined?.kind === "flag" && whole && !mentions(sql, defined.column)
        && whole.rows !== undefined && option.rows !== undefined && whole.rows > 0
        && (whole.rows - option.rows) / whole.rows >= MIN_FLAGGED_SHARE) {
        return {
          code: "EXCLUSION_FLAG_IGNORED",
          message: `Your answer reads ${option.table} without looking at ${defined.column}: ${whole.rows - option.rows} of `
            + `${whole.rows} rows are marked by it. If the question means the study's own population, leave the `
            + `marked rows out and recompute; if it means every row, keep your answer.`,
          evidence: { table: option.table, column: defined.column, allRows: whole.rows, keptRows: option.rows }
        };
      }
    }
    const challenge = unfaithfulReadingUsed(sql, decision);
    if (challenge) return challenge;
  }
  return undefined;
};

/**
 * The query selects the whole table where a reading that ignores the question's words differs a lot
 * from one that applies them (wildfire-hard-17: all 2,965 stations against the 759 used by fire records).
 */
const unfaithfulReadingUsed = (sql: string, decision: FrameDecision): AnswerChallenge | undefined => {
  for (const option of decision.options) {
    const words = blockedUnfaithfulWords(decision, option);
    if (!words || option.sqlWhere !== null || !readsTable(sql, option.table)) continue;
    const faithful = decision.options.find((candidate) => candidate !== option && candidate.status === "checked"
      && candidate.table === option.table && (candidate.unappliedWords ?? []).length === 0 && candidate.sqlWhere);
    if (!faithful?.sqlWhere || appliesAny(sql, faithful)) continue;
    return {
      code: "READING_IGNORES_QUESTION",
      message: `Your answer uses every row of ${option.table} (${option.rows}), which leaves out the question's words `
        + `${words.map((word) => `"${word}"`).join(", ")}. The reading "${faithful.label}" applies them and selects `
        + `${faithful.rows} rows (WHERE ${faithful.sqlWhere}). Check which one the question means; if it is that one, recompute.`,
      evidence: { table: option.table, allRows: option.rows, faithfulRows: faithful.rows, faithfulWhere: faithful.sqlWhere }
    };
  }
  return undefined;
};

/** Whether the SQL mentions a column or table that the reading's filter uses: a lenient test of "applied". */
const appliesAny = (sql: string, option: FrameOption): boolean => {
  const identifiers = [...(option.sqlWhere ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "")
    .filter((name) => name && name !== option.table);
  return identifiers.some((name) => mentions(sql, name));
};

const gap = (all: number | undefined, part: number | undefined): number =>
  all !== undefined && part !== undefined && all > 0 ? (all - part) / all : 0;

const readsTable = (sql: string, table: string): boolean => mentions(sql, table);

const mentions = (sql: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])"?${escaped}"?($|[^A-Za-z0-9_])`, "iu").test(sql);
};
