/**
 * Pre-action verifier: checks every governed action before it runs and rejects harmful ones.
 *
 * It plugs into the ActionRouter's existing `serverPolicy` slot, so a rejected action never
 * reaches its executor; the router records the rejection as a protocol event with the reason
 * code, which keeps every block visible in the run's trajectory.
 *
 * Read-only enforcement (SELECT/WITH only, no write keywords) already happens in the data
 * gateway. This verifier adds what that guard does not cover:
 *
 * - external_access: a DuckDB SELECT can read files, URLs, environment variables or run
 *   dynamic SQL through table functions (`read_csv('/path')`, `getenv('KEY')`, `query('...')`)
 *   or by naming a file as a table (`FROM '/path/answers.csv'`). Those reach outside the
 *   registered datasource, so they are blocked.
 * - datasource_scope: a `datasource_id` argument must be one of the run's enabled datasources.
 *
 * Opt-in: set DF_PRE_ACTION_VERIFY=1. Without it the router keeps its default allow-all policy.
 */

import type { ProtocolGuardResult } from "../protocol/types.js";

export const PRE_ACTION_VERIFY_VARIABLE = "DF_PRE_ACTION_VERIFY";

export type PreActionRule = "external_access" | "datasource_scope";

export const PRE_ACTION_REASON_CODES: Record<PreActionRule, string> = {
  external_access: "PRE_ACTION_EXTERNAL_ACCESS",
  datasource_scope: "PRE_ACTION_DATASOURCE_SCOPE"
};

export type PreActionVerifierOptions = {
  /** The run's enabled datasources; when empty or absent the scope rule does not apply. */
  enabledDatasourceIds?: readonly string[];
};

export type PreActionPolicy = (input: { actionName: string; input: unknown }) => ProtocolGuardResult;

/** DuckDB table and scalar functions that read files, URLs, other databases, env or run SQL text. */
const EXTERNAL_FUNCTIONS = [
  "read_csv",
  "read_csv_auto",
  "sniff_csv",
  "read_parquet",
  "parquet_scan",
  "parquet_metadata",
  "parquet_schema",
  "parquet_file_metadata",
  "parquet_kv_metadata",
  "read_json",
  "read_json_auto",
  "read_json_objects",
  "read_json_objects_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "read_ndjson_objects",
  "read_text",
  "read_blob",
  "read_xlsx",
  "read_avro",
  "glob",
  "getenv",
  "query",
  "query_table",
  "sqlite_scan",
  "sqlite_attach",
  "postgres_scan",
  "postgres_attach",
  "mysql_scan",
  "delta_scan",
  "iceberg_scan",
  "iceberg_metadata"
];

const EXTERNAL_FUNCTION_PATTERN = new RegExp(`\\b(${EXTERNAL_FUNCTIONS.join("|")})\\s*\\(`, "iu");

/** A quoted string used as a table source is a DuckDB file or URL scan. */
const QUOTED_TABLE_SOURCE_PATTERN = /\b(?:FROM|JOIN)\s+'/iu;

/** A double-quoted identifier that looks like a path, URL or data file is also scanned as one. */
const QUOTED_IDENTIFIER_SOURCE_PATTERN = /\b(?:FROM|JOIN)\s+"([^"]|"")*"/giu;
const FILE_LIKE_PATTERN =
  /[\\/]|:\/\/|\.(csv|tsv|txt|parquet|json|jsonl|ndjson|xlsx|xls|arrow|avro|db|duckdb|sqlite|gz|zst)$/iu;

export const createPreActionVerifier = (options: PreActionVerifierOptions = {}): PreActionPolicy => {
  const enabledDatasources = new Set(options.enabledDatasourceIds ?? []);
  return ({ actionName, input }) => {
    const args = isRecord(input) ? input : {};

    if (typeof args.sql === "string") {
      const finding = findExternalAccess(args.sql);
      if (finding) {
        return reject("external_access", `${actionName}: ${finding}`);
      }
    }

    if (
      enabledDatasources.size > 0
      && typeof args.datasource_id === "string"
      && args.datasource_id.length > 0
      && !enabledDatasources.has(args.datasource_id)
    ) {
      return reject("datasource_scope", `${actionName}: datasource '${args.datasource_id}' is not enabled for this run`);
    }

    return { allowed: true };
  };
};

/** Returns why the SQL reaches outside the registered datasource, or undefined when it does not. */
export const findExternalAccess = (sql: string): string | undefined => {
  const withoutComments = stripSqlComments(sql);
  const withoutStrings = withoutComments.replace(/'([^']|'')*'/gu, "''");

  const fn = EXTERNAL_FUNCTION_PATTERN.exec(withoutStrings.replace(/"([^"]|"")*"/gu, '""'));
  if (fn) {
    return `function ${fn[1]?.toLowerCase()}() reads outside the datasource`;
  }
  if (QUOTED_TABLE_SOURCE_PATTERN.test(withoutComments)) {
    return "a quoted string used as a table reads a file or URL";
  }
  for (const match of withoutStrings.matchAll(QUOTED_IDENTIFIER_SOURCE_PATTERN)) {
    const identifier = match[0].replace(/^\w+\s+"/u, "").replace(/"$/u, "");
    if (FILE_LIKE_PATTERN.test(identifier)) {
      return `table "${identifier}" looks like a file or URL`;
    }
  }
  return undefined;
};

/** Build the policy from the environment; undefined keeps the router's default allow-all. */
export const preActionVerifierFromEnvironment = (
  env: Record<string, string | undefined>,
  options: PreActionVerifierOptions = {}
): PreActionPolicy | undefined =>
  env[PRE_ACTION_VERIFY_VARIABLE] === "1" ? createPreActionVerifier(options) : undefined;

const reject = (rule: PreActionRule, message: string): ProtocolGuardResult => ({
  allowed: false,
  reasonCode: PRE_ACTION_REASON_CODES[rule],
  message
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Remove -- and block comments while keeping quoted text intact. */
const stripSqlComments = (sql: string): string => {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1];
    if (quote) {
      result += char;
      if (char === quote && next === quote) {
        result += next;
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += char;
      continue;
    }
    if (char === "-" && next === "-") {
      while (index + 1 < sql.length && sql[index + 1] !== "\n") {
        index += 1;
      }
      result += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
};
