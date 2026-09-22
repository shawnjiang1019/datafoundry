import { z } from "zod";

import { PlannerError } from "../errors.js";
import type { DateGrain, PlannerDialect } from "./dialect.js";

/**
 * Plan-level expression and predicate trees. The model never writes SQL text: every
 * value, column, and function in a plan is one of these nodes, rendered per dialect
 * with identifier quoting, literal escaping, and column scoping enforced here.
 */
export type ScalarLiteral = string | number | boolean | null;

export const EXPRESSION_FUNCTIONS = [
  "abs",
  "round",
  "lower",
  "upper",
  "length",
  "coalesce",
  "nullif",
  "cast_number",
  "cast_text",
  "cast_date",
  "date_trunc",
  "year",
  "quarter",
  "month",
  "day",
  "epoch_seconds"
] as const;
export type ExpressionFunction = typeof EXPRESSION_FUNCTIONS[number];

export type Expr =
  | { kind: "column"; name: string }
  | { kind: "literal"; value: ScalarLiteral }
  | { kind: "date"; value: string }
  | { kind: "arith"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { kind: "call"; fn: ExpressionFunction; args: Expr[]; grain?: DateGrain | undefined; digits?: number | undefined }
  | { kind: "case"; branches: Array<{ when: Predicate; then: Expr }>; else?: Expr | undefined };

export type Predicate =
  | { kind: "compare"; op: "=" | "!=" | "<" | "<=" | ">" | ">="; left: Expr; right: Expr }
  | { kind: "in"; expr: Expr; values: ScalarLiteral[]; negate?: boolean | undefined }
  | { kind: "between"; expr: Expr; low: Expr; high: Expr }
  | { kind: "is_null"; expr: Expr; negate?: boolean | undefined }
  | {
      kind: "like";
      expr: Expr;
      pattern: string;
      caseInsensitive?: boolean | undefined;
      negate?: boolean | undefined;
    }
  | { kind: "and"; args: Predicate[] }
  | { kind: "or"; args: Predicate[] }
  | { kind: "not"; arg: Predicate };

const MAX_IN_VALUES = 1000;
const MAX_EXPRESSION_DEPTH = 24;

const scalarLiteralSchema = z.union([z.string(), z.number().refine(Number.isFinite, "finite"), z.boolean(), z.null()]);

/** A bare string is shorthand for a column reference. */
export const exprSchema: z.ZodType<Expr> = z.lazy(() => z.preprocess(
  (value) => typeof value === "string" ? { kind: "column", name: value } : value,
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("column"), name: z.string().min(1) }),
    z.object({ kind: z.literal("literal"), value: scalarLiteralSchema }),
    z.object({ kind: z.literal("date"), value: z.string() }),
    z.object({ kind: z.literal("arith"), op: z.enum(["+", "-", "*", "/"]), left: exprSchema, right: exprSchema }),
    z.object({
      kind: z.literal("call"),
      fn: z.enum(EXPRESSION_FUNCTIONS),
      args: z.array(exprSchema).min(1).max(8),
      grain: z.enum(["year", "quarter", "month", "week", "day"]).optional(),
      digits: z.number().int().min(0).max(12).optional()
    }),
    z.object({
      kind: z.literal("case"),
      branches: z.array(z.object({ when: predicateSchema, then: exprSchema })).min(1).max(32),
      else: exprSchema.optional()
    })
  ])
)) as z.ZodType<Expr>;

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("compare"),
    op: z.enum(["=", "!=", "<", "<=", ">", ">="]),
    left: exprSchema,
    right: exprSchema
  }),
  z.object({
    kind: z.literal("in"),
    expr: exprSchema,
    values: z.array(scalarLiteralSchema).min(1).max(MAX_IN_VALUES),
    negate: z.boolean().optional()
  }),
  z.object({ kind: z.literal("between"), expr: exprSchema, low: exprSchema, high: exprSchema }),
  z.object({ kind: z.literal("is_null"), expr: exprSchema, negate: z.boolean().optional() }),
  z.object({
    kind: z.literal("like"),
    expr: exprSchema,
    pattern: z.string(),
    caseInsensitive: z.boolean().optional(),
    negate: z.boolean().optional()
  }),
  z.object({ kind: z.literal("and"), args: z.array(predicateSchema).min(1).max(64) }),
  z.object({ kind: z.literal("or"), args: z.array(predicateSchema).min(1).max(64) }),
  z.object({ kind: z.literal("not"), arg: predicateSchema })
])) as z.ZodType<Predicate>;

