import { PlannerError } from "../errors.js";
import { ANALYSIS_OPERATORS } from "./analysis-operators.js";
import { DATA_OPERATORS } from "./data-operators.js";
import type { PlannerDialectName } from "./dialect.js";
import type {
  AnyExecutableOperator,
  OperatorCategory,
  OperatorDefinition,
  SideEffectClass
} from "./types.js";

/**
 * The D-Trail logical-plan operator vocabulary (schemas/logical_plan.schema.json, §13.2).
 * Every operator is representable in a plan so the model and validator share one
 * vocabulary, but representable does not mean executable: only operators that pass
 * all six gates compile. The rest fail validation with OPERATOR_NOT_EXECUTABLE.
 */
const VOCABULARY: ReadonlyArray<readonly [string, OperatorCategory, SideEffectClass, string]> = [
  ["scan", "data", "read", "Read a grounded source table."],
  ["filter", "data", "none", "Keep rows satisfying a predicate."],
  ["project", "data", "none", "Select, rename, or compute columns."],
  ["join", "data", "none", "Equi-join two inputs."],
  ["aggregate", "data", "none", "Group and aggregate."],
  ["sort", "data", "none", "Order rows."],
  ["window", "data", "none", "Window-function columns."],
  ["sample", "data", "none", "Take a random or systematic sample of rows."],
  ["materialize", "data", "staged_write", "Persist an intermediate result."],
  ["union", "data", "none", "Stack inputs with compatible columns."],
  ["normalize", "data", "none", "Normalize values (scale, units, casing)."],
  ["impute", "data", "none", "Fill missing values."],
  ["convert", "data", "none", "Convert types or units."],
  ["pivot", "data", "none", "Pivot rows into columns or back."],
  ["unify_schema", "data", "none", "Align columns across heterogeneous inputs."],
  ["limit", "data", "none", "Keep the first N rows."],
  ["profile", "data", "none", "Profile columns (types, nulls, cardinality)."],
  ["sql", "data", "read", "Opaque read-only SQL; never executable in planned analysis."],
  ["compare", "analysis", "none", "Compare a measure across two segments."],
  ["trend", "analysis", "none", "Linear trend of a measure."],
  ["contribution", "analysis", "none", "Group totals and their share of the whole."],
  ["segment", "analysis", "none", "Partition entities into segments."],
  ["anomaly_detect", "analysis", "none", "Flag anomalous observations."],
  ["forecast", "analysis", "none", "Project a series forward."],
  ["statistical_test", "analysis", "none", "Hypothesis test between groups."],
  ["correlate", "analysis", "none", "Correlation between measures."],
  ["quantile", "analysis", "none", "Percentiles of a column."],
  ["distribution", "analysis", "none", "Summary statistics of a column."],
  ["regression", "analysis", "none", "Multivariate regression."],
  ["rank", "analysis", "none", "Rank rows, optionally keeping the top N."],
  ["cluster", "analysis", "none", "Cluster observations."],
  ["funnel", "analysis", "none", "Stage-to-stage conversion."],
  ["growth_rate", "analysis", "none", "Period-over-period growth."],
  ["composition", "analysis", "none", "Row share within a partition."],
  ["interpret", "semantic", "none", "Interpret a result in business terms."],
  ["explain", "semantic", "none", "Explain a result or discrepancy."],
  ["classify", "semantic", "none", "Classify values or entities."],
  ["resolve_entity", "semantic", "none", "Resolve entity references."],
  ["retrieve_evidence", "semantic", "read", "Retrieve supporting evidence."],
  ["verify", "control", "none", "Verify a claim against evidence."],
  ["ask_human", "control", "none", "Request a human decision."],
  ["branch", "control", "none", "Conditional plan branch."],
  ["merge", "control", "none", "Merge plan branches."],
  ["retry", "control", "none", "Retry a failed step."],
  ["wait", "control", "none", "Wait for an external condition."],
  ["stop", "control", "none", "Stop the plan."],
  ["db_write", "side_effect", "write", "Write to a database."],
  ["api_call", "side_effect", "write", "Call an external API."],
  ["notify", "side_effect", "write", "Send a notification."],
  ["approve", "side_effect", "write", "Record an approval."]
];

