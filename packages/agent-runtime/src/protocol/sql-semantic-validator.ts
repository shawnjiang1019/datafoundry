import sqlParser from "node-sql-parser";

import type {
  AnalysisAssertion,
  AnalysisScalar,
  AnalysisValidationFinding,
  SqlJoinKey,
  SqlSemanticConstraint
} from "./analysis-contract.js";

type SqlParseResult = {
  tableList: string[];
  columnList: string[];
  ast: unknown;
};

type SqlPredicate = {
  column: string;
  operator: string;
  value: AnalysisScalar;
};

type SqlAggregate = {
  name: string;
  distinct?: boolean;
  column?: string;
  alias?: string;
};

/**
 * A column on one side of an equality; `table` is set when the reference resolves to a base table,
 * `conversion` when the expression casts it (outermost cast wins: TRY_CAST(TRIM(CAST(x AS VARCHAR))
 * AS DOUBLE) compares as a number).
 */
type SqlColumn = { table?: string; column: string; conversion?: "text" | "number" };

type SqlJoins = {
  /** Column pairs linked by JOIN ... ON / USING, WHERE a = b, or a IN (SELECT b ...). */
  pairs: Array<[SqlColumn, SqlColumn]>;
  /** Some SELECT reads more than one relation, so the query combines tables somewhere. */
  combinesTables: boolean;
};

const parser = new sqlParser.Parser();

/** Compare parsed SQL semantics with the selected authoritative analysis assertions. */
export const validateSqlSemantics = (
  sql: string,
  dialect: string | undefined,
  assertions: AnalysisAssertion[]
): AnalysisValidationFinding[] => {
  let parsed: SqlParseResult;
  try {
    parsed = parser.parse(parseableSql(sql, dialect), { database: parserDialect(dialect) }) as SqlParseResult;
  } catch (error) {
    // The parser covers a subset of each engine's SQL (DuckDB's TRY_CAST, QUALIFY and
    // SELECT * EXCLUDE fail in every dialect), so SQL it cannot read is not checked rather
    // than rejected; the database itself still validates and runs the query.
    return [{
      ...finding(
        "SQL_SEMANTIC_PARSE_FAILED",
        `SQL semantic parsing failed: ${error instanceof Error ? error.message : String(error)}`
      ),
      severity: "warning"
    }];
  }
  if (Array.isArray(parsed.ast)) {
    return [finding("SQL_SEMANTIC_MULTIPLE_STATEMENTS", "Exactly one SELECT statement is required.")];
  }
  const ast = asRecord(parsed.ast);
  if (ast.type !== "select") {
    return [finding("SQL_SEMANTIC_SELECT_REQUIRED", "SQL semantic validation requires a SELECT statement.")];
  }
  const tables = parsed.tableList.map((entry) => normalizeIdentifier(entry.split("::").at(-1) ?? entry));
  const columns = parsed.columnList.map((entry) => normalizeIdentifier(entry.split("::").at(-1) ?? entry));
  // CTEs, FROM/WHERE subqueries and UNION branches are SELECTs of their own; a constraint holds
  // when any of them satisfies it, since the agent often filters or groups in an inner query.
  const selects = collectSelects(ast);
  const ctes = collectCtes(selects);
  const aggregates = selects.flatMap((select) => collectAggregates(select, ctes));
  const groupBy = selects.flatMap((select) => collectGroupBy(select.groupby));
  const predicates = selects.flatMap((select) => [
    ...collectPredicates(select.where),
    ...collectPredicates(select.having)
  ]);
  const joins: SqlJoins = {
    pairs: selects.flatMap((select) => collectJoinPairs(select, ctes)),
    combinesTables: selects.some((select) => Array.isArray(select.from) && select.from.length > 1)
  };
  return assertions.flatMap((assertion) => {
    if (assertion.kind === "manual") return [];
    const constraints: SqlSemanticConstraint[] = [
      ...assertion.sourceTables.map((table) => ({ kind: "source" as const, table })),
      ...assertion.sqlConstraints
    ];
    // An optional assertion (a side check) is reported, not enforced.
    return constraints.flatMap((constraint) => validateConstraint(
      constraint,
      { aggregates, columns, groupBy, joins, predicates, tables },
      assertion.id
    )).map((finding) => assertion.required ? finding : { ...finding, severity: "warning" as const });
  });
};

