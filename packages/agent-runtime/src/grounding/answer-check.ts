import { computesAggregate, filtersOnColumn } from "../protocol/sql-semantic-validator.js";
import { blockedUnfaithfulWords, type FrameDecision, type FrameOption } from "./answer-frame.js";
import type { DefinedMeasure } from "./defined-measures.js";
import type { EvidenceGroundingContext } from "./types.js";
import { intersect, terms } from "./vocabulary.js";

/** Readings this far apart are a real difference in the answer, not a rounding of the population. */
const MIN_POPULATION_GAP = 0.25;
/** A flag that marks fewer rows than this share is not worth a challenge. */
const MIN_FLAGGED_SHARE = 0.05;

export type AnswerChallenge = {
  code: "LINKED_POPULATION_IGNORED" | "EXCLUSION_FLAG_IGNORED" | "READING_IGNORES_QUESTION" | "DEFINED_MEASURE_IGNORED";
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
      if (defined?.kind === "flag" && whole && !appliesFlag(sql, defined.column, input.question)
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
  return definedMeasureIgnored(sql, input.grounding?.measures ?? [], input.question);
};

/**
 * The question asks for a measure the data already states, and the answer's query never reads it.
 * A named measure counts when the question names the column outright; a stated share only when the
 * query is about the category it states (its label appears in the SQL), so an unrelated query is
 * never challenged for it.
 */
const definedMeasureIgnored = (sql: string, measures: DefinedMeasure[], question: string): AnswerChallenge | undefined => {
  // The mistake is recomputing: a query that only looks rows up has nothing to compare (biomedical-hard-3
  // ended right with a one-patient lookup after reading APP_Z_score in an earlier query).
  if (!computesOwnFigure(sql)) return undefined;
  for (const measure of measures) {
    if (measure.kind === "named") {
      if (mentions(sql, measure.column)) continue;
      return {
        code: "DEFINED_MEASURE_IGNORED",
        message: `The question asks about "${measure.phrase}", and ${measure.table} already has a column ${measure.column} `
          + "with that measure. Your query does not read it: if the question means that value, use the column "
          + "instead of computing your own version.",
        evidence: { table: measure.table, column: measure.column }
      };
    }
    // A stated share is a figure to point at only when it is one value; a label on several rows (one per
    // year, or split into sub-categories) states no single figure. legal-hard-17 (2026-11-04), told only
    // that "a Percentage" existed, summed seven sub-category rows to 3.08% instead of the stated 2.28%.
    // It matters when the question is about shares: "Identity Theft" is named by nearly every legal question.
    if (!measure.value || !SHARE_QUESTION.test(question)) continue;
    // Reading that table's column is using the stated figure; another table's Percentage is not.
    if (mentions(sql, measure.table) && mentions(sql, measure.column)) continue;
    if (!sql.toLowerCase().includes(measure.label.toLowerCase())) continue;
    return {
      code: "DEFINED_MEASURE_IGNORED",
      message: `The data states the share for "${measure.label}" directly: ${measure.table}.${measure.column} = `
        + `${measure.value}. Your query computes the share another way: if the question means the stated figure, `
        + "use that value.",
      evidence: { table: measure.table, column: measure.column, label: measure.label, value: measure.value }
    };
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

/** Questions about a share or distribution, where a stated percentage is the figure asked for. */
const SHARE_QUESTION = /\b(?:distribut\w*|percent(?:age)?|share|proportion|fraction|rate)\b/iu;

/**
 * The query computes a figure of its own: a division, or a spread statistic (a z-score). String literals
 * and quoted names are left out, so a date like '2024/01' or a column named "Reports/Day" does not count.
 */
const computesOwnFigure = (sql: string): boolean => {
  const code = sql.replace(/'(?:[^']|'')*'/gu, "''").replace(/"(?:[^"]|"")*"/gu, "x");
  return /\/|\b(?:stddev\w*|stdev\w*|variance|var_pop|var_samp)\s*\(/iu.test(code);
};

/** Questions answered by a calculation over many rows, not by looking up one. */
const AGGREGATE_QUESTION = /\b(?:average|mean|median|sum|total|count|how many|number of|percent(?:age)?|proportion|share|ratio|rate)\b/iu;

/**
 * Whether the answer's query took the flag into account.
 *
 * Where the flag decides which rows count, it sits in a filter (WHERE, JOIN ON, HAVING, CASE, GROUP BY).
 * A query that only lists it is enough for a lookup: biomedical-hard-3 (2026-11-03) read one patient's
 * Case_excluded to see whether to keep that patient, and was right. It is not enough when the answer is a
 * calculation the query does not do: biomedical-easy-2 listed the 14 serous rows with their flag and
 * averaged all of them, excluded ones included. SQL the parser cannot read falls back to "mentions the
 * column", so an unreadable query is never challenged for it.
 */
const appliesFlag = (sql: string, column: string, question: string): boolean => {
  const filtered = filtersOnColumn(sql, "duckdb", column);
  if (filtered === undefined) return mentions(sql, column);
  if (filtered) return true;
  const listingForALookup = computesAggregate(sql, "duckdb") === false && !AGGREGATE_QUESTION.test(question);
  return listingForALookup && mentions(sql, column);
};

const gap = (all: number | undefined, part: number | undefined): number =>
  all !== undefined && part !== undefined && all > 0 ? (all - part) / all : 0;

const readsTable = (sql: string, table: string): boolean => mentions(sql, table);

const mentions = (sql: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])"?${escaped}"?($|[^A-Za-z0-9_])`, "iu").test(sql);
};