/** The columns an expression may reference: the node's input columns. */
export type ExpressionScope = {
  dialect: PlannerDialect;
  columns: readonly string[];
  /** Optional table alias prefix for column references. */
  qualifier?: string;
};

export const renderExpr = (expr: Expr, scope: ExpressionScope, depth = 0): string => {
  assertDepth(depth);
  const { dialect } = scope;
  switch (expr.kind) {
    case "column":
      return columnRef(expr.name, scope);
    case "literal":
      return renderLiteral(expr.value, dialect);
    case "date":
      return dialect.dateLiteral(expr.value);
    case "arith": {
      const left = renderExpr(expr.left, scope, depth + 1);
      const right = renderExpr(expr.right, scope, depth + 1);
      // Division is real-valued and NULL on a zero divisor in every dialect, so integer
      // columns never truncate (SQLite/PostgreSQL) and a zero never aborts the query.
      return expr.op === "/"
        ? `(${dialect.castNumber(left)} / NULLIF(${right}, 0))`
        : `(${left} ${expr.op} ${right})`;
    }
    case "call":
      return renderCall(expr, scope, depth);
    case "case": {
      const branches = expr.branches.map((branch) =>
        `WHEN ${renderPredicate(branch.when, scope, depth + 1)} THEN ${renderExpr(branch.then, scope, depth + 1)}`);
      const fallback = expr.else ? ` ELSE ${renderExpr(expr.else, scope, depth + 1)}` : "";
      return `(CASE ${branches.join(" ")}${fallback} END)`;
    }
  }
};

export const renderPredicate = (predicate: Predicate, scope: ExpressionScope, depth = 0): string => {
  assertDepth(depth);
  switch (predicate.kind) {
    case "compare": {
      const op = predicate.op === "!=" ? "<>" : predicate.op;
      return `(${renderExpr(predicate.left, scope, depth + 1)} ${op} ${renderExpr(predicate.right, scope, depth + 1)})`;
    }
    case "in": {
      const values = predicate.values.map((value) => renderLiteral(value, scope.dialect)).join(", ");
      return `(${renderExpr(predicate.expr, scope, depth + 1)} ${predicate.negate ? "NOT IN" : "IN"} (${values}))`;
    }
    case "between":
      return `(${renderExpr(predicate.expr, scope, depth + 1)} BETWEEN ${renderExpr(predicate.low, scope, depth + 1)} AND `
        + `${renderExpr(predicate.high, scope, depth + 1)})`;
    case "is_null":
      return `(${renderExpr(predicate.expr, scope, depth + 1)} IS ${predicate.negate ? "NOT " : ""}NULL)`;
    case "like": {
      const subject = renderExpr(predicate.expr, scope, depth + 1);
      const pattern = scope.dialect.stringLiteral(predicate.pattern);
      const match = predicate.caseInsensitive
        ? scope.dialect.caseInsensitiveLike(subject, pattern)
        : `${subject} LIKE ${pattern}`;
      return predicate.negate ? `(NOT (${match}))` : `(${match})`;
    }
    case "and":
    case "or":
      return `(${predicate.args.map((arg) => renderPredicate(arg, scope, depth + 1))
        .join(predicate.kind === "and" ? " AND " : " OR ")})`;
    case "not":
      return `(NOT ${renderPredicate(predicate.arg, scope, depth + 1)})`;
  }
};