/**
 * Frame binding: the AND-parts of a chosen reading's WHERE that the SQL does not apply.
 *
 * A part counts as applied when the same predicate appears in the WHERE, HAVING or JOIN ... ON
 * of any SELECT in the query, compared structurally: identifier case, quoting and table
 * qualifiers are ignored, operators and literals are not (`= 'Serous'` is not `ILIKE '%serous%'`).
 * Returns undefined when either side cannot be parsed, so an unreadable query is not rejected.
 */
export const missingWhereParts = (
  sql: string,
  dialect: string | undefined,
  reading: { table: string; where: string }
): string[] | undefined => {
  const database = parserDialect(dialect);
  let query: unknown;
  let chosen: unknown;
  try {
    query = parser.astify(parseableSql(sql, dialect), { database });
    chosen = parser.astify(
      parseableSql(`SELECT 1 FROM "${reading.table.replace(/"/gu, "\"\"")}" WHERE ${reading.where}`, dialect),
      { database }
    );
  } catch {
    return undefined;
  }
  if (Array.isArray(query) || Array.isArray(chosen)) return undefined;
  const applied = new Set(collectSelects(query).flatMap((select) => [
    select.where,
    select.having,
    ...fromItems(select).map((item) => item.on),
    // An aggregate can select its own rows: COUNT(*) FILTER (WHERE ...) or SUM(CASE WHEN ... END).
    ...findAggregateExpressions(select.columns).flatMap((aggregate) => [
      asRecord(asRecord(aggregate.filter).where),
      ...caseConditions(aggregate.args)
    ])
  ]).flatMap(andParts).map(canonicalPredicate));
  return andParts(asRecord(chosen).where)
    .filter((part) => !applied.has(canonicalPredicate(part)))
    .map((part) => parser.exprToSQL(part as never, { database }));
};

/**
 * Frame binding for a unit reading counted once per key (e.g. 2136 distinct stations in 2965
 * rows): the named output fields whose aggregate does not read data deduplicated on that key.
 *
 * Each field is traced from the outer SELECT through scalar subqueries, CTEs and derived tables
 * to the aggregates that compute it. An aggregate is per unit when it is COUNT(DISTINCT key), when
 * its SELECT groups by the key, or when it reads a relation made unique on the key by SELECT
 * DISTINCT or GROUP BY. A DISTINCT elsewhere in the query does not count: wildfire-hard-17 built
 * one and then averaged over the undeduplicated join. Returns undefined when the query cannot be
 * parsed or names none of the fields, so the check never blocks a query it cannot read.
 */
