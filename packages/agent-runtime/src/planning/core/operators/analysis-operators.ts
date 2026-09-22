import { z } from "zod";

import { PlannerError } from "../errors.js";
import { renderAggregate } from "./data-operators.js";
import { exprSchema, predicateSchema, renderExpr, type Expr, type Predicate } from "./expressions.js";
import {
  assertUniqueColumns,
  DEFAULT_FAILURE,
  orderSpecSchema,
  passThroughCost,
  quotedColumns,
  renderOrderBy,
  scopeOf,
  singleInput,
  type ExecutableOperatorDefinition,
  type OrderSpec
} from "./types.js";

/**
 * Analysis operators compile to portable SQL over one input. Each is a named, verified
 * shape of computation the model would otherwise improvise as free-form SQL.
 */

const ALL_DIALECTS = ["duckdb", "sqlite", "postgres", "mysql"] as const;
const ascending = (columns: readonly string[]): OrderSpec[] =>
  columns.map((column) => ({ column, direction: "asc" as const }));

// ---- compare ----------------------------------------------------------------

type CompareSide = { as: string; predicate: Predicate };
type CompareParameters = {
  groupBy: string[];
  measure?: Expr | undefined;
  fn: "sum" | "avg" | "count" | "min" | "max";
  left: CompareSide;
  right: CompareSide;
  differenceAs: string;
  ratioAs: string;
};

const compareSide = z.object({ as: z.string().min(1), predicate: predicateSchema });
const compareParameters = z.object({
  groupBy: z.array(z.string().min(1)).max(16).default([]),
  measure: exprSchema.optional(),
  fn: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
  left: compareSide,
  right: compareSide,
  differenceAs: z.string().min(1).default("difference"),
  ratioAs: z.string().min(1).default("ratio")
});

export const compareOperator: ExecutableOperatorDefinition<CompareParameters> = {
  name: "compare",
  category: "analysis",
  description: "Aggregate one measure for two row segments side by side, with their difference and ratio.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: compareParameters as z.ZodType<CompareParameters>,
  render: (parameters, context) => {
    const input = singleInput(context);
    const side = (spec: CompareSide): string => renderAggregate(
      { fn: parameters.fn, column: parameters.measure, as: spec.as, filter: spec.predicate },
      context,
      input
    );
    const left = side(parameters.left);
    const right = side(parameters.right);
    const groups = quotedColumns(context, input, parameters.groupBy);
    const q = context.dialect.quoteIdent;
    const columns = [
      ...parameters.groupBy,
      parameters.left.as,
      parameters.right.as,
      parameters.differenceAs,
      parameters.ratioAs
    ];
    assertUniqueColumns(columns);
    const items = [
      ...groups,
      `${left} AS ${q(parameters.left.as)}`,
      `${right} AS ${q(parameters.right.as)}`,
      `(${left} - ${right}) AS ${q(parameters.differenceAs)}`,
      `(${context.dialect.castNumber(left)} / NULLIF(${right}, 0)) AS ${q(parameters.ratioAs)}`
    ];
    return {
      sql: `SELECT ${items.join(", ")} FROM ${input.alias}${groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : ""}`,
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "2024 versus 2023 revenue per region",
    inputs: [{
      columns: ["region", "year", "revenue"],
      rows: [["east", 2023, 100], ["east", 2024, 150], ["west", 2023, 80], ["west", 2024, 40]]
    }],
    parameters: {
      groupBy: ["region"],
      measure: "revenue",
      left: { as: "y2024", predicate: { kind: "compare", op: "=", left: "year", right: { kind: "literal", value: 2024 } } },
      right: { as: "y2023", predicate: { kind: "compare", op: "=", left: "year", right: { kind: "literal", value: 2023 } } }
    },
    expected: {
      columns: ["region", "y2024", "y2023", "difference", "ratio"],
      rows: [["east", 150, 100, 50, 1.5], ["west", 40, 80, -40, 0.5]]
    }
  }]
};

// ---- growth_rate ------------------------------------------------------------

const growthParameters = z.object({
  orderBy: z.string().min(1),
  partitionBy: z.array(z.string().min(1)).max(16).default([]),
  measure: z.string().min(1),
  as: z.string().min(1).default("growth_rate"),
  previousAs: z.string().min(1).default("previous_value")
});

