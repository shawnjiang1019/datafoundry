import { z } from "zod";

import { PlannerError } from "../errors.js";
import type { PlannerDialect, PlannerDialectName } from "./dialect.js";
import { columnRef, type ExpressionScope } from "./expressions.js";

export type OperatorCategory = "data" | "analysis" | "semantic" | "control" | "side_effect";
export type SideEffectClass = "none" | "read" | "staged_write" | "write";

/** Every operator of the D-Trail vocabulary is representable in a logical plan. */
export type OperatorDefinition = {
  name: string;
  category: OperatorCategory;
  description: string;
  sideEffectClass: SideEffectClass;
  executable: false;
};

export type OrderSpec = { column: string; direction: "asc" | "desc"; nulls?: "first" | "last" | undefined };

export const orderSpecSchema = z.object({
  column: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
  nulls: z.enum(["first", "last"]).optional()
});

export type RenderInput = {
  /** CTE (or table) alias the node reads from. */
  alias: string;
  columns: readonly string[];
  /** Row order the input carries, when an upstream sort established one. */
  ordering?: readonly OrderSpec[];
};

export type RenderContext = {
  dialect: PlannerDialect;
  inputs: readonly RenderInput[];
  /** Grounded physical columns of a source table, or undefined when the table is not grounded. */
  tableColumns(table: string): readonly string[] | undefined;
};

export type RenderResult = {
  /** A single SELECT statement usable as a CTE body. */
  sql: string;
  columns: string[];
  /** Row order the output carries; the compiler re-applies it at the top level. */
  ordering?: OrderSpec[];
};

export type CostEstimate = { rows: number; cost: number };

export type FailurePolicy = {
  retryable: boolean;
  /** Error codes that make the planner build a new plan branch. */
  replanOn: string[];
  /** Error codes that need a human decision instead of a replan. */
  clarifyOn: string[];
};

export type ConformanceTable = { columns: string[]; rows: unknown[][] };

export type ConformanceCase = {
  name: string;
  /** Defaults to every dialect the operator supports. */
  dialects?: PlannerDialectName[];
  /** Input relations; a scan case names its table "source". `ordering` simulates an upstream sort. */
  inputs: Array<ConformanceTable & { ordering?: OrderSpec[] }>;
  parameters: unknown;
  /** `ordered` asserts row order; numeric cells compare with a relative tolerance. */
  expected: ConformanceTable & { ordered?: boolean };
};

/**
 * An operator the planner may execute. D-Trail requires six gates before an operator
 * is executable, and each is a field here: (1) parameterSchema, (2) render — the SQL
 * body per dialect, (3) estimateCost, (4) obligations, (5) failure, (6) conformance.
 */
export type ExecutableOperatorDefinition<TParams = unknown> = Omit<OperatorDefinition, "executable"> & {
  executable: true;
  arity: { min: number; max: number };
  dialects: readonly PlannerDialectName[];
  parameterSchema: z.ZodType<TParams>;
  render(parameters: TParams, context: RenderContext): RenderResult;
  estimateCost(parameters: TParams, inputs: readonly CostEstimate[], context: { tableRows?: number }): CostEstimate;
  obligations: readonly string[];
  failure: FailurePolicy;
  conformance: readonly ConformanceCase[];
};

export type AnyExecutableOperator = ExecutableOperatorDefinition<any>;

/** static-cost-v1: a node costs as many rows as its largest input (D-Trail baseline). */
export const passThroughCost = (_parameters: unknown, inputs: readonly CostEstimate[]): CostEstimate => {
  const rows = Math.max(1, ...inputs.map((input) => input.rows));
  return { rows, cost: rows };
};

export const singleInput = (context: RenderContext): RenderInput => {
  const input = context.inputs[0];
  if (!input || context.inputs.length !== 1) {
    throw new PlannerError("OPERATOR_ARITY", `Expected exactly one input, received ${context.inputs.length}.`);
  }
  return input;
};

export const scopeOf = (context: RenderContext, input: RenderInput, qualifier?: string): ExpressionScope => ({
  dialect: context.dialect,
  columns: input.columns,
  ...(qualifier ? { qualifier } : {})
});

export const quotedColumns = (context: RenderContext, input: RenderInput, names: readonly string[]): string[] =>
  names.map((name) => columnRef(name, scopeOf(context, input)));

/** Output names must be unique and non-empty; duplicates would make CTE columns ambiguous. */
export const assertUniqueColumns = (columns: readonly string[]): void => {
  const seen = new Set<string>();
  for (const column of columns) {
    if (!column) {
      throw new PlannerError("OUTPUT_COLUMN_EMPTY", "Output column names must be non-empty.");
    }
    if (seen.has(column)) {
      throw new PlannerError("OUTPUT_COLUMN_DUPLICATE", `Output column ${JSON.stringify(column)} is produced twice.`, {
        column
      });
    }
    seen.add(column);
  }
};

/**
 * ORDER BY terms. NULL placement is emulated with a CASE key because MySQL has no
 * NULLS FIRST/LAST and SQLite/DuckDB/PostgreSQL disagree on the default.
 */
export const renderOrderBy = (context: RenderContext, input: RenderInput, ordering: readonly OrderSpec[]): string =>
  ordering.flatMap((order) => {
    const column = columnRef(order.column, scopeOf(context, input));
    const direction = order.direction === "desc" ? "DESC" : "ASC";
    return order.nulls
      ? [`(CASE WHEN ${column} IS NULL THEN ${order.nulls === "first" ? 0 : 1} ELSE ${order.nulls === "first" ? 1 : 0} END)`,
        `${column} ${direction}`]
      : [`${column} ${direction}`];
  }).join(", ");

/** Keep only the orderings whose columns survive into the output. */
export const surviving = (ordering: readonly OrderSpec[] | undefined, columns: readonly string[]): OrderSpec[] | undefined => {
  if (!ordering || ordering.length === 0) return undefined;
  return ordering.every((order) => columns.includes(order.column)) ? [...ordering] : undefined;
};

export const withOrdering = (result: Omit<RenderResult, "ordering">, ordering: OrderSpec[] | undefined): RenderResult =>
  ordering ? { ...result, ordering } : result;

export const DEFAULT_FAILURE: FailurePolicy = {
  retryable: false,
  replanOn: ["COLUMN_NOT_IN_SCOPE", "SQL_EXECUTION_FAILED", "ROW_BUDGET_EXCEEDED"],
  clarifyOn: ["SOURCE_NOT_GROUNDED"]
};