export const fieldsNotPerUnit = (
  sql: string,
  dialect: string | undefined,
  unit: { keyColumns: string[]; fields: string[] }
): string[] | undefined => {
  let parsed: unknown;
  try {
    parsed = parser.astify(parseableSql(sql, dialect), { database: parserDialect(dialect) });
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return undefined;
  const root = asRecord(parsed);
  const ctes = collectCtes(collectSelects(root));
  const keys = unit.keyColumns.map(normalizeIdentifier);
  const outputs = (Array.isArray(root.columns) ? root.columns : []).map(asRecord);
  const targets = unit.fields.flatMap((field) => {
    const output = outputs.find((item) => typeof item.as === "string" && normalizeIdentifier(item.as) === normalizeIdentifier(field));
    return output ? [{ field, verdicts: aggregateVerdicts(output.expr, root, ctes, keys, 0) }] : [];
  });
  if (targets.length === 0) return undefined;
  return targets.filter(({ verdicts }) => verdicts.length > 0 && verdicts.some((perUnit) => !perUnit))
    .map(({ field }) => field);
};

// One verdict per aggregate that feeds the expression: true when it is computed once per unit.
const aggregateVerdicts = (
  expression: unknown,
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>,
  keys: string[],
  depth: number
): boolean[] => {
  if (depth > 6) return [];
  // COUNT(*) counts rows by definition; it is the supporting row count, not a per-unit value.
  const direct = findAggregateExpressions(expression)
    .filter((aggregate) => asRecord(asRecord(aggregate.args).expr).type !== "star")
    .map((aggregate) => isPerUnit(aggregate, select, ctes, keys));
  const scalarSubqueries = topLevelSelects(expression).flatMap((subquery) => {
    const first = Array.isArray(subquery.columns) ? asRecord(subquery.columns[0]).expr : undefined;
    return aggregateVerdicts(first, subquery, ctes, keys, depth + 1);
  });
  if (direct.length > 0 || scalarSubqueries.length > 0) return [...direct, ...scalarSubqueries];
  // No aggregate here: follow a column read from a derived relation, as in SELECT a.avg FROM agg a.
  return findColumnRefRecords(expression).flatMap((ref) => {
    const relation = derivedRelation(select, ctes, typeof ref.table === "string" ? ref.table : undefined);
    const name = columnRefName(ref);
    const output = relation && name !== undefined ? outputColumn(relation, name) : undefined;
    return relation && output ? aggregateVerdicts(output.expr, relation, ctes, keys, depth + 1) : [];
  });
};

const isPerUnit = (
  aggregate: Record<string, unknown>,
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>,
  keys: string[]
): boolean => {
  const args = asRecord(aggregate.args);
  const argument = columnResolver(fromItems(select), ctes)(args.expr);
  if (String(args.distinct).toUpperCase() === "DISTINCT" && argument && keys.includes(argument.column)) return true;
  return groupsOnKeys(select, ctes, keys)
    || fromItems(select).some((item) => {
      const relation = relationSelect(item, ctes);
      return relation !== undefined && uniqueOnKeys(relation, ctes, keys, 0);
    });
};

// A relation has one row per key when it is SELECT DISTINCT over the key, groups by the key,
// or passes through a single relation that does.
const uniqueOnKeys = (
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>,
  keys: string[],
  depth: number
): boolean => {
  if (depth > 6) return false;
  const resolve = columnResolver(fromItems(select), ctes);
  const outputs = (Array.isArray(select.columns) ? select.columns : []).map((item) => resolve(asRecord(item).expr)?.column);
  if (String(asRecord(select.distinct).type).toUpperCase() === "DISTINCT" && keys.every((key) => outputs.includes(key))) {
    return true;
  }
  if (groupsOnKeys(select, ctes, keys)) return true;
  const from = fromItems(select);
  const only = from.length === 1 && from[0] ? relationSelect(from[0], ctes) : undefined;
  return only !== undefined && uniqueOnKeys(only, ctes, keys, depth + 1);
};

const groupsOnKeys = (
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>,
  keys: string[]
): boolean => {
  const grouped = asRecord(select.groupby).columns;
  if (!Array.isArray(grouped) || grouped.length === 0) return false;
  const resolve = columnResolver(fromItems(select), ctes);
  const columns = Array.isArray(select.columns) ? select.columns : [];
  const groupedColumns = grouped.map((item) => {
    const record = asRecord(item);
    // GROUP BY 1 names the first select-list expression.
    const target = record.type === "number" ? asRecord(columns[Number(record.value) - 1]).expr : record;
    return resolve(target)?.column;
  });
  return keys.every((key) => groupedColumns.includes(key));
};

const relationSelect = (
  item: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>
): Record<string, unknown> | undefined => {
  const subquery = asRecord(asRecord(item.expr).ast);
  if (subquery.type === "select") return subquery;
  return typeof item.table === "string" ? ctes.get(normalizeIdentifier(item.table)) : undefined;
};

const derivedRelation = (
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>,
  qualifier: string | undefined
): Record<string, unknown> | undefined => {
  const from = fromItems(select);
  const item = qualifier === undefined
    ? (from.length === 1 ? from[0] : undefined)
    : from.find((candidate) => [candidate.as, candidate.table].some((name) =>
      typeof name === "string" && normalizeIdentifier(name) === normalizeIdentifier(qualifier)));
  return item ? relationSelect(item, ctes) : undefined;
};

const outputColumn = (select: Record<string, unknown>, name: string): Record<string, unknown> | undefined =>
  (Array.isArray(select.columns) ? select.columns : []).map(asRecord).find((item) => typeof item.as === "string"
    ? normalizeIdentifier(item.as) === normalizeIdentifier(name)
    : columnRefName(asRecord(item.expr)) !== undefined
      && normalizeIdentifier(columnRefName(asRecord(item.expr)) as string) === normalizeIdentifier(name));

// SELECTs nested directly in an expression (scalar subqueries), without descending into them.
const topLevelSelects = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(topLevelSelects);
  const record = asRecord(value);
  if (record.type === "select") return [record];
  return Object.values(record).flatMap(topLevelSelects);
};

const caseConditions = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value.flatMap(caseConditions);
  const record = asRecord(value);
  if (record.type === "select") return [];
  return [
    ...(record.type === "when" ? [record.cond] : []),
    ...Object.values(record).flatMap(caseConditions)
  ];
};

