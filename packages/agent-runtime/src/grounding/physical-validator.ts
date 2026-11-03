import type { GroundingCandidate, GroundingSchema, GroundingSqlProbe, PhysicalEvidence } from "./types.js";
import { quoteIdent, typesCompatible } from "./vocabulary.js";

/**
 * Physical evidence for each candidate, computed over the full distinct value sets in SQL.
 *
 * DataLink's JoinableInferrer compares top-10 values plus 5 samples and skips columns with
 * more than 900 distinct values; on KramaBench wildfire-hard-17 it returns no edge at all.
 * Here containment is exact, and values are compared in two forms: trimmed upper-case text,
 * and integral numbers. The numeric form is what matches `41018` against `'041018'`;
 * text alone finds 437 of 779 station IDs there and leads to the wrong population.
 */
export const validateCandidates = async (
  candidates: GroundingCandidate[],
  schema: GroundingSchema,
  probe: GroundingSqlProbe
): Promise<GroundingCandidate[]> => {
  const typeOf = new Map(schema.tables.flatMap((table) =>
    table.columns.map((column) => [`${table.name}\u0000${column.name}`, column.type] as const)));
  const validated: GroundingCandidate[] = [];
  for (const candidate of candidates) {
    const fromType = typeOf.get(`${candidate.from.table}\u0000${candidate.from.column}`) ?? "UNKNOWN";
    const toType = typeOf.get(`${candidate.to.table}\u0000${candidate.to.column}`) ?? "UNKNOWN";
    const typeCompatible = typesCompatible(fromType, toType);
    if (!typeCompatible) {
      validated.push({
        ...candidate,
        physicalEvidence: emptyEvidence(`${fromType}->${toType}`)
      });
      continue;
    }
    try {
      const result = await probe(containmentSql(candidate));
      validated.push({ ...candidate, physicalEvidence: toEvidence(result.rows[0] ?? [], `${fromType}->${toType}`) });
    } catch {
      // Left without physical evidence: the gate reports it as not validated.
      validated.push(candidate);
    }
  }
  return validated;
};

/** One aggregate row per pair, so the gateway's row limit never truncates the evidence. */
export const containmentSql = (candidate: GroundingCandidate): string => {
  const normalized = (column: string) => `UPPER(TRIM(CAST(${quoteIdent(column)} AS VARCHAR)))`;
  const numeric = (column: string) => `TRY_CAST(TRIM(CAST(${quoteIdent(column)} AS VARCHAR)) AS DOUBLE)`;
  const side = (ref: GroundingCandidate["from"]) =>
    `SELECT DISTINCT ${normalized(ref.column)} AS t, ${numeric(ref.column)} AS n `
    + `FROM ${quoteIdent(ref.table)} WHERE ${quoteIdent(ref.column)} IS NOT NULL`;
  return [
    `WITH s AS (${side(candidate.from)}), g AS (${side(candidate.to)})`,
    "SELECT",
    "(SELECT COUNT(DISTINCT t) FROM s) AS from_distinct,",
    "(SELECT COUNT(DISTINCT t) FROM g) AS to_distinct,",
    `(SELECT COUNT(${quoteIdent(candidate.to.column)}) FROM ${quoteIdent(candidate.to.table)}) AS to_non_null,`,
    "(SELECT COUNT(DISTINCT s.t) FROM s JOIN g ON s.t = g.t) AS text_matched,",
    "(SELECT COUNT(DISTINCT s.t) FROM s JOIN g ON s.n = g.n WHERE s.n = FLOOR(s.n)) AS numeric_matched"
  ].join(" ");
};

const toEvidence = (row: unknown[], types: string): PhysicalEvidence => {
  const [fromDistinct, toDistinct, toNonNull, textMatched, numericMatched] = row.map((value) => Number(value ?? 0));
  const from = fromDistinct ?? 0;
  const numericWins = (numericMatched ?? 0) > (textMatched ?? 0);
  const matched = numericWins ? numericMatched ?? 0 : textMatched ?? 0;
  return {
    fromDistinct: from,
    toDistinct: toDistinct ?? 0,
    toNonNull: toNonNull ?? 0,
    matched,
    containment: from > 0 ? round(matched / from) : 0,
    form: numericWins ? "numeric" : "text",
    textOnlyContainment: from > 0 ? round((textMatched ?? 0) / from) : 0,
    targetUniqueRate: (toNonNull ?? 0) > 0 ? round((toDistinct ?? 0) / (toNonNull ?? 1)) : 0,
    typeCompatible: true,
    types
  };
};

const emptyEvidence = (types: string): PhysicalEvidence => ({
  fromDistinct: 0,
  toDistinct: 0,
  toNonNull: 0,
  matched: 0,
  containment: 0,
  form: "text",
  textOnlyContainment: 0,
  targetUniqueRate: 0,
  typeCompatible: false,
  types
});

const round = (value: number): number => Math.round(value * 1000) / 1000;