/** Every column an expression references, for scoping and coverage checks. */
export const exprColumns = (expr: Expr): string[] => {
  switch (expr.kind) {
    case "column":
      return [expr.name];
    case "literal":
    case "date":
      return [];
    case "arith":
      return [...exprColumns(expr.left), ...exprColumns(expr.right)];
    case "call":
      return expr.args.flatMap(exprColumns);
    case "case":
      return [
        ...expr.branches.flatMap((branch) => [...predicateColumns(branch.when), ...exprColumns(branch.then)]),
        ...(expr.else ? exprColumns(expr.else) : [])
      ];
  }
};

export const predicateColumns = (predicate: Predicate): string[] => {
  switch (predicate.kind) {
    case "compare":
      return [...exprColumns(predicate.left), ...exprColumns(predicate.right)];
    case "in":
    case "is_null":
    case "like":
      return exprColumns(predicate.expr);
    case "between":
      return [...exprColumns(predicate.expr), ...exprColumns(predicate.low), ...exprColumns(predicate.high)];
    case "and":
    case "or":
      return predicate.args.flatMap(predicateColumns);
    case "not":
      return predicateColumns(predicate.arg);
  }
};

export const columnRef = (name: string, scope: ExpressionScope): string => {
  if (!scope.columns.includes(name)) {
    throw new PlannerError(
      "COLUMN_NOT_IN_SCOPE",
      `Column ${JSON.stringify(name)} is not produced by this node's input; available: ${scope.columns.join(", ") || "none"}.`,
      { column: name, available: [...scope.columns] }
    );
  }
  const quoted = scope.dialect.quoteIdent(name);
  return scope.qualifier ? `${scope.qualifier}.${quoted}` : quoted;
};

export const renderLiteral = (value: ScalarLiteral, dialect: PlannerDialect): string => {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return dialect.name === "sqlite" ? (value ? "1" : "0") : (value ? "TRUE" : "FALSE");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PlannerError("LITERAL_NOT_FINITE", "Numeric literals must be finite.");
    }
    return String(value);
  }
  return dialect.stringLiteral(value);
};

const renderCall = (
  expr: Extract<Expr, { kind: "call" }>,
  scope: ExpressionScope,
  depth: number
): string => {
  const { dialect } = scope;
  const args = expr.args.map((arg) => renderExpr(arg, scope, depth + 1));
  const unary = (): string => {
    if (args.length !== 1) {
      throw new PlannerError("EXPRESSION_ARITY", `Function ${expr.fn} takes exactly one argument.`);
    }
    return args[0] as string;
  };
  switch (expr.fn) {
    case "abs":
      return `ABS(${unary()})`;
    case "round":
      return `ROUND(${unary()}, ${expr.digits ?? 0})`;
    case "lower":
      return `LOWER(${unary()})`;
    case "upper":
      return `UPPER(${unary()})`;
    case "length":
      return `LENGTH(${unary()})`;
    case "coalesce":
      if (args.length < 2) {
        throw new PlannerError("EXPRESSION_ARITY", "coalesce takes at least two arguments.");
      }
      return `COALESCE(${args.join(", ")})`;
    case "nullif":
      if (args.length !== 2) {
        throw new PlannerError("EXPRESSION_ARITY", "nullif takes exactly two arguments.");
      }
      return `NULLIF(${args.join(", ")})`;
    case "cast_number":
      return dialect.castNumber(unary());
    case "cast_text":
      return dialect.castText(unary());
    case "cast_date":
      return dialect.castDate(unary());
    case "date_trunc":
      if (!expr.grain) {
        throw new PlannerError("EXPRESSION_GRAIN_REQUIRED", "date_trunc requires a grain.");
      }
      return dialect.dateTrunc(expr.grain, unary());
    case "year":
    case "quarter":
    case "month":
    case "day":
      return dialect.extract(expr.fn, unary());
    case "epoch_seconds":
      return dialect.epochSeconds(unary());
  }
};

const assertDepth = (depth: number): void => {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new PlannerError("EXPRESSION_TOO_DEEP", `Expressions may nest at most ${MAX_EXPRESSION_DEPTH} levels.`);
  }
};