export const growthRateOperator: ExecutableOperatorDefinition<z.infer<typeof growthParameters>> = {
  name: "growth_rate",
  category: "analysis",
  description: "Period-over-period growth: (value - previous) / previous along an ordered period column.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: growthParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const [measure] = quotedColumns(context, input, [parameters.measure]);
    const partition = quotedColumns(context, input, parameters.partitionBy);
    const order = renderOrderBy(context, input, [{ column: parameters.orderBy, direction: "asc" }]);
    const over = `OVER (${partition.length > 0 ? `PARTITION BY ${partition.join(", ")} ` : ""}ORDER BY ${order})`;
    const previous = `LAG(${measure}) ${over}`;
    const q = context.dialect.quoteIdent;
    const columns = [...input.columns, parameters.previousAs, parameters.as];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT *, ${previous} AS ${q(parameters.previousAs)}, `
        + `((${context.dialect.castNumber(measure as string)} - ${previous}) / NULLIF(${previous}, 0)) AS ${q(parameters.as)} `
        + `FROM ${input.alias}`,
      columns,
      ordering: ascending([...parameters.partitionBy, parameters.orderBy])
    };
  },
  estimateCost: passThroughCost,
  obligations: ["ordering"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "month-over-month growth per region",
    inputs: [{
      columns: ["region", "month", "revenue"],
      rows: [["east", "2024-02", 150], ["east", "2024-01", 100], ["west", "2024-01", 50], ["west", "2024-02", 25]]
    }],
    parameters: { orderBy: "month", partitionBy: ["region"], measure: "revenue" },
    expected: {
      columns: ["region", "month", "revenue", "previous_value", "growth_rate"],
      rows: [
        ["east", "2024-01", 100, null, null],
        ["east", "2024-02", 150, 100, 0.5],
        ["west", "2024-01", 50, null, null],
        ["west", "2024-02", 25, 50, -0.5]
      ],
      ordered: true
    }
  }]
};

// ---- contribution -----------------------------------------------------------

type ContributionParameters = {
  groupBy: string[];
  measure?: Expr | undefined;
  fn: "sum" | "count";
  valueAs: string;
  shareAs: string;
  withinGroupBy: string[];
};

const contributionParameters = z.object({
  groupBy: z.array(z.string().min(1)).min(1).max(16),
  measure: exprSchema.optional(),
  fn: z.enum(["sum", "count"]).default("sum"),
  valueAs: z.string().min(1).default("value"),
  shareAs: z.string().min(1).default("share"),
  withinGroupBy: z.array(z.string().min(1)).max(15).default([])
});

export const contributionOperator: ExecutableOperatorDefinition<ContributionParameters> = {
  name: "contribution",
  category: "analysis",
  description: "Aggregate a measure per group and each group's share of the total (optionally within a parent group).",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: contributionParameters as z.ZodType<ContributionParameters>,
  render: (parameters, context) => {
    const input = singleInput(context);
    const stray = parameters.withinGroupBy.filter((column) => !parameters.groupBy.includes(column));
    if (stray.length > 0) {
      throw new PlannerError("CONTRIBUTION_PARENT_NOT_GROUPED", `withinGroupBy columns must be in groupBy: ${stray.join(", ")}.`);
    }
    const groups = quotedColumns(context, input, parameters.groupBy);
    const within = quotedColumns(context, input, parameters.withinGroupBy);
    const value = renderAggregate({ fn: parameters.fn, column: parameters.measure, as: parameters.valueAs }, context, input);
    const total = `SUM(${value}) OVER (${within.length > 0 ? `PARTITION BY ${within.join(", ")}` : ""})`;
    const q = context.dialect.quoteIdent;
    const columns = [...parameters.groupBy, parameters.valueAs, parameters.shareAs];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${groups.join(", ")}, ${value} AS ${q(parameters.valueAs)}, `
        + `(${context.dialect.castNumber(value)} / NULLIF(${total}, 0)) AS ${q(parameters.shareAs)} `
        + `FROM ${input.alias} GROUP BY ${groups.join(", ")}`,
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation", "share_bounds"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "revenue share by region",
    inputs: [{ columns: ["region", "revenue"], rows: [["east", 30], ["east", 20], ["west", 50]] }],
    parameters: { groupBy: ["region"], measure: "revenue" },
    expected: { columns: ["region", "value", "share"], rows: [["east", 50, 0.5], ["west", 50, 0.5]] }
  }]
};

