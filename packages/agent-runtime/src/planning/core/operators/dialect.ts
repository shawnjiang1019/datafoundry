import { PlannerError } from "../errors.js";

export type PlannerDialectName = "duckdb" | "sqlite" | "postgres" | "mysql";

export type DateGrain = "year" | "quarter" | "month" | "week" | "day";

export type PlannerDialect = {
  name: PlannerDialectName;
  quoteIdent(name: string): string;
  stringLiteral(value: string): string;
  dateLiteral(isoDate: string): string;
  castNumber(sql: string): string;
  castText(sql: string): string;
  castDate(sql: string): string;
  dateTrunc(grain: DateGrain, sql: string): string;
  extract(part: "year" | "quarter" | "month" | "day", sql: string): string;
  epochSeconds(sql: string): string;
  /** Ordered-set percentile; undefined when the dialect has no portable form. */
  percentileCont?(fraction: number, sql: string): string;
  stddevSamp?(sql: string): string;
  /** Sample variance of a numeric (already cast) expression. */
  varianceSamp(sql: string): string;
  caseInsensitiveLike(sql: string, pattern: string): string;
};

/**
 * Map a data-gateway dialect name onto a planner dialect. The gateway reports csv and
 * xlsx sources as duckdb and PostgreSQL as "postgresql"; anything else has no compiled
 * operator coverage and is refused up front rather than failing at execution.
 */
export const resolveDialect = (gatewayDialect: string | undefined): PlannerDialect => {
  const normalized = gatewayDialect?.trim().toLowerCase();
  switch (normalized) {
    case "duckdb":
    case "csv":
    case "xlsx":
      return DUCKDB;
    case "sqlite":
      return SQLITE;
    case "postgres":
    case "postgresql":
      return POSTGRES;
    case "mysql":
      return MYSQL;
    default:
      throw new PlannerError(
        "PLANNER_DIALECT_UNSUPPORTED",
        `The planner compiles for duckdb, sqlite, postgres, and mysql; datasource dialect is ${normalized ?? "unknown"}.`,
        { dialect: normalized ?? null }
      );
  }
};

