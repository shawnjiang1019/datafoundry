/** Shared helpers: identifier quoting, term extraction, and column type classes. */

const STOP_TERMS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "what", "which", "how",
  "many", "much", "used", "data", "dataset", "number", "value", "values", "according", "based",
  "each", "their", "into", "per", "only", "answer", "average", "total", "find", "give", "does",
  "described", "defined", "unnamed", "description", "variable", "name", "alternative"
]);

const ID_NAME = /(^|[\s_])(id|ids|code|key|no|num|number|identifier)$/iu;
const ID_TEXT = /\b(id|identifier|identifying|number|code)\b/iu;

export const quoteIdent = (identifier: string): string => `"${identifier.replace(/"/gu, '""')}"`;

/** Lowercased content terms: split camelCase and punctuation, drop stop words, naive singular. */
export const terms = (text: string | undefined): Set<string> => {
  const out = new Set<string>();
  const spaced = (text ?? "").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
  for (const token of spaced.split(/[^a-z0-9]+/u)) {
    if (token.length < 3 || STOP_TERMS.has(token) || /^\d+$/u.test(token)) {
      continue;
    }
    out.add(token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token);
  }
  return out;
};

export const intersect = (left: Set<string>, right: Set<string>): string[] =>
  [...left].filter((term) => right.has(term)).sort();

/** Named like an identifier, or described as one by the dictionary. */
export const isIdentifierLike = (column: string, description?: string): boolean =>
  ID_NAME.test(column.trim()) || ID_TEXT.test(description ?? "");

export type TypeClass = "integer" | "float" | "string" | "temporal" | "boolean" | "other";

export const typeClass = (sqlType: string): TypeClass => {
  const type = sqlType.toUpperCase();
  if (type === "BOOLEAN" || type === "BOOL") return "boolean";
  if (/^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?\d*|U?HUGEINT|INT\d+)$/u.test(type)) return "integer";
  if (/^(DOUBLE|FLOAT\d*|REAL|DECIMAL|NUMERIC)/u.test(type)) return "float";
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/u.test(type)) return "string";
  if (/^(DATE|TIME|TIMESTAMP|INTERVAL)/u.test(type)) return "temporal";
  return "other";
};

/** Join keys are integers or strings; floats are measures and booleans overlap trivially. */
export const isKeyType = (sqlType: string): boolean => {
  const kind = typeClass(sqlType);
  return kind === "integer" || kind === "string";
};

/**
 * DataLink JoinableInferrer._compatible_dtypes: numeric with numeric, string with string,
 * temporal with temporal, and numeric with string because identifiers are stored as either.
 */
export const typesCompatible = (left: string, right: string): boolean => {
  const a = typeClass(left);
  const b = typeClass(right);
  if (a === "boolean" || b === "boolean" || a === "other" || b === "other") return false;
  const numeric = (kind: TypeClass) => kind === "integer" || kind === "float";
  if (numeric(a) && numeric(b)) return true;
  if (a === "string" && b === "string") return true;
  if (a === "temporal" && b === "temporal") return true;
  return (numeric(a) && b === "string") || (a === "string" && numeric(b));
};

export const normalizedName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/gu, "");
