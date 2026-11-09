/**
 * Scale note: a hint attached to a SQL result that carries values from a log-scale column without
 * converting them back. A stored log column is how the data is kept, not necessarily the scale the
 * question asks for, and agents tend to report it as given. The note only asks; it never blocks.
 */

const LOG_TOKENS = new Set(["log", "log2", "log10", "ln", "log1p"]);
// Any conversion back to the plain scale in the query means the agent already handled the scale.
const INVERSE = /\b(power|pow|exp|exp2|exp10)\s*\(|\*\*|\^/i;
// Results that do not depend on the scale (correlations, ranks, counts, ratios, tests).
const SCALE_FREE_SQL = /\b(corr|covar_\w*|regr_\w*|rank|dense_rank|percent_rank|ntile|row_number)\s*\(/i;
const SCALE_FREE_COLUMN =
  /(corr|rho|spearman|pearson|count|^n$|^n_|_n$|rank|ratio|pval|p_value|fdr|qval|zscore|z_score|tstat|pct|percent)/i;
const AGGREGATE_OF = /\b(median|avg|mean|sum|quantile\w*|percentile\w*|min|max|stddev\w*|var\w*)\s*\(([^()]*)\)/gi;
const IDENTIFIER = /"([^"]+)"|`([^`]+)`|\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;

/** Words of an identifier: split on non-alphanumerics, underscores and lower→Upper case changes. */
const words = (name: string): string[] =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export const isLogScaleName = (name: string): boolean => words(name).some((word) => LOG_TOKENS.has(word));

const stripLiterals = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''");

const logIdentifiers = (sql: string): string[] => {
  const found = new Set<string>();
  for (const match of sql.matchAll(IDENTIFIER)) {
    const name = match[1] ?? match[2] ?? match[3] ?? "";
    if (isLogScaleName(name)) found.add(name);
  }
  return [...found];
};

/**
 * The note for one result, or undefined. It fires when the query reads a log-scale column, does not
 * convert back, is not scale-free, and the log value reaches the result: a result column named as
 * log, or an aggregate taken over a log column. `alreadyNoted` holds columns noted earlier this run.
 */
export const scaleNote = (sql: string, resultColumns: string[], alreadyNoted: Set<string> = new Set()): string | undefined => {
  const body = stripLiterals(sql);
  if (INVERSE.test(body) || SCALE_FREE_SQL.test(body)) return undefined;
  const logColumns = logIdentifiers(body);
  if (logColumns.length === 0) return undefined;
  const valueColumns = resultColumns.filter((column) => !SCALE_FREE_COLUMN.test(column));
  const loggedResult = valueColumns.some(isLogScaleName);
  const aggregatedLog = [...body.matchAll(AGGREGATE_OF)].some((match) => logIdentifiers(match[2] ?? "").length > 0);
  if (valueColumns.length === 0 || (!loggedResult && !aggregatedLog)) return undefined;
  const fresh = logColumns.filter((column) => !alreadyNoted.has(column));
  if (fresh.length === 0) return undefined;
  fresh.forEach((column) => alreadyNoted.add(column));
  return `Scale check: this result uses log-scale column ${fresh.join(", ")} without converting back. `
    + "Answer in the units the question names. A column's name, how the data is stored, or an unconfirmed "
    + "assumption does not mean the question wants log values. If the question names the quantity itself "
    + "(a number, amount or level) and not its log, convert each value back first (2^x for log2, 10^x for "
    + "log10, exp(x) for ln/log) and then aggregate. Keep the log scale only when the question's own words ask "
    + "for a log value (for example \"log2 fold change\"), and say so in the answer.";
};
