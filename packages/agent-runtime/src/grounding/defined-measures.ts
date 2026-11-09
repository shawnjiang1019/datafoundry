import type { GroundingSchema, GroundingSqlProbe } from "./types.js";
import { quoteIdent, typeClass } from "./vocabulary.js";

/**
 * A measure the data already defines for the question, so an answer that computes its own version is
 * suspect. Two kinds, both found without a model call:
 *
 * - named: the question names a numeric column outright. biomedical-hard-3 asks for "the lowest APP-Z
 *   score" and the data has APP_Z_score; answers that rebuilt a z-score from raw values were wrong.
 * - share: a table states a percentage for a category the question names. legal-hard-17 asks about
 *   "Auto Related" reports; 2024_CSN_Report_Categories has Percentage = 2.28% for it, and the answer that
 *   divided report counts itself (2.29%) came out 32,587 instead of 32,542.
 */
export type DefinedMeasure =
  | { kind: "named"; table: string; column: string; phrase: string }
  | { kind: "share"; table: string; column: string; labelColumn: string; label: string; value?: string };

/** Words that mark a column as a measure rather than an attribute (age, year, name). */
const MEASURE_WORDS = new Set(["score", "z", "index", "rate", "ratio", "percentage", "percent", "pct", "share", "proportion"]);
/** Column names of a stated share, matched whole so "Percentage Reporting $ Loss" is not one. */
const SHARE_COLUMN = /^(?:percent(?:age)?|pct|share|proportion)$/iu;
const MAX_LABELS = 300;
const MIN_LABEL_CHARS = 4;
const MAX_MEASURES = 4;

export const definedMeasures = async (input: {
  question: string;
  schema: GroundingSchema;
  probe: GroundingSqlProbe;
}): Promise<DefinedMeasure[]> => {
  const measures = [...namedMeasures(input.question, input.schema), ...await statedShares(input.question, input.schema, input.probe)];
  return measures.slice(0, MAX_MEASURES);
};

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);

/** Numeric columns whose whole name (two or more words, one of them a measure word) the question uses. */
export const namedMeasures = (question: string, schema: GroundingSchema): DefinedMeasure[] => {
  const asked = new Set(words(question));
  return schema.tables.flatMap((table) => table.columns.flatMap((column) => {
    const name = words(column.name);
    const numeric = ["integer", "float"].includes(typeClass(column.type));
    if (!numeric || name.length < 2 || !name.some((word) => MEASURE_WORDS.has(word))) return [];
    if (!name.every((word) => asked.has(word))) return [];
    return [{ kind: "named" as const, table: table.name, column: column.name, phrase: name.join(" ") }];
  }));
};

/**
 * Stated shares: in a table with a Percentage (or Share) column, the rows whose label the question names,
 * with the stated value read from the data.
 */
export const statedShares = async (question: string, schema: GroundingSchema, probe: GroundingSqlProbe): Promise<DefinedMeasure[]> => {
  const asked = ` ${words(question).join(" ")} `;
  const found: DefinedMeasure[] = [];
  for (const table of schema.tables) {
    const share = table.columns.find((column) => SHARE_COLUMN.test(column.name.trim()));
    if (!share) continue;
    for (const label of table.columns.filter((column) => column !== share && typeClass(column.type) === "string")) {
      const rows = await safeProbe(probe,
        `SELECT DISTINCT CAST(${quoteIdent(label.name)} AS VARCHAR) AS label, CAST(${quoteIdent(share.name)} AS VARCHAR) AS value `
        + `FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(label.name)} IS NOT NULL LIMIT ${MAX_LABELS}`);
      // One label can have several rows (one per year): the stated value is kept only when it is unique.
      const values = new Map<string, Set<string>>();
      for (const [rawLabel, value] of rows) {
        const text = String(rawLabel ?? "").trim();
        const phrase = words(text).join(" ");
        // A label of real words: years and counts ("2024", "1,500") match any question that names them.
        if (text.length < MIN_LABEL_CHARS || !/[a-z]{3}/iu.test(text) || !phrase || !asked.includes(` ${phrase} `)) continue;
        values.set(text, (values.get(text) ?? new Set()).add(String(value ?? "")));
      }
      for (const [text, stated] of values) {
        found.push({
          kind: "share", table: table.name, column: share.name, labelColumn: label.name, label: text,
          ...(stated.size === 1 ? { value: [...stated][0] as string } : {})
        });
      }
    }
  }
  return found;
};

const safeProbe = async (probe: GroundingSqlProbe, sql: string): Promise<unknown[][]> => {
  try {
    return (await probe(sql)).rows;
  } catch {
    return [];
  }
};
