import type { GroundingSchema, GroundingSqlProbe, LakeSemantics, SemanticFact } from "./types.js";
import { quoteIdent, typeClass } from "./vocabulary.js";

const DICTIONARY_MAX_COLUMNS = 8;
const DICTIONARY_MAX_ROWS = 1000;
const DICTIONARY_KEY_UNIQUENESS = 0.95;
const DICTIONARY_PROSE_MIN_AVG_LENGTH = 20;
const DICTIONARY_MIN_COVERAGE = 0.5;
const DESCRIBED_TABLE_MIN_COLUMNS = 4;
const EMPTY_TEXT = new Set(["", "none", "nan", "null", "n/a"]);

/**
 * Read the lake's own documentation and structure once per datasource revision.
 *
 * A data dictionary is detected from the data, not from its name: a narrow table whose
 * unique text column names most of another table's columns, next to a prose column.
 * A table merely holding codes that happen to match a wide table's headers has no prose
 * and is not mistaken for one.
 */
export const readLakeSemantics = async (
  schema: GroundingSchema,
  strictProbe: GroundingSqlProbe
): Promise<LakeSemantics> => {
  // One unreadable table (a column name the engine cannot bind, a type it cannot cast)
  // must cost only that table, not every fact about the lake.
  const probe = async (sql: string) => {
    try {
      return await strictProbe(sql);
    } catch {
      return { columns: [], rows: [] };
    }
  };
  const facts: SemanticFact[] = [];
  const dictionaryTables: string[] = [];
  for (const table of schema.tables) {
    const textColumns = table.columns.filter((column) => typeClass(column.type) === "string");
    if (table.columns.length > DICTIONARY_MAX_COLUMNS || textColumns.length < 2) {
      continue;
    }
    // The gateway returns at most 1000 rows, so a full page means the table is too large.
    const result = await probe(
      `SELECT ${textColumns.map((column) => quoteIdent(column.name)).join(", ")} `
      + `FROM ${quoteIdent(table.name)} LIMIT ${DICTIONARY_MAX_ROWS}`
    );
    if (result.rows.length < 2 || result.rows.length >= DICTIONARY_MAX_ROWS) {
      continue;
    }
    const tableFacts = dictionaryFacts(table.name, textColumns.map((column) => column.name), result.rows, schema);
    if (tableFacts.length > 0) {
      dictionaryTables.push(table.name);
      facts.push(...tableFacts);
    }
  }
  return { facts, dictionaryTables, duplicateTables: await findDuplicateTables(schema, probe) };
};

const dictionaryFacts = (
  dictionaryTable: string,
  columns: string[],
  rows: unknown[][],
  schema: GroundingSchema
): SemanticFact[] => {
  const cell = (row: unknown[], index: number): string => {
    const value = row[index];
    return value === null || value === undefined ? "" : String(value).trim();
  };
  const prose = columns.map((_, index) => {
    const lengths = rows.map((row) => cell(row, index).length);
    return lengths.reduce((sum, length) => sum + length, 0) / rows.length >= DICTIONARY_PROSE_MIN_AVG_LENGTH;
  });
  for (const [keyIndex, keyColumn] of columns.entries()) {
    const keys = rows.map((row) => cell(row, keyIndex)).filter((value) => value.length > 0);
    if (new Set(keys).size < rows.length * DICTIONARY_KEY_UNIQUENESS) {
      continue;
    }
    if (!prose.some((isProse, index) => isProse && index !== keyIndex)) {
      continue;
    }
    const keyIndexByName = new Map(keys.map((key) => [key.toUpperCase(), key]));
    const facts: SemanticFact[] = [];
    for (const table of schema.tables) {
      if (table.name === dictionaryTable || table.columns.length < DESCRIBED_TABLE_MIN_COLUMNS) {
        continue;
      }
      const described = table.columns.filter((column) => keyIndexByName.has(column.name.trim().toUpperCase()));
      if (described.length / table.columns.length < DICTIONARY_MIN_COVERAGE) {
        continue;
      }
      for (const column of described) {
        const key = keyIndexByName.get(column.name.trim().toUpperCase()) as string;
        const row = rows.find((candidate) => cell(candidate, keyIndex) === key) as unknown[];
        const text = columns
          .map((_, index) => (index === keyIndex ? "" : cell(row, index)))
          .filter((value) => !EMPTY_TEXT.has(value.toLowerCase()))
          .join(" | ");
        if (text) {
          facts.push({
            subject: { table: table.name, column: column.name },
            text,
            source: { kind: "dictionary_table", ref: `${dictionaryTable}.${keyColumn} = '${key}'` },
            extractedBy: "deterministic"
          });
        }
      }
    }
    if (facts.length > 0) {
      return facts;
    }
  }
  return [];
};

/** Same column names, same row count, and no row of one missing from the other. */
const findDuplicateTables = async (
  schema: GroundingSchema,
  probe: GroundingSqlProbe
): Promise<Array<[string, string]>> => {
  const byColumns = new Map<string, string[]>();
  for (const table of schema.tables) {
    if (table.columns.length < 2) continue;
    const signature = table.columns.map((column) => column.name).sort().join("\u0000");
    byColumns.set(signature, [...(byColumns.get(signature) ?? []), table.name]);
  }
  const duplicates: Array<[string, string]> = [];
  for (const [signature, tables] of byColumns) {
    const columnList = signature.split("\u0000").map(quoteIdent).join(", ");
    const sorted = [...tables].sort();
    for (let left = 0; left < sorted.length; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        const a = quoteIdent(sorted[left] as string);
        const b = quoteIdent(sorted[right] as string);
        const result = await probe(
          `SELECT (SELECT COUNT(*) FROM ${a}) AS left_rows, (SELECT COUNT(*) FROM ${b}) AS right_rows, `
          + `(SELECT COUNT(*) FROM (SELECT ${columnList} FROM ${a} EXCEPT SELECT ${columnList} FROM ${b})) AS missing`
        );
        const [leftRows, rightRows, missing] = (result.rows[0] ?? []).map(Number);
        if (leftRows === rightRows && missing === 0 && (leftRows ?? 0) > 0) {
          duplicates.push([sorted[left] as string, sorted[right] as string]);
        }
      }
    }
  }
  return duplicates;
};