const andParts = (value: unknown): unknown[] => {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return [];
  return record.type === "binary_expr" && String(record.operator).toUpperCase() === "AND"
    ? [...andParts(record.left), ...andParts(record.right)]
    : [record];
};

const canonicalPredicate = (value: unknown): string => JSON.stringify(canonicalNode(value));

const canonicalNode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalNode);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const name = columnRefName(record);
  if (name !== undefined) return { type: "column_ref", column: normalizeIdentifier(name) };
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !["parentheses", "collate", "loc", "tableList", "columnList"].includes(key))
    .map(([key, child]) => [key, canonicalNode(child)]));
};

const validateConstraint = (
  constraint: SqlSemanticConstraint,
  sql: {
    aggregates: SqlAggregate[];
    columns: string[];
    groupBy: string[];
    joins: SqlJoins;
    predicates: SqlPredicate[];
    tables: string[];
  },
  assertionId: string
): AnalysisValidationFinding[] => {
  if (constraint.kind === "join") {
    // "If you join these tables, use a verified key": queries that compare the tables through
    // separate subqueries never link them, so the rule only applies once tables are combined.
    const [left, right] = constraint.tables;
    const linked = constraint.anyOf.flatMap((key) => sql.joins.pairs.filter((pair) => pairUsesKey(pair, key))
      .map((pair) => ({ key, pair })));
    const comparedRight = linked.some(({ key, pair }) =>
      key.compare !== "numeric" || pair.every((side) => side.conversion !== "text"));
    if (linked.length > 0 && !comparedRight) {
      return [finding(
        `SQL_SEMANTIC_JOIN_COMPARED_AS_TEXT:${left}:${right}`,
        `The verified key between ${left} and ${right} only matches as numbers; comparing it as text drops `
          + `matches. Compare as numbers: ${constraint.condition}.`,
        assertionId
      )];
    }
    const readsBoth = [left, right].every((table) => sql.tables.includes(normalizeIdentifier(table)));
    return comparedRight || !readsBoth || !sql.joins.combinesTables ? [] : [finding(
      `SQL_SEMANTIC_JOIN_MISSING:${left}:${right}`,
      `Join ${left} and ${right} on the key verified against the data: ${constraint.condition}.`,
      assertionId
    )];
  }
  if (constraint.kind === "avoid_join") {
    const { left, right } = constraint.key;
    return sql.joins.pairs.some((pair) => pairUsesKey(pair, constraint.key)) ? [finding(
      `SQL_SEMANTIC_JOIN_REJECTED:${left.table}.${left.column}:${right.table}.${right.column}`,
      `${left.table}.${left.column} = ${right.table}.${right.column} was checked against the data and its values `
        + `do not match; join on ${constraint.instead} instead.`,
      assertionId
    )] : [];
  }
  if (constraint.kind === "source") {
    return sql.tables.includes(normalizeIdentifier(constraint.table))
      ? []
      : [finding(`SQL_SEMANTIC_SOURCE_MISSING:${constraint.table}`, `Required source ${constraint.table} is missing.`, assertionId)];
  }
  if (constraint.kind === "column") {
    return sql.columns.includes(normalizeIdentifier(constraint.column))
      ? []
      : [finding(`SQL_SEMANTIC_COLUMN_MISSING:${constraint.column}`, `Required column ${constraint.column} is missing.`, assertionId)];
  }
  if (constraint.kind === "aggregate") {
    const expected = aggregateFunction(constraint.function);
    const matches = sql.aggregates.some((aggregate) =>
      aggregate.name === expected.name
      && (!expected.distinct || aggregate.distinct === true)
      && (!constraint.column || aggregate.column === normalizeIdentifier(constraint.column))
      && (!constraint.alias || aggregate.alias === normalizeIdentifier(constraint.alias)));
    return matches ? [] : [finding(
      `SQL_SEMANTIC_AGGREGATE_MISSING:${constraint.function}`,
      `Expected ${formatAggregate({
        ...expected,
        ...(constraint.column ? { column: normalizeIdentifier(constraint.column) } : {}),
        ...(constraint.alias ? { alias: normalizeIdentifier(constraint.alias) } : {})
      })}, but observed ${formatObservedAggregates(sql.aggregates)}.`,
      assertionId
    )];
  }
  if (constraint.kind === "group_by") {
    const missing = constraint.columns.filter((column) => !sql.groupBy.includes(normalizeIdentifier(column)));
    return missing.map((column) => finding(
      `SQL_SEMANTIC_GROUP_BY_MISSING:${column}`,
      `Required group-by column ${column} is missing.`,
      assertionId
    ));
  }
  if (constraint.kind === "filter") {
    return predicateExists(sql.predicates, constraint.column, operatorToken(constraint.operator), constraint.value)
      ? []
      : [finding(
          `SQL_SEMANTIC_FILTER_MISSING:${constraint.column}:${constraint.operator}`,
          `Required filter ${constraint.column} ${operatorToken(constraint.operator)} ${JSON.stringify(constraint.value)} is missing.`,
          assertionId
        )];
  }
  // A bare year is an integer column, where an inclusive end is `<= 2030` or `< 2031`;
  // dates keep the half-open form so timestamps on the last day are not dropped.
  const yearEnd = constraint.endInclusive && /^\d{4}$/u.test(constraint.end);
  const end = yearEnd
    ? String(Number(constraint.end) + 1)
    : constraint.endInclusive ? nextDate(constraint.end) : constraint.end;
  const hasStart = predicateExists(sql.predicates, constraint.column, ">=", constraint.start);
  const hasEnd = predicateExists(sql.predicates, constraint.column, "<", end)
    || (yearEnd && predicateExists(sql.predicates, constraint.column, "<=", constraint.end));
  return [
    ...(hasStart ? [] : [finding(
      `SQL_SEMANTIC_TIME_START_MISSING:${constraint.column}`,
      `Required start boundary ${constraint.start} is missing.`,
      assertionId
    )]),
    ...(hasEnd ? [] : [finding(
      `SQL_SEMANTIC_TIME_END_MISSING:${constraint.column}`,
      `Required half-open end boundary ${end} is missing.`,
      assertionId
    )])
  ];
};

