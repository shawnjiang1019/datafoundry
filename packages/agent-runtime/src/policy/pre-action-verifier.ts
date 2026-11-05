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
 * - repeated_failure (opt-in, off by default): an action that failed the same way several times in
 *   a row is stopped. Failures are compared by error class, the reason code before its first ":".
 *   After a few blocked attempts one real attempt is let through. It is off by default because a
 *   repeated failure is a correctness and cost problem, not a safety one: on KramaBench
 *   (2026-11-04/05) every block turned a recoverable error into a run with no answer. Loops are
 *   bounded by the run timeout and reported by the post-run verifier instead.
 *
 * Opt-in: set DF_PRE_ACTION_VERIFY=1. Without it the router keeps its default allow-all policy.
 * DF_PRE_ACTION_MAX_REPEATED_FAILURES sets the streak that triggers a block (default 0 = off).
 */

import type { ProtocolActionRecord, ProtocolGuardResult } from "../protocol/types.js";

export const PRE_ACTION_VERIFY_VARIABLE = "DF_PRE_ACTION_VERIFY";
export const PRE_ACTION_MAX_REPEATED_FAILURES_VARIABLE = "DF_PRE_ACTION_MAX_REPEATED_FAILURES";
export const DEFAULT_MAX_REPEATED_FAILURES = 0;
/** Blocked attempts after which one real attempt is allowed again. */
export const REPEATED_FAILURE_COOLDOWN = 3;
/**
 * Error classes the agent cannot cause or fix by changing its approach: the checker could not
 * read the SQL, or the model provider failed. They never count toward a repeated-failure streak.
 */
export const NON_AGENT_ERROR_CLASSES = new Set([
  "SQL_SEMANTIC_PARSE_FAILED",
  "MODEL_UNAVAILABLE",
  "RATE_LIMIT",
  "AI_APICallError",
  "PROTOCOL_COMMIT_CONTENTION"
]);
/**
 * Contract and evidence checks: their failures may come from the check itself (a contract the model
 * wrote that no correct query satisfies, evidence the protocol never bound), so blocking the agent
 * cannot fix them and only ends the run without an answer. They never count toward a streak; the
 * error message and the post-run verifier handle them instead. (KramaBench 2026-11-04: hard-4,
 * hard-5 and easy-6 ended in such blocks with real evidence in hand.)
 */
export const CHECKER_DEPENDENT_ERROR_CLASSES = new Set([
  "QUERY_CONTRACT_VALIDATION_FAILED",
  "ANALYSIS_REQUIREMENT_EVIDENCE_INVALID",
  "ANALYSIS_CLAIM_VALUE_NOT_VERIFIED",
  "ANALYSIS_EVIDENCE_BINDING_INCOMPLETE"
]);

export type PreActionRule = "external_access" | "datasource_scope" | "repeated_failure";

export const PRE_ACTION_REASON_CODES: Record<PreActionRule, string> = {
  external_access: "PRE_ACTION_EXTERNAL_ACCESS",
  datasource_scope: "PRE_ACTION_DATASOURCE_SCOPE",
  repeated_failure: "PRE_ACTION_REPEATED_FAILURE"
};

export type PreActionVerifierOptions = {
  /** The run's enabled datasources; when empty or absent the scope rule does not apply. */
  enabledDatasourceIds?: readonly string[];
  /** Consecutive same-class failures of one action that trigger a block; 0 turns the rule off. */
  maxRepeatedFailures?: number;
};

export type PreActionPolicy = ((input: { actionName: string; input: unknown }) => ProtocolGuardResult) & {
  /** Connect the run's action history (the protocol state), available once the run's protocol exists. */
  attachHistory(history: () => readonly ProtocolActionRecord[]): void;
};

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
  const maxRepeated = options.maxRepeatedFailures ?? DEFAULT_MAX_REPEATED_FAILURES;
  let history: () => readonly ProtocolActionRecord[] = () => [];

  const policy = (({ actionName, input }) => {
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

    if (maxRepeated > 0) {
      const streak = repeatedFailureStreak(safeHistory(history), actionName);
      if (streak.failures >= maxRepeated && streak.blockedSince < REPEATED_FAILURE_COOLDOWN) {
        // The agent only sees the reason code, so the code itself names the error it keeps hitting.
        return {
          allowed: false,
          reasonCode: `${PRE_ACTION_REASON_CODES.repeated_failure}:${streak.errorClass}`,
          message: `${actionName} failed ${streak.failures} times in a row with ${streak.errorClass}; `
            + "change approach instead of retrying the same step"
        };
      }
    }

    return { allowed: true };
  }) as PreActionPolicy;
  policy.attachHistory = (source) => {
    history = source;
  };
  return policy;
};

/**
 * The latest run of same-class failures for one action, newest first. Blocks by this rule extend
 * the streak but are counted separately (`blockedSince`), so a cooldown can let one attempt through.
 * A success, or a failure of a different class, ends the streak.
 */
export const repeatedFailureStreak = (
  actions: readonly ProtocolActionRecord[],
  actionName: string
): { failures: number; blockedSince: number; errorClass: string } => {
  const blockCode = PRE_ACTION_REASON_CODES.repeated_failure;
  let failures = 0;
  let blockedSince = 0;
  let errorClass = "";
  let sawRealOutcome = false;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action || action.actionName !== actionName || action.status === "requested") {
      continue;
    }
    if (action.status === "succeeded") {
      break;
    }
    const cls = errorClassOf(action.reasonCode);
    if (cls === blockCode) {
      if (!sawRealOutcome) {
        blockedSince += 1;
      }
      continue;
    }
    if (NON_AGENT_ERROR_CLASSES.has(cls) || CHECKER_DEPENDENT_ERROR_CLASSES.has(cls)) {
      continue;
    }
    sawRealOutcome = true;
    if (errorClass && cls !== errorClass) {
      break;
    }
    errorClass = cls;
    failures += 1;
  }
  return { failures, blockedSince, errorClass };
};

const errorClassOf = (reasonCode: string | undefined): string => (reasonCode ?? "UNKNOWN").split(":", 1)[0] ?? "UNKNOWN";

const safeHistory = (history: () => readonly ProtocolActionRecord[]): readonly ProtocolActionRecord[] => {
  try {
    return history();
  } catch {
    return [];
  }
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
): PreActionPolicy | undefined => {
  if (env[PRE_ACTION_VERIFY_VARIABLE] !== "1") {
    return undefined;
  }
  const raw = env[PRE_ACTION_MAX_REPEATED_FAILURES_VARIABLE];
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const maxRepeatedFailures = Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_REPEATED_FAILURES;
  return createPreActionVerifier({ maxRepeatedFailures, ...options });
};

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
