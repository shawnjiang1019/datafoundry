import { z } from "zod";

import { PlannerError } from "../errors.js";
import {
  exprSchema,
  predicateSchema,
  renderExpr,
  renderPredicate,
  type Expr,
  type Predicate
} from "./expressions.js";
import {
  assertUniqueColumns,
  DEFAULT_FAILURE,
  orderSpecSchema,
  passThroughCost,
  quotedColumns,
  renderOrderBy,
  scopeOf,
  singleInput,
  surviving,
  withOrdering,
  type ExecutableOperatorDefinition,
  type RenderContext
} from "./types.js";

const ALL_DIALECTS = ["duckdb", "sqlite", "postgres", "mysql"] as const;
const DEFAULT_TABLE_ROWS = 1000;

/** Grounded table names may be schema-qualified ("sales.orders"); each part is quoted. */
const quoteTable = (context: RenderContext, table: string): string =>
  table.split(".").map((part) => context.dialect.quoteIdent(part)).join(".");

// ---- scan -------------------------------------------------------------------

const scanParameters = z.object({
  table: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1).max(500).optional()
});

export const scanOperator: ExecutableOperatorDefinition<z.infer<typeof scanParameters>> = {
  name: "scan",
  category: "data",
  description: "Read a grounded source table, optionally restricted to a column subset.",
  sideEffectClass: "read",
  executable: true,
  arity: { min: 0, max: 0 },
  dialects: ALL_DIALECTS,
  parameterSchema: scanParameters,
  render: (parameters, context) => {
    const grounded = context.tableColumns(parameters.table);
    if (!grounded) {
      throw new PlannerError(
        "SOURCE_NOT_GROUNDED",
        `Table ${JSON.stringify(parameters.table)} is not part of the grounded schema.`,
        { table: parameters.table }
      );
    }
    const columns = parameters.columns ?? [...grounded];
    const missing = columns.filter((column) => !grounded.includes(column));
    if (missing.length > 0) {
      throw new PlannerError(
        "COLUMN_NOT_IN_SCOPE",
        `Table ${parameters.table} has no column(s) ${missing.join(", ")}.`,
        { table: parameters.table, missing }
      );
    }
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${columns.map((column) => context.dialect.quoteIdent(column)).join(", ")} `
        + `FROM ${quoteTable(context, parameters.table)}`,
      columns
    };
  },
  estimateCost: (_parameters, _inputs, context) => {
    const rows = Math.max(1, context.tableRows ?? DEFAULT_TABLE_ROWS);
    return { rows, cost: rows };
  },
  obligations: ["schema_matches_grounding", "row_budget"],
  failure: { ...DEFAULT_FAILURE, clarifyOn: ["SOURCE_NOT_GROUNDED"] },
  conformance: [{
    name: "projects grounded columns",
    inputs: [{ columns: ["id", "region", "amount"], rows: [[1, "east", 10], [2, "west", 20]] }],
    parameters: { table: "source", columns: ["region", "amount"] },
    expected: { columns: ["region", "amount"], rows: [["east", 10], ["west", 20]] }
  }]
};

// ---- filter -----------------------------------------------------------------

const filterParameters = z.object({ predicate: predicateSchema });

export const filterOperator: ExecutableOperatorDefinition<{ predicate: Predicate }> = {
  name: "filter",
  category: "data",
  description: "Keep rows satisfying a predicate.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: filterParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    return withOrdering({
      sql: `SELECT * FROM ${input.alias} WHERE ${renderPredicate(parameters.predicate, scopeOf(context, input))}`,
      columns: [...input.columns]
    }, surviving(input.ordering, input.columns));
  },
  estimateCost: passThroughCost,
  obligations: ["filter_columns_exist", "filter_type_compatibility"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "compound predicate with IN and date range",
    inputs: [{
      columns: ["region", "day", "amount"],
      rows: [["east", "2024-01-05", 10], ["west", "2024-02-01", 20], ["north", "2024-01-20", 30]]
    }],
    parameters: {
      predicate: {
        kind: "and",
        args: [
          { kind: "in", expr: "region", values: ["east", "north"] },
          { kind: "compare", op: ">=", left: "amount", right: { kind: "literal", value: 10 } }
        ]
      }
    },
    expected: { columns: ["region", "day", "amount"], rows: [["east", "2024-01-05", 10], ["north", "2024-01-20", 30]] }
  }]
};

// ---- project ----------------------------------------------------------------

type ProjectColumn = string | { expr: Expr; as?: string | undefined };

const projectParameters = z.object({
  columns: z.array(z.union([z.string().min(1), z.object({ expr: exprSchema, as: z.string().min(1).optional() })]))
    .min(1)
    .max(500)
});

export const projectOperator: ExecutableOperatorDefinition<{ columns: ProjectColumn[] }> = {
  name: "project",
  category: "data",
  description: "Select, rename, or compute columns.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: projectParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const scope = scopeOf(context, input);
    const items = parameters.columns.map((column) => {
      if (typeof column === "string") {
        return { sql: renderExpr({ kind: "column", name: column }, scope), as: column };
      }
      const as = column.as ?? (column.expr.kind === "column" ? column.expr.name : undefined);
      if (!as) {
        throw new PlannerError("OUTPUT_COLUMN_NAME_REQUIRED", "Computed project columns need an 'as' name.");
      }
      return { sql: renderExpr(column.expr, scope), as };
    });
    const columns = items.map((item) => item.as);
    assertUniqueColumns(columns);
    const renamed = new Map(parameters.columns.flatMap((column) =>
      typeof column === "string"
        ? [[column, column] as const]
        : column.expr.kind === "column" ? [[column.expr.name, column.as ?? column.expr.name] as const] : []));
    const ordering = input.ordering?.every((order) => renamed.has(order.column))
      ? input.ordering.map((order) => ({ ...order, column: renamed.get(order.column) as string }))
      : undefined;
    return withOrdering({
      sql: `SELECT ${items.map((item) => `${item.sql} AS ${context.dialect.quoteIdent(item.as)}`).join(", ")} `
        + `FROM ${input.alias}`,
      columns
    }, ordering);
  },
  estimateCost: passThroughCost,
  obligations: [],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "renames and computes a real-valued ratio",
    inputs: [{ columns: ["revenue", "orders"], rows: [[100, 4], [30, 0]] }],
    parameters: {
      columns: [
        { expr: "revenue", as: "rev" },
        { expr: { kind: "arith", op: "/", left: "revenue", right: "orders" }, as: "aov" }
      ]
    },
    expected: { columns: ["rev", "aov"], rows: [[100, 25], [30, null]] }
  }]
};

// ---- join -------------------------------------------------------------------

type JoinSelect = { from: "left" | "right"; column: string; as?: string | undefined };

type JoinParameters = {
  type: "inner" | "left";
  on: Array<{ left: string; right: string }>;
  select?: JoinSelect[] | undefined;
};

const joinParameters = z.object({
  type: z.enum(["inner", "left"]).default("inner"),
  on: z.array(z.object({ left: z.string().min(1), right: z.string().min(1) })).min(1).max(8),
  select: z.array(z.object({
    from: z.enum(["left", "right"]),
    column: z.string().min(1),
    as: z.string().min(1).optional()
  })).min(1).max(500).optional()
});

export const joinOperator: ExecutableOperatorDefinition<JoinParameters> = {
  name: "join",
  category: "data",
  description: "Equi-join two inputs. Without an explicit select, all left columns are kept, then right columns "
    + "that are not join keys, with name clashes suffixed _right.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 2, max: 2 },
  dialects: ALL_DIALECTS,
  parameterSchema: joinParameters as z.ZodType<JoinParameters>,
  render: (parameters, context) => {
    const [left, right] = context.inputs;
    if (!left || !right || context.inputs.length !== 2) {
      throw new PlannerError("OPERATOR_ARITY", `join expects two inputs, received ${context.inputs.length}.`);
    }
    const leftScope = scopeOf(context, left, "l");
    const rightScope = scopeOf(context, right, "r");
    const conditions = parameters.on.map((key) =>
      `${renderExpr({ kind: "column", name: key.left }, leftScope)} = ${renderExpr({ kind: "column", name: key.right }, rightScope)}`);
    const rightKeys = new Set(parameters.on.map((key) => key.right));
    const select: JoinSelect[] = parameters.select ?? [
      ...left.columns.map((column) => ({ from: "left" as const, column })),
      ...right.columns.filter((column) => !rightKeys.has(column)).map((column) => ({
        from: "right" as const,
        column,
        as: left.columns.includes(column) ? `${column}_right` : column
      }))
    ];
    const items = select.map((item) => ({
      sql: renderExpr({ kind: "column", name: item.column }, item.from === "left" ? leftScope : rightScope),
      as: item.as ?? item.column
    }));
    const columns = items.map((item) => item.as);
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${items.map((item) => `${item.sql} AS ${context.dialect.quoteIdent(item.as)}`).join(", ")} `
        + `FROM ${left.alias} AS l ${parameters.type === "left" ? "LEFT JOIN" : "INNER JOIN"} ${right.alias} AS r `
        + `ON ${conditions.join(" AND ")}`,
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["join_keys_exist", "join_cardinality", "row_budget"],
  failure: { ...DEFAULT_FAILURE, replanOn: [...DEFAULT_FAILURE.replanOn, "JOIN_FANOUT_EXCEEDED"] },
  conformance: [{
    name: "inner join with default select renames clashes",
    inputs: [
      { columns: ["customer_id", "amount", "region"], rows: [[1, 10, "east"], [2, 20, "west"], [3, 5, "east"]] },
      { columns: ["id", "region", "tier"], rows: [[1, "e", "gold"], [2, "w", "silver"]] }
    ],
    parameters: { on: [{ left: "customer_id", right: "id" }] },
    expected: {
      columns: ["customer_id", "amount", "region", "region_right", "tier"],
      rows: [[1, 10, "east", "e", "gold"], [2, 20, "west", "w", "silver"]]
    }
  }, {
    name: "left join keeps unmatched rows",
    inputs: [
      { columns: ["k", "v"], rows: [[1, "a"], [2, "b"]] },
      { columns: ["k", "w"], rows: [[1, "x"]] }
    ],
    parameters: {
      type: "left",
      on: [{ left: "k", right: "k" }],
      select: [{ from: "left", column: "k" }, { from: "right", column: "w" }]
    },
    expected: { columns: ["k", "w"], rows: [[1, "x"], [2, null]] }
  }]
};

// ---- aggregate --------------------------------------------------------------

export const AGGREGATE_FUNCTIONS = ["count", "count_distinct", "sum", "avg", "min", "max"] as const;
export type AggregateFunction = typeof AGGREGATE_FUNCTIONS[number];
export type AggregateSpec = {
  fn: AggregateFunction;
  column?: Expr | undefined;
  as: string;
  filter?: Predicate | undefined;
};

export const aggregateSpecSchema = z.object({
  fn: z.enum(AGGREGATE_FUNCTIONS),
  column: exprSchema.optional(),
  as: z.string().min(1),
  filter: predicateSchema.optional()
});

const aggregateParameters = z.object({
  groupBy: z.array(z.string().min(1)).max(32).default([]),
  aggregates: z.array(aggregateSpecSchema).min(1).max(64)
});

/** Aggregate SQL with an optional per-aggregate filter, emulated via CASE (MySQL has no FILTER). */
export const renderAggregate = (spec: AggregateSpec, context: RenderContext, input = singleInput(context)): string => {
  const scope = scopeOf(context, input);
  if (!spec.column && spec.fn !== "count") {
    throw new PlannerError("AGGREGATE_COLUMN_REQUIRED", `${spec.fn} requires a column.`);
  }
  const predicate = spec.filter ? renderPredicate(spec.filter, scope) : undefined;
  if (!spec.column) {
    return predicate ? `SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END)` : "COUNT(*)";
  }
  const value = renderExpr(spec.column, scope);
  const argument = predicate ? `CASE WHEN ${predicate} THEN ${value} END` : value;
  switch (spec.fn) {
    case "count":
      return `COUNT(${argument})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${argument})`;
    case "sum":
      return `SUM(${argument})`;
    case "avg":
      return `AVG(${context.dialect.castNumber(argument)})`;
    case "min":
      return `MIN(${argument})`;
    case "max":
      return `MAX(${argument})`;
  }
};

export const aggregateOperator: ExecutableOperatorDefinition<z.infer<typeof aggregateParameters>> = {
  name: "aggregate",
  category: "data",
  description: "Group by columns and compute count, count_distinct, sum, avg, min, or max, each optionally filtered.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: aggregateParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const groups = quotedColumns(context, input, parameters.groupBy);
    const aggregates = parameters.aggregates.map((spec) =>
      `${renderAggregate(spec, context, input)} AS ${context.dialect.quoteIdent(spec.as)}`);
    const columns = [...parameters.groupBy, ...parameters.aggregates.map((spec) => spec.as)];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${[...groups, ...aggregates].join(", ")} FROM ${input.alias}`
        + (groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : ""),
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "grouped sum, avg, filtered count, and distinct count",
    inputs: [{
      columns: ["region", "customer", "amount"],
      rows: [["east", "a", 10], ["east", "b", 30], ["east", "a", 5], ["west", "c", 7]]
    }],
    parameters: {
      groupBy: ["region"],
      aggregates: [
        { fn: "sum", column: "amount", as: "total" },
        { fn: "avg", column: "amount", as: "mean" },
        { fn: "count", as: "big_orders", filter: { kind: "compare", op: ">", left: "amount", right: { kind: "literal", value: 8 } } },
        { fn: "count_distinct", column: "customer", as: "customers" }
      ]
    },
    expected: { columns: ["region", "total", "mean", "big_orders", "customers"], rows: [["east", 45, 15, 2, 2], ["west", 7, 7, 0, 1]] }
  }, {
    name: "global aggregate without group by",
    inputs: [{ columns: ["amount"], rows: [[1], [2], [3]] }],
    parameters: { aggregates: [{ fn: "count", as: "n" }, { fn: "max", column: "amount", as: "top" }] },
    expected: { columns: ["n", "top"], rows: [[3, 3]] }
  }]
};

// ---- sort -------------------------------------------------------------------

const sortParameters = z.object({ orderBy: z.array(orderSpecSchema).min(1).max(16) });

export const sortOperator: ExecutableOperatorDefinition<z.infer<typeof sortParameters>> = {
  name: "sort",
  category: "data",
  description: "Order rows. The order is carried to downstream limit/rank nodes and re-applied on output.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: sortParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    return {
      sql: `SELECT * FROM ${input.alias} ORDER BY ${renderOrderBy(context, input, parameters.orderBy)}`,
      columns: [...input.columns],
      ordering: parameters.orderBy
    };
  },
  estimateCost: passThroughCost,
  obligations: ["ordering"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "descending with nulls last",
    inputs: [{ columns: ["name", "score"], rows: [["a", 2], ["b", null], ["c", 9]] }],
    parameters: { orderBy: [{ column: "score", direction: "desc", nulls: "last" }] },
    expected: { columns: ["name", "score"], rows: [["c", 9], ["a", 2], ["b", null]], ordered: true }
  }]
};

// ---- limit ------------------------------------------------------------------

const limitParameters = z.object({ count: z.number().int().min(1).max(1_000_000) });

export const limitOperator: ExecutableOperatorDefinition<z.infer<typeof limitParameters>> = {
  name: "limit",
  category: "data",
  description: "Keep the first N rows in the input's established order.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: limitParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    // A subquery's ORDER BY is not guaranteed to survive into its consumer, so the
    // upstream order is restated here; without one the kept rows are arbitrary.
    const orderBy = input.ordering && input.ordering.length > 0
      ? ` ORDER BY ${renderOrderBy(context, input, input.ordering)}`
      : "";
    return withOrdering({
      sql: `SELECT * FROM ${input.alias}${orderBy} LIMIT ${parameters.count}`,
      columns: [...input.columns]
    }, surviving(input.ordering, input.columns));
  },
  estimateCost: (parameters, inputs) => {
    const rows = Math.max(1, Math.min(parameters.count, ...inputs.map((input) => input.rows)));
    return { rows, cost: Math.max(1, ...inputs.map((input) => input.rows)) };
  },
  obligations: ["result_row_limit"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "keeps the first rows of a sorted input",
    inputs: [{ columns: ["v"], rows: [[1], [3], [2]], ordering: [{ column: "v", direction: "desc" }] }],
    parameters: { count: 2 },
    expected: { columns: ["v"], rows: [[3], [2]], ordered: true }
  }]
};

// ---- window -----------------------------------------------------------------

const WINDOW_FUNCTIONS = ["row_number", "rank", "dense_rank", "lag", "lead", "sum", "avg", "min", "max", "count"] as const;

type WindowSpec = {
  fn: typeof WINDOW_FUNCTIONS[number];
  column?: string | undefined;
  offset?: number | undefined;
  as: string;
  frame?: "partition" | "running" | undefined;
};

const windowParameters = z.object({
  partitionBy: z.array(z.string().min(1)).max(16).default([]),
  orderBy: z.array(orderSpecSchema).max(16).default([]),
  functions: z.array(z.object({
    fn: z.enum(WINDOW_FUNCTIONS),
    column: z.string().min(1).optional(),
    offset: z.number().int().min(1).max(1000).optional(),
    as: z.string().min(1),
    frame: z.enum(["partition", "running"]).optional()
  })).min(1).max(32)
});

export const windowOperator: ExecutableOperatorDefinition<{
  partitionBy: string[];
  orderBy: Array<z.infer<typeof orderSpecSchema>>;
  functions: WindowSpec[];
}> = {
  name: "window",
  category: "data",
  description: "Add window-function columns (ranking, lag/lead, partition or running aggregates) without collapsing rows.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: windowParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const partition = quotedColumns(context, input, parameters.partitionBy);
    const orderBy = parameters.orderBy.length > 0 ? renderOrderBy(context, input, parameters.orderBy) : "";
    // Ranking and offset functions are ordered; aggregates cover the whole partition
    // unless a running frame is requested (an ordered aggregate window would otherwise
    // silently become cumulative under the SQL default frame).
    const over = (frame: "ordered" | "partition" | "running"): string => {
      const clauses = [
        ...(partition.length > 0 ? [`PARTITION BY ${partition.join(", ")}`] : []),
        ...(frame !== "partition" ? [`ORDER BY ${orderBy}`] : []),
        ...(frame === "running" ? ["ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"] : [])
      ];
      return `OVER (${clauses.join(" ")})`;
    };
    const items = parameters.functions.map((spec) => {
      const ranking = ["row_number", "rank", "dense_rank", "lag", "lead"].includes(spec.fn);
      const frame = ranking ? "ordered" : spec.frame === "running" ? "running" : "partition";
      if (frame !== "partition" && !orderBy) {
        throw new PlannerError("WINDOW_ORDER_REQUIRED", `Window function ${spec.fn} (${spec.as}) requires orderBy.`);
      }
      const column = spec.column ? quotedColumns(context, input, [spec.column])[0] : undefined;
      if (!column && spec.fn !== "count" && !["row_number", "rank", "dense_rank"].includes(spec.fn)) {
        throw new PlannerError("WINDOW_COLUMN_REQUIRED", `${spec.fn} (${spec.as}) requires a column.`);
      }
      const call = (() => {
        switch (spec.fn) {
          case "row_number":
          case "rank":
          case "dense_rank":
            return `${spec.fn.toUpperCase()}()`;
          case "lag":
          case "lead":
            return `${spec.fn.toUpperCase()}(${column}, ${spec.offset ?? 1})`;
          case "count":
            return `COUNT(${column ?? "*"})`;
          case "avg":
            return `AVG(${context.dialect.castNumber(column as string)})`;
          default:
            return `${spec.fn.toUpperCase()}(${column})`;
        }
      })();
      return { sql: `${call} ${over(frame)}`, as: spec.as };
    });
    const columns = [...input.columns, ...items.map((item) => item.as)];
    assertUniqueColumns(columns);
    return withOrdering({
      sql: `SELECT *, ${items.map((item) => `${item.sql} AS ${context.dialect.quoteIdent(item.as)}`).join(", ")} `
        + `FROM ${input.alias}`,
      columns
    }, surviving(input.ordering, columns));
  },
  estimateCost: passThroughCost,
  obligations: ["ordering"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "running sum, lag, and partition total",
    inputs: [{ columns: ["g", "t", "v"], rows: [["a", 1, 10], ["a", 2, 5], ["b", 1, 7]] }],
    parameters: {
      partitionBy: ["g"],
      orderBy: [{ column: "t", direction: "asc" }],
      functions: [
        { fn: "sum", column: "v", as: "running", frame: "running" },
        { fn: "lag", column: "v", as: "prev" },
        { fn: "sum", column: "v", as: "group_total" }
      ]
    },
    expected: {
      columns: ["g", "t", "v", "running", "prev", "group_total"],
      rows: [["a", 1, 10, 10, null, 15], ["a", 2, 5, 15, 10, 15], ["b", 1, 7, 7, null, 7]]
    }
  }]
};

export const DATA_OPERATORS = [
  scanOperator,
  filterOperator,
  projectOperator,
  joinOperator,
  aggregateOperator,
  sortOperator,
  limitOperator,
  windowOperator
] as const;