const collectSelects = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(collectSelects);
  const record = asRecord(value);
  const nested = Object.values(record).flatMap(collectSelects);
  return record.type === "select" ? [record, ...nested] : nested;
};

// Aggregates inside a select-list expression, such as ROUND(AVG(x), 1), take that column's alias.
// Nested SELECTs are skipped because collectSelects visits them separately.
const findAggregateExpressions = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(findAggregateExpressions);
  const record = asRecord(value);
  if (record.type === "select") return [];
  if (aggregateName(record)) return [record];
  return Object.values(record).flatMap(findAggregateExpressions);
};

// The aggregated column is resolved through CTE and subquery renames to its base column, so
// COUNT(nws_id) over `ra AS (SELECT "NWS ID" AS nws_id ...)` counts "NWS ID".
const collectAggregates = (
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>
): SqlAggregate[] => {
  const value = select.columns;
  if (!Array.isArray(value)) return [];
  const resolve = columnResolver(fromItems(select), ctes);
  return value.flatMap((item) => {
    const record = asRecord(item);
    return findAggregateExpressions(record.expr).map((expression) => ({ record, expression }));
  }).flatMap(({ record, expression }) => {
    const name = aggregateName(expression);
    if (!name) return [];
    const argument = aggregateArgument(expression);
    const argumentColumn = resolve(argument)?.column;
    const column = argumentColumn !== undefined
      ? argumentColumn
      : argument.type === "star" && argument.value === "*"
        ? "*"
        : undefined;
    return [{
      name: isMedianQuantile(name, expression) ? "median" : name.toLowerCase(),
      ...(String(asRecord(expression.args).distinct).toUpperCase() === "DISTINCT" ? { distinct: true } : {}),
      ...(column ? { column } : {}),
      ...(typeof record.as === "string" ? { alias: normalizeIdentifier(record.as) } : {})
    }];
  });
};

// The PostgreSQL grammar (used for DuckDB) parses aggregates it does not list, such as MEDIAN,
// as plain functions named `{ name: [{ value }] }` with an `expr_list` of arguments.
const FUNCTION_AGGREGATES = new Set([
  "median", "mode", "quantile", "quantile_cont", "quantile_disc", "approx_count_distinct",
  "arg_max", "arg_min", "any_value", "string_agg", "stddev", "stddev_pop", "stddev_samp",
  "variance", "var_pop", "var_samp", "corr", "covar_pop", "covar_samp"
]);