// ---- composition ------------------------------------------------------------

const compositionParameters = z.object({
  measure: z.string().min(1),
  partitionBy: z.array(z.string().min(1)).max(16).default([]),
  shareAs: z.string().min(1).default("share")
});

export const compositionOperator: ExecutableOperatorDefinition<z.infer<typeof compositionParameters>> = {
  name: "composition",
  category: "analysis",
  description: "Each row's share of its partition's total, without aggregating rows (use on already-aggregated parts).",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: compositionParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const [measure] = quotedColumns(context, input, [parameters.measure]);
    const partition = quotedColumns(context, input, parameters.partitionBy);
    const columns = [...input.columns, parameters.shareAs];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT *, (${context.dialect.castNumber(measure as string)} / NULLIF(SUM(${measure}) OVER (`
        + `${partition.length > 0 ? `PARTITION BY ${partition.join(", ")}` : ""}), 0)) `
        + `AS ${context.dialect.quoteIdent(parameters.shareAs)} FROM ${input.alias}`,
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["share_bounds"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "channel mix within each month",
    inputs: [{ columns: ["month", "channel", "orders"], rows: [["m1", "web", 3], ["m1", "store", 1], ["m2", "web", 2]] }],
    parameters: { measure: "orders", partitionBy: ["month"] },
    expected: {
      columns: ["month", "channel", "orders", "share"],
      rows: [["m1", "web", 3, 0.75], ["m1", "store", 1, 0.25], ["m2", "web", 2, 1]]
    }
  }]
};

// ---- rank -------------------------------------------------------------------

const rankParameters = z.object({
  orderBy: z.array(orderSpecSchema).min(1).max(8),
  partitionBy: z.array(z.string().min(1)).max(16).default([]),
  method: z.enum(["rank", "dense_rank", "row_number"]).default("rank"),
  as: z.string().min(1).default("rank"),
  top: z.number().int().min(1).max(100_000).optional()
});

export const rankOperator: ExecutableOperatorDefinition<z.infer<typeof rankParameters>> = {
  name: "rank",
  category: "analysis",
  description: "Rank rows by an ordering (optionally per partition) and optionally keep the top N ranks.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: rankParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const partition = quotedColumns(context, input, parameters.partitionBy);
    const over = `OVER (${partition.length > 0 ? `PARTITION BY ${partition.join(", ")} ` : ""}`
      + `ORDER BY ${renderOrderBy(context, input, parameters.orderBy)})`;
    const rankColumn = context.dialect.quoteIdent(parameters.as);
    const columns = [...input.columns, parameters.as];
    assertUniqueColumns(columns);
    const ranked = `SELECT *, ${parameters.method.toUpperCase()}() ${over} AS ${rankColumn} FROM ${input.alias}`;
    return {
      sql: parameters.top === undefined
        ? ranked
        : `SELECT * FROM (${ranked}) AS ranked WHERE ${rankColumn} <= ${parameters.top}`,
      columns,
      ordering: [...ascending(parameters.partitionBy), { column: parameters.as, direction: "asc" }]
    };
  },
  estimateCost: (parameters, inputs) => {
    const inputRows = Math.max(1, ...inputs.map((input) => input.rows));
    return { rows: parameters.top ? Math.min(inputRows, parameters.top) : inputRows, cost: inputRows };
  },
  obligations: ["ordering"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "top two products per category",
    inputs: [{
      columns: ["category", "product", "sales"],
      rows: [["a", "p1", 5], ["a", "p2", 9], ["a", "p3", 7], ["b", "p4", 1]]
    }],
    parameters: { orderBy: [{ column: "sales", direction: "desc" }], partitionBy: ["category"], top: 2 },
    expected: {
      columns: ["category", "product", "sales", "rank"],
      rows: [["a", "p2", 9, 1], ["a", "p3", 7, 2], ["b", "p4", 1, 1]],
      ordered: true
    }
  }]
};

// ---- quantile ---------------------------------------------------------------

const quantileParameters = z.object({
  column: z.string().min(1),
  quantiles: z.array(z.object({ fraction: z.number().min(0).max(1), as: z.string().min(1) })).min(1).max(20),
  groupBy: z.array(z.string().min(1)).max(16).default([])
});

export const quantileOperator: ExecutableOperatorDefinition<z.infer<typeof quantileParameters>> = {
  name: "quantile",
  category: "analysis",
  description: "Continuous (interpolated) percentiles of a numeric column, optionally per group.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  // SQLite and MySQL have no ordered-set percentile; a ROW_NUMBER emulation is not
  // the same statistic, so those dialects are refused rather than approximated.
  dialects: ["duckdb", "postgres"],
  parameterSchema: quantileParameters,
  render: (parameters, context) => {
    const percentile = context.dialect.percentileCont;
    if (!percentile) {
      throw new PlannerError("DIALECT_FUNCTION_UNSUPPORTED", `quantile is not available for ${context.dialect.name}.`);
    }
    const input = singleInput(context);
    const [column] = quotedColumns(context, input, [parameters.column]);
    const groups = quotedColumns(context, input, parameters.groupBy);
    const columns = [...parameters.groupBy, ...parameters.quantiles.map((quantile) => quantile.as)];
    assertUniqueColumns(columns);
    const items = parameters.quantiles.map((quantile) =>
      `${percentile(quantile.fraction, context.dialect.castNumber(column as string))} AS ${context.dialect.quoteIdent(quantile.as)}`);
    return {
      sql: `SELECT ${[...groups, ...items].join(", ")} FROM ${input.alias}`
        + (groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : ""),
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation"],
  failure: { ...DEFAULT_FAILURE, replanOn: [...DEFAULT_FAILURE.replanOn, "DIALECT_FUNCTION_UNSUPPORTED"] },
  conformance: [{
    name: "median and p90",
    inputs: [{ columns: ["latency"], rows: [[1], [2], [3], [4], [10]] }],
    parameters: { column: "latency", quantiles: [{ fraction: 0.5, as: "p50" }, { fraction: 0.9, as: "p90" }] },
    expected: { columns: ["p50", "p90"], rows: [[3, 7.6]] }
  }]
};

// ---- distribution -----------------------------------------------------------

const DISTRIBUTION_STATS = ["count", "nulls", "distinct", "min", "max", "mean", "variance", "stddev"] as const;
type DistributionStat = typeof DISTRIBUTION_STATS[number];

const distributionParameters = z.object({
  column: z.string().min(1),
  groupBy: z.array(z.string().min(1)).max(16).default([]),
  stats: z.array(z.enum(DISTRIBUTION_STATS)).min(1).max(DISTRIBUTION_STATS.length)
    .default(["count", "nulls", "distinct", "min", "max", "mean", "variance"]),
  prefix: z.string().default("")
});

export const distributionOperator: ExecutableOperatorDefinition<z.infer<typeof distributionParameters>> = {
  name: "distribution",
  category: "analysis",
  description: "Summary statistics of one column: count, nulls, distinct, min, max, mean, sample variance/stddev.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: distributionParameters,
  render: (parameters, context) => {
    const input = singleInput(context);
    const [raw] = quotedColumns(context, input, [parameters.column]) as [string];
    const numeric = context.dialect.castNumber(raw);
    const stat = (name: DistributionStat): string => {
      switch (name) {
        case "count":
          return `COUNT(${raw})`;
        case "nulls":
          return `SUM(CASE WHEN ${raw} IS NULL THEN 1 ELSE 0 END)`;
        case "distinct":
          return `COUNT(DISTINCT ${raw})`;
        case "min":
          return `MIN(${raw})`;
        case "max":
          return `MAX(${raw})`;
        case "mean":
          return `AVG(${numeric})`;
        case "variance":
          return context.dialect.varianceSamp(numeric);
        case "stddev":
          if (!context.dialect.stddevSamp) {
            throw new PlannerError("DIALECT_FUNCTION_UNSUPPORTED", `stddev is not available for ${context.dialect.name}; use variance.`);
          }
          return context.dialect.stddevSamp(numeric);
      }
    };
    const groups = quotedColumns(context, input, parameters.groupBy);
    const named = parameters.stats.map((name) => ({ sql: stat(name), as: `${parameters.prefix}${name}` }));
    const columns = [...parameters.groupBy, ...named.map((item) => item.as)];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${[...groups, ...named.map((item) => `${item.sql} AS ${context.dialect.quoteIdent(item.as)}`)].join(", ")} `
        + `FROM ${input.alias}${groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : ""}`,
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation"],
  failure: { ...DEFAULT_FAILURE, replanOn: [...DEFAULT_FAILURE.replanOn, "DIALECT_FUNCTION_UNSUPPORTED"] },
  conformance: [{
    name: "default summary statistics",
    inputs: [{ columns: ["x"], rows: [[2], [4], [4], [null], [6]] }],
    parameters: { column: "x" },
    expected: {
      columns: ["count", "nulls", "distinct", "min", "max", "mean", "variance"],
      rows: [[4, 1, 3, 2, 6, 4, 8 / 3]]
    }
  }]
};

