import type { FrameDecision } from "./answer-frame.js";
import type { GroundingSchema, GroundingSqlProbe } from "./types.js";
import { intersect, quoteIdent, terms, typeClass } from "./vocabulary.js";

const MAX_FLAG_VALUES = 5;
const MAX_FLAG_DECISIONS = 2;
const EXCLUSION_COLUMN = /exclu/iu;
const INCLUSION_COLUMN = /(?:includ|eligib|valid)/iu;
const TRUE_VALUE = /^(?:y|yes|true|t|1|excluded|included|eligible|valid)$/iu;

/** A join grounding verified on the full data, with the condition that matches it. */
export type VerifiedLink = { fromTable: string; toTable: string; condition: string };

/**
 * Readings of the question that the data itself defines, built without a model call so they are
 * the same in every run. The model-proposed frame varies between runs: on 2026-10-16 the same
 * wildfire-hard-17 question got the "stations used by fire records" reading in one run and only
 * readings that matched 0 rows in another, so the notes fixed the task in one run and not the next.
 * These readings come first; the model's readings are added after them.
 */
export const definedReadings = async (input: {
  question: string;
  schema: GroundingSchema;
  links: VerifiedLink[];
  probe: GroundingSqlProbe;
}): Promise<FrameDecision[]> => [
  ...linkedPopulations(input.links),
  ...await flagPopulations(input.question, input.schema, input.probe)
];

/**
 * A verified link that column names alone would miss defines a population: the rows of the referenced
 * table that the other table actually uses (wildfire-hard-17's stations referenced by NOAA fire records).
 */
export const linkedPopulations = (links: VerifiedLink[]): FrameDecision[] => {
  const seen = new Set<string>();
  return links.flatMap((link) => {
    const key = `${link.fromTable}->${link.toTable}`;
    if (seen.has(key) || link.fromTable === link.toTable) return [];
    seen.add(key);
    return [{
      aspect: "population" as const,
      questionPhrase: `which ${link.toTable} rows count`,
      options: [
        { label: `every row of ${link.toTable}`, table: link.toTable, sqlWhere: null, keyColumns: [] },
        {
          label: `only ${link.toTable} rows that ${link.fromTable} refers to (verified link)`,
          table: link.toTable,
          sqlWhere: `EXISTS (SELECT 1 FROM ${quoteIdent(link.fromTable)} WHERE ${link.condition})`,
          keyColumns: [],
          definedBy: { kind: "link" as const, fromTable: link.fromTable }
        }
      ]
    }];
  });
};

/**
 * An exclusion or inclusion flag column defines a study population (biomedical-easy-2's
 * Case_excluded: the expected answer leaves the excluded cases out). Only tables whose names or
 * columns share a word with the question, and flags with a handful of values, are used.
 */
export const flagPopulations = async (
  question: string,
  schema: GroundingSchema,
  probe: GroundingSqlProbe
): Promise<FrameDecision[]> => {
  const asked = terms(question);
  const decisions: FrameDecision[] = [];
  for (const table of schema.tables) {
    if (decisions.length >= MAX_FLAG_DECISIONS) break;
    const vocabulary = terms([table.name, ...table.columns.map((column) => column.name)].join(" "));
    if (intersect(asked, vocabulary).length === 0) continue;
    for (const column of table.columns) {
      const exclusion = EXCLUSION_COLUMN.test(column.name);
      if (!exclusion && !INCLUSION_COLUMN.test(column.name)) continue;
      if (!["string", "boolean", "integer"].includes(typeClass(column.type))) continue;
      const values = await distinctValues(table.name, column.name, probe);
      if (!values || values.length < 2 || values.length > MAX_FLAG_VALUES) continue;
      const flagged = values.filter((value) => TRUE_VALUE.test(value.trim()));
      if (flagged.length === 0 || flagged.length === values.length) continue;
      const ref = `TRIM(CAST(${quoteIdent(column.name)} AS VARCHAR))`;
      const list = flagged.map((value) => `'${value.trim().replace(/'/gu, "''")}'`).join(", ");
      decisions.push({
        aspect: "population",
        questionPhrase: `which ${table.name} rows count (${column.name})`,
        options: [
          { label: `every row of ${table.name}, whatever ${column.name} says`, table: table.name, sqlWhere: null, keyColumns: [] },
          exclusion
            ? {
                label: `only rows not marked excluded by ${column.name}`,
                table: table.name,
                sqlWhere: `(${quoteIdent(column.name)} IS NULL OR ${ref} NOT IN (${list}))`,
                keyColumns: [],
                definedBy: { kind: "flag" as const, column: column.name }
              }
            : {
                label: `only rows marked included by ${column.name}`,
                table: table.name,
                sqlWhere: `${ref} IN (${list})`,
                keyColumns: [],
                definedBy: { kind: "flag" as const, column: column.name }
              }
        ]
      });
      if (decisions.length >= MAX_FLAG_DECISIONS) break;
    }
  }
  return decisions;
};

const distinctValues = async (table: string, column: string, probe: GroundingSqlProbe): Promise<string[] | undefined> => {
  try {
    const result = await probe(
      `SELECT DISTINCT CAST(${quoteIdent(column)} AS VARCHAR) AS v FROM ${quoteIdent(table)} `
      + `WHERE ${quoteIdent(column)} IS NOT NULL LIMIT ${MAX_FLAG_VALUES + 1}`
    );
    return result.rows.map((row) => String(row[0] ?? ""));
  } catch {
    return undefined;
  }
};