const aggregateName = (expression: Record<string, unknown>): string | undefined => {
  if (expression.type === "aggr_func") return typeof expression.name === "string" ? expression.name : undefined;
  if (expression.type !== "function") return undefined;
  const parts = asRecord(expression.name).name;
  const value = Array.isArray(parts) && parts.length === 1 ? asRecord(parts[0]).value : undefined;
  return typeof value === "string" && FUNCTION_AGGREGATES.has(value.toLowerCase()) ? value : undefined;
};

// DuckDB defines MEDIAN(x) as QUANTILE_CONT(x, 0.5).
const isMedianQuantile = (name: string, expression: Record<string, unknown>): boolean => {
  const args = asRecord(expression.args).value;
  const fraction = Array.isArray(args) && args.length === 2 ? sqlLiteral(asRecord(args[1])) : undefined;
  return name.toLowerCase() === "quantile_cont" && fraction === 0.5;
};

const aggregateArgument = (expression: Record<string, unknown>): Record<string, unknown> => {
  const args = asRecord(expression.args);
  if (expression.type === "aggr_func") return asRecord(args.expr);
  return Array.isArray(args.value) ? asRecord(args.value[0]) : {};
};

const findColumnRefRecords = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(findColumnRefRecords);
  const record = asRecord(value);
  if (record.type === "select") return [];
  return columnRefName(record) === undefined ? Object.values(record).flatMap(findColumnRefRecords) : [record];
};

// SQLite and MySQL grammars give `column` as a string; the PostgreSQL grammar wraps it as
// `{ expr: { type: "default" | "double_quote_string", value } }`.
const columnRefName = (record: Record<string, unknown>): string | undefined => {
  if (record.type !== "column_ref") return undefined;
  if (typeof record.column === "string") return record.column;
  const value = asRecord(asRecord(record.column).expr).value;
  return typeof value === "string" ? value : undefined;
};

// Contracts spell a distinct count several ways: "COUNT DISTINCT", "COUNT(DISTINCT)", "count_distinct".
const aggregateFunction = (spelled: string): { name: string; distinct?: boolean } => {
  const matched = /^\s*(\w+?)(?:\s*\(\s*|\s+|_)distinct\s*\)?\s*$/iu.exec(spelled);
  return matched ? { name: (matched[1] as string).toLowerCase(), distinct: true } : { name: spelled.trim().toLowerCase() };
};

const formatAggregate = (aggregate: SqlAggregate): string => {
  const argument = aggregate.column === undefined ? "" : `(${aggregate.distinct ? "DISTINCT " : ""}${aggregate.column})`;
  const alias = aggregate.alias === undefined ? "" : ` AS ${aggregate.alias}`;
  return `${aggregate.name.toUpperCase()}${argument}${alias}`;
};

const formatObservedAggregates = (aggregates: SqlAggregate[]): string =>
  aggregates.length === 0 ? "no aggregate expressions" : aggregates.map(formatAggregate).join(", ");

const collectGroupBy = (value: unknown): string[] => {
  const columns = asRecord(value).columns;
  if (!Array.isArray(columns)) return [];
  return columns.flatMap((column) => {
    const name = columnRefName(asRecord(column));
    return name === undefined ? [] : [normalizeIdentifier(name)];
  });
};

const collectPredicates = (value: unknown): SqlPredicate[] => {
  const record = asRecord(value);
  if (record.type !== "binary_expr" || typeof record.operator !== "string") return [];
  if (record.operator.toUpperCase() === "AND") {
    return [...collectPredicates(record.left), ...collectPredicates(record.right)];
  }
  const left = asRecord(record.left);
  const right = asRecord(record.right);
  const column = columnRefName(left);
  if (column === undefined) return [];
  if (record.operator.toUpperCase() === "BETWEEN") {
    const bounds = Array.isArray(right.value) ? right.value.map((bound) => sqlLiteral(asRecord(bound))) : [];
    const [low, high] = bounds;
    return bounds.length === 2 && low !== undefined && high !== undefined ? [
      { column: normalizeIdentifier(column), operator: ">=", value: low },
      { column: normalizeIdentifier(column), operator: "<=", value: high }
    ] : [];
  }
  const scalar = sqlLiteral(right);
  return scalar === undefined ? [] : [{
    column: normalizeIdentifier(column),
    operator: record.operator,
    value: scalar
  }];
};