export const PLANNER_DIALECT_NAMES: readonly PlannerDialectName[] = ["duckdb", "sqlite", "postgres", "mysql"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const assertIdentifier = (name: string): void => {
  if (name.length === 0 || name.length > 255 || name.includes("\u0000")) {
    throw new PlannerError("IDENTIFIER_INVALID", `Identifier ${JSON.stringify(name)} is empty, too long, or contains NUL.`);
  }
};

const doubleQuote = (name: string): string => {
  assertIdentifier(name);
  return `"${name.replaceAll("\"", "\"\"")}"`;
};

const standardString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const checkedDate = (isoDate: string): string => {
  if (!ISO_DATE.test(isoDate) || Number.isNaN(Date.parse(`${isoDate}T00:00:00Z`))) {
    throw new PlannerError("DATE_LITERAL_INVALID", `Date literal ${JSON.stringify(isoDate)} is not YYYY-MM-DD.`);
  }
  return isoDate;
};

const DUCKDB: PlannerDialect = {
  name: "duckdb",
  quoteIdent: doubleQuote,
  stringLiteral: standardString,
  dateLiteral: (isoDate) => `DATE '${checkedDate(isoDate)}'`,
  castNumber: (sql) => `CAST(${sql} AS DOUBLE)`,
  castText: (sql) => `CAST(${sql} AS VARCHAR)`,
  castDate: (sql) => `CAST(${sql} AS DATE)`,
  dateTrunc: (grain, sql) => `CAST(date_trunc('${grain}', ${sql}) AS DATE)`,
  extract: (part, sql) => `EXTRACT(${part} FROM ${sql})`,
  epochSeconds: (sql) => `epoch(${sql})`,
  percentileCont: (fraction, sql) => `quantile_cont(${sql}, ${fraction})`,
  stddevSamp: (sql) => `stddev_samp(${sql})`,
  varianceSamp: (sql) => `var_samp(${sql})`,
  caseInsensitiveLike: (sql, pattern) => `${sql} ILIKE ${pattern}`
};

const POSTGRES: PlannerDialect = {
  name: "postgres",
  quoteIdent: doubleQuote,
  stringLiteral: standardString,
  dateLiteral: (isoDate) => `DATE '${checkedDate(isoDate)}'`,
  castNumber: (sql) => `CAST(${sql} AS DOUBLE PRECISION)`,
  castText: (sql) => `CAST(${sql} AS TEXT)`,
  castDate: (sql) => `CAST(${sql} AS DATE)`,
  dateTrunc: (grain, sql) => `CAST(date_trunc('${grain}', ${sql}) AS DATE)`,
  extract: (part, sql) => `CAST(EXTRACT(${part} FROM ${sql}) AS INTEGER)`,
  epochSeconds: (sql) => `EXTRACT(EPOCH FROM ${sql})`,
  percentileCont: (fraction, sql) => `percentile_cont(${fraction}) WITHIN GROUP (ORDER BY ${sql})`,
  stddevSamp: (sql) => `stddev_samp(${sql})`,
  varianceSamp: (sql) => `var_samp(${sql})`,
  caseInsensitiveLike: (sql, pattern) => `${sql} ILIKE ${pattern}`
};

/** SQLite has no DATE type: dates are ISO text, truncation goes through strftime. */
const SQLITE: PlannerDialect = {
  name: "sqlite",
  quoteIdent: doubleQuote,
  stringLiteral: standardString,
  dateLiteral: (isoDate) => `'${checkedDate(isoDate)}'`,
  castNumber: (sql) => `CAST(${sql} AS REAL)`,
  castText: (sql) => `CAST(${sql} AS TEXT)`,
  castDate: (sql) => `date(${sql})`,
  dateTrunc: (grain, sql) => {
    switch (grain) {
      case "year":
        return `strftime('%Y-01-01', ${sql})`;
      case "quarter":
        return `printf('%s-%02d-01', strftime('%Y', ${sql}), ((CAST(strftime('%m', ${sql}) AS INTEGER) - 1) / 3) * 3 + 1)`;
      case "month":
        return `strftime('%Y-%m-01', ${sql})`;
      case "week":
        return `date(${sql}, '-' || ((CAST(strftime('%w', ${sql}) AS INTEGER) + 6) % 7) || ' days')`;
      case "day":
        return `date(${sql})`;
    }
  },
  extract: (part, sql) => part === "quarter"
    ? `((CAST(strftime('%m', ${sql}) AS INTEGER) - 1) / 3 + 1)`
    : `CAST(strftime('${{ year: "%Y", month: "%m", day: "%d" }[part]}', ${sql}) AS INTEGER)`,
  epochSeconds: (sql) => `CAST(strftime('%s', ${sql}) AS INTEGER)`,
  // No var_samp in SQLite: textbook sum-of-squares form over non-null values.
  varianceSamp: (sql) => `((SUM(${sql} * ${sql}) - SUM(${sql}) * SUM(${sql}) / COUNT(${sql})) / NULLIF(COUNT(${sql}) - 1, 0))`,
  caseInsensitiveLike: (sql, pattern) => `${sql} LIKE ${pattern} COLLATE NOCASE`
};

/** MySQL honours backslash escapes in string literals unless NO_BACKSLASH_ESCAPES is set. */
const MYSQL: PlannerDialect = {
  name: "mysql",
  quoteIdent: (name) => {
    assertIdentifier(name);
    return `\`${name.replaceAll("`", "``")}\``;
  },
  stringLiteral: (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`,
  dateLiteral: (isoDate) => `DATE '${checkedDate(isoDate)}'`,
  castNumber: (sql) => `CAST(${sql} AS DOUBLE)`,
  castText: (sql) => `CAST(${sql} AS CHAR)`,
  castDate: (sql) => `CAST(${sql} AS DATE)`,
  dateTrunc: (grain, sql) => {
    switch (grain) {
      case "year":
        return `MAKEDATE(YEAR(${sql}), 1)`;
      case "quarter":
        return `DATE_ADD(MAKEDATE(YEAR(${sql}), 1), INTERVAL (QUARTER(${sql}) - 1) QUARTER)`;
      case "month":
        return `CAST(DATE_FORMAT(${sql}, '%Y-%m-01') AS DATE)`;
      case "week":
        return `DATE_SUB(DATE(${sql}), INTERVAL WEEKDAY(${sql}) DAY)`;
      case "day":
        return `DATE(${sql})`;
    }
  },
  extract: (part, sql) => `EXTRACT(${part.toUpperCase()} FROM ${sql})`,
  epochSeconds: (sql) => `UNIX_TIMESTAMP(${sql})`,
  stddevSamp: (sql) => `STDDEV_SAMP(${sql})`,
  varianceSamp: (sql) => `VAR_SAMP(${sql})`,
  caseInsensitiveLike: (sql, pattern) => `LOWER(${sql}) LIKE LOWER(${pattern})`
};