// ---- trend ------------------------------------------------------------------

type TrendParameters = {
  x: Expr;
  y: Expr;
  groupBy: string[];
  slopeAs: string;
  interceptAs: string;
  countAs: string;
};

const trendParameters = z.object({
  x: exprSchema,
  y: exprSchema,
  groupBy: z.array(z.string().min(1)).max(16).default([]),
  slopeAs: z.string().min(1).default("slope"),
  interceptAs: z.string().min(1).default("intercept"),
  countAs: z.string().min(1).default("points")
});

export const trendOperator: ExecutableOperatorDefinition<TrendParameters> = {
  name: "trend",
  category: "analysis",
  description: "Least-squares linear trend y = intercept + slope * x over non-null points, optionally per group. "
    + "For dates, use x = {kind:'call', fn:'epoch_seconds'} or a year/month extraction.",
  sideEffectClass: "none",
  executable: true,
  arity: { min: 1, max: 1 },
  dialects: ALL_DIALECTS,
  parameterSchema: trendParameters as z.ZodType<TrendParameters>,
  render: (parameters, context) => {
    const input = singleInput(context);
    const scope = scopeOf(context, input);
    const { castNumber, quoteIdent: q } = context.dialect;
    const x = castNumber(renderExpr(parameters.x, scope));
    const y = castNumber(renderExpr(parameters.y, scope));
    const groups = quotedColumns(context, input, parameters.groupBy);
    const px = q("trend_x__");
    const py = q("trend_y__");
    const n = "COUNT(*)";
    const slope = `((${n} * SUM(${px} * ${py}) - SUM(${px}) * SUM(${py})) `
      + `/ NULLIF(${n} * SUM(${px} * ${px}) - SUM(${px}) * SUM(${px}), 0))`;
    const intercept = `((SUM(${py}) - ${slope} * SUM(${px})) / ${n})`;
    const columns = [...parameters.groupBy, parameters.countAs, parameters.slopeAs, parameters.interceptAs];
    assertUniqueColumns(columns);
    return {
      sql: `SELECT ${[...groups, `${n} AS ${q(parameters.countAs)}`, `${slope} AS ${q(parameters.slopeAs)}`,
        `${intercept} AS ${q(parameters.interceptAs)}`].join(", ")} `
        + `FROM (SELECT ${[...groups, `${x} AS ${px}`, `${y} AS ${py}`].join(", ")} FROM ${input.alias}) AS points `
        + `WHERE ${px} IS NOT NULL AND ${py} IS NOT NULL`
        + (groups.length > 0 ? ` GROUP BY ${groups.join(", ")}` : ""),
      columns
    };
  },
  estimateCost: passThroughCost,
  obligations: ["required_aggregation", "min_points"],
  failure: DEFAULT_FAILURE,
  conformance: [{
    name: "slope and intercept per series",
    inputs: [{
      columns: ["series", "t", "v"],
      rows: [["a", 1, 3], ["a", 2, 5], ["a", 3, 7], ["b", 1, 10], ["b", 2, 10], ["b", 3, null]]
    }],
    parameters: { x: "t", y: "v", groupBy: ["series"] },
    expected: { columns: ["series", "points", "slope", "intercept"], rows: [["a", 3, 2, 1], ["b", 2, 0, 10]] }
  }]
};

export const ANALYSIS_OPERATORS = [
  compareOperator,
  growthRateOperator,
  contributionOperator,
  compositionOperator,
  rankOperator,
  quantileOperator,
  distributionOperator,
  trendOperator
] as const;