const sqlLiteral = (value: Record<string, unknown>): AnalysisScalar | undefined => {
  if (["single_quote_string", "double_quote_string", "string"].includes(String(value.type))) {
    return typeof value.value === "string" ? value.value : undefined;
  }
  if (value.type === "number") return typeof value.value === "number" ? value.value : Number(value.value);
  if (value.type === "bool") return Boolean(value.value);
  if (value.type === "null") return null;
  return undefined;
};

const predicateExists = (
  predicates: SqlPredicate[],
  column: string,
  operator: string,
  value: AnalysisScalar
): boolean => predicates.some((predicate) => predicate.column === normalizeIdentifier(column)
  && predicate.operator === operator && sameScalar(predicate.value, value));

// Contracts carry bounds such as years as strings ("2000") while SQL has the number 2000.
const sameScalar = (left: AnalysisScalar, right: AnalysisScalar): boolean => {
  if (left === right) return true;
  const leftNumber = numericScalar(left);
  return leftNumber !== undefined && leftNumber === numericScalar(right);
};

const numericScalar = (value: AnalysisScalar): number | undefined => {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^-?\d+(\.\d+)?$/u.test(value.trim()) ? Number(value) : undefined;
};

const operatorToken = (operator: "eq" | "gt" | "gte" | "lt" | "lte"): string => ({
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<="
})[operator];

const nextDate = (value: string): string => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!matched) return value;
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const collectJoinPairs = (
  select: Record<string, unknown>,
  ctes: Map<string, Record<string, unknown>>
): Array<[SqlColumn, SqlColumn]> => {
  const from = fromItems(select);
  const resolve = columnResolver(from, ctes);
  const pairs: Array<[SqlColumn, SqlColumn]> = [];
  const visit = (value: unknown): void => {
    const record = asRecord(value);
    if (record.type !== "binary_expr" || typeof record.operator !== "string") return;
    const operator = record.operator.toUpperCase();
    if (operator === "AND") {
      visit(record.left);
      visit(record.right);
      return;
    }
    const left = resolve(record.left);
    const right = operator === "=" ? resolve(record.right) : operator === "IN" ? inSubqueryColumn(record.right, ctes) : undefined;
    if (left && right) pairs.push([left, right]);
  };
  for (const item of from) {
    visit(item.on);
    const using = Array.isArray(item.using) ? item.using.map((entry) => asRecord(entry).value) : [];
    for (const name of using) {
      if (typeof name === "string" && typeof item.table === "string") {
        pairs.push([{ column: normalizeIdentifier(name) }, { table: normalizeIdentifier(item.table), column: normalizeIdentifier(name) }]);
      }
    }
  }
  visit(select.where);
  return pairs;
};