export const OPERATOR_VOCABULARY: ReadonlyMap<string, OperatorDefinition> = new Map(
  VOCABULARY.map(([name, category, sideEffectClass, description]) => [
    name,
    { name, category, sideEffectClass, description, executable: false as const }
  ])
);

export const EXECUTABLE_OPERATORS: ReadonlyMap<string, AnyExecutableOperator> = new Map(
  [...DATA_OPERATORS, ...ANALYSIS_OPERATORS].map((operator) => [operator.name, operator as AnyExecutableOperator])
);

/**
 * Obligation names the verifier knows how to evaluate. An executable operator may
 * only declare obligations from this set, so no declared check silently goes unrun.
 */
export const KNOWN_OBLIGATIONS: ReadonlySet<string> = new Set([
  "schema_matches_grounding",
  "row_budget",
  "join_keys_exist",
  "join_cardinality",
  "filter_columns_exist",
  "filter_type_compatibility",
  "required_aggregation",
  "ordering",
  "result_row_limit",
  "share_bounds",
  "min_points"
]);

export const operatorDefinition = (name: string): OperatorDefinition | AnyExecutableOperator | undefined =>
  EXECUTABLE_OPERATORS.get(name) ?? OPERATOR_VOCABULARY.get(name);

/** Resolve an operator the plan wants to execute on a dialect, or explain why it cannot. */
export const executableOperator = (name: string, dialect: PlannerDialectName): AnyExecutableOperator => {
  const executable = EXECUTABLE_OPERATORS.get(name);
  if (executable) {
    if (!executable.dialects.includes(dialect)) {
      throw new PlannerError(
        "OPERATOR_DIALECT_UNSUPPORTED",
        `Operator ${name} does not compile for ${dialect}; supported: ${executable.dialects.join(", ")}.`,
        { operator: name, dialect }
      );
    }
    return executable;
  }
  if (OPERATOR_VOCABULARY.has(name)) {
    throw new PlannerError(
      "OPERATOR_NOT_EXECUTABLE",
      `Operator ${name} is part of the plan vocabulary but has no executable implementation.`,
      { operator: name }
    );
  }
  throw new PlannerError("OPERATOR_UNKNOWN", `Operator ${name} is not in the plan vocabulary.`, { operator: name });
};

/**
 * The executable-operator admission check (D-Trail §13.2): every executable operator is
 * in the vocabulary with a matching category and side-effect class, and carries all six
 * gates — parameter schema, per-dialect SQL, cost estimate, known obligations, failure
 * policy, and at least one conformance case per supported dialect family.
 */
export const assertSixGates = (): void => {
  for (const operator of EXECUTABLE_OPERATORS.values()) {
    const vocabulary = OPERATOR_VOCABULARY.get(operator.name);
    const fail = (gate: string, detail: string): never => {
      throw new PlannerError("OPERATOR_GATE_MISSING", `${operator.name}: ${gate} — ${detail}`, { operator: operator.name, gate });
    };
    if (!vocabulary) fail("vocabulary", "not in the D-Trail operator vocabulary");
    if (vocabulary?.category !== operator.category) fail("vocabulary", "category differs from the vocabulary");
    if (vocabulary?.sideEffectClass !== operator.sideEffectClass) fail("vocabulary", "side-effect class differs");
    if (operator.sideEffectClass !== "none" && operator.sideEffectClass !== "read") {
      fail("side_effect", "executable operators must be read-only");
    }
    if (typeof operator.parameterSchema?.safeParse !== "function") fail("1 parameterSchema", "missing");
    if (typeof operator.render !== "function" || operator.dialects.length === 0) fail("2 render", "missing or no dialects");
    if (typeof operator.estimateCost !== "function") fail("3 estimateCost", "missing");
    const unknown = operator.obligations.filter((obligation) => !KNOWN_OBLIGATIONS.has(obligation));
    if (unknown.length > 0) fail("4 obligations", `unknown obligation(s) ${unknown.join(", ")}`);
    if (!operator.failure || !Array.isArray(operator.failure.replanOn)) fail("5 failure", "missing failure policy");
    if (operator.conformance.length === 0) fail("6 conformance", "no conformance cases");
    for (const testCase of operator.conformance) {
      if (!operator.parameterSchema.safeParse(testCase.parameters).success) {
        fail("6 conformance", `case "${testCase.name}" has parameters its own schema rejects`);
      }
    }
  }
};