const fromItems = (select: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(select.from) ? select.from.map(asRecord) : [];

const collectCtes = (selects: Record<string, unknown>[]): Map<string, Record<string, unknown>> => new Map(
  selects.flatMap((select) => Array.isArray(select.with) ? select.with.map(asRecord) : []).flatMap((cte) => {
    const name = asRecord(cte.name).value;
    return typeof name === "string" ? [[normalizeIdentifier(name), asRecord(cte.stmt)] as const] : [];
  })
);

type Relation = { table: string } | { select: Record<string, unknown> };

// Resolve the one column an expression reads (through CAST, TRIM and the like) to its base
// table. A qualifier names a relation in this SELECT's FROM, and an unqualified column belongs
// to the only relation when there is exactly one. CTEs and subqueries are followed through
// their select lists, so `JOIN s ON s.nws = ...` with `s AS (SELECT "NWS ID" AS nws ...)`
// resolves to "NWS ID" on its base table.
const columnResolver = (
  from: Record<string, unknown>[],
  ctes: Map<string, Record<string, unknown>>,
  depth = 0
) => {
  const relations = new Map<string, Relation>();
  const relationOf = (item: Record<string, unknown>): Relation | undefined => {
    const subquery = asRecord(asRecord(item.expr).ast);
    if (subquery.type === "select") return { select: subquery };
    if (typeof item.table !== "string") return undefined;
    const cte = ctes.get(normalizeIdentifier(item.table));
    return cte ? { select: cte } : { table: item.table };
  };
  for (const item of from) {
    const relation = relationOf(item);
    if (!relation) continue;
    if (typeof item.table === "string") relations.set(normalizeIdentifier(item.table), relation);
    if (typeof item.as === "string") relations.set(normalizeIdentifier(item.as), relation);
  }
  const only = from.length === 1 && from[0] ? relationOf(from[0]) : undefined;
  return (value: unknown): SqlColumn | undefined => {
    const refs = findColumnRefRecords(value);
    const ref = refs[0];
    const name = ref ? columnRefName(ref) : undefined;
    if (!ref || name === undefined || new Set(refs.map((item) => `${String(item.table)}\u0000${columnRefName(item)}`)).size !== 1) {
      return undefined;
    }
    const column = normalizeIdentifier(name);
    const conversion = conversionOf(value);
    const converted = conversion ? { conversion } : {};
    const relation = typeof ref.table === "string" ? relations.get(normalizeIdentifier(ref.table)) : only;
    if (!relation) return { column, ...converted };
    if ("table" in relation) return { table: normalizeIdentifier(relation.table), column, ...converted };
    if (depth >= 4) return { column, ...converted };
    const output = (Array.isArray(relation.select.columns) ? relation.select.columns : []).map(asRecord).find((item) =>
      typeof item.as === "string"
        ? normalizeIdentifier(item.as) === column
        : columnRefName(asRecord(item.expr)) !== undefined
          && normalizeIdentifier(columnRefName(asRecord(item.expr)) as string) === column);
    const inner = output ? columnResolver(fromItems(relation.select), ctes, depth + 1)(output.expr) : undefined;
    return inner ? { ...inner, ...converted } : { column, ...converted };
  };
};

const STRING_TYPES = new Set(["VARCHAR", "TEXT", "STRING", "CHAR", "BPCHAR"]);
const NUMERIC_TYPE = /^(U?(BIG|SMALL|TINY|HUGE)?INT(EGER)?\d*|DOUBLE|FLOAT\d*|REAL|DECIMAL|NUMERIC)$/u;

// The outermost cast in an expression decides how it compares.
const conversionOf = (value: unknown): "text" | "number" | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = conversionOf(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record.type === "select" || record.type === "column_ref") return undefined;
  if (record.type === "cast") {
    const target = asRecord(Array.isArray(record.target) ? record.target[0] : record.target);
    const type = String(target.dataType ?? "").toUpperCase();
    if (STRING_TYPES.has(type)) return "text";
    if (NUMERIC_TYPE.test(type)) return "number";
  }
  return conversionOf(Object.values(record));
};

const inSubqueryColumn = (value: unknown, ctes: Map<string, Record<string, unknown>>): SqlColumn | undefined => {
  const select = collectSelects(value)[0];
  const columns = select?.columns;
  if (!select || !Array.isArray(columns) || columns.length !== 1) return undefined;
  return columnResolver(fromItems(select), ctes)(asRecord(columns[0]).expr);
};

// A side matches when the column names agree and its table agrees or is not one of the key's
// tables (a CTE or subquery alias, whose base table the parser does not track).
const pairUsesKey = ([first, second]: [SqlColumn, SqlColumn], key: SqlJoinKey): boolean => {
  const keyTables = [key.left.table, key.right.table].map(normalizeIdentifier);
  const matches = (side: SqlColumn, target: { table: string; column: string }) =>
    side.column === normalizeIdentifier(target.column)
    && (side.table === undefined || side.table === normalizeIdentifier(target.table) || !keyTables.includes(side.table));
  return (matches(first, key.left) && matches(second, key.right))
    || (matches(first, key.right) && matches(second, key.left));
};

// DuckDB's TRY_CAST, which the verified join conditions use, is outside every parser grammar;
// as CAST it has the same structure, and the database still runs the original text.
const parseableSql = (sql: string, dialect: string | undefined): string =>
  dialect?.toLowerCase() === "duckdb" ? sql.replace(/\bTRY_CAST\s*\(/giu, "CAST(") : sql;

const parserDialect = (dialect: string | undefined): string => {
  const normalized = dialect?.toLowerCase();
  if (normalized === "postgres" || normalized === "postgresql") return "Postgresql";
  if (normalized === "mysql") return "MySQL";
  // node-sql-parser has no DuckDB dialect; DuckDB follows PostgreSQL syntax (::casts, ILIKE).
  if (normalized === "duckdb") return "Postgresql";
  return "SQLite";
};

const normalizeIdentifier = (value: string): string => value.replace(/^[`"[]|[`"\]]$/gu, "").toLowerCase();
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finding = (code: string, message: string, assertionId?: string): AnalysisValidationFinding => ({
  code,
  message,
  severity: "error",
  ...(assertionId ? { assertionId } : {})
});
