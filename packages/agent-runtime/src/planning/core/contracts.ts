import { z } from "zod";

/**
 * Versioned, JSON-safe planning contracts, ported from D-Trail's contracts.py
 * (GroundedTask → LogicalPlan → PhysicalPlan → ExecutableUnit). Each layer links to the
 * one above: physical nodes by `logicalRef`, units by physical `nodeId`, executions by
 * unit `contentHash`, which is what path-consistency verification walks.
 */
export const PLAN_SCHEMA_VERSION = "1.0";

const id = z.string().min(1).max(200);
const jsonRecord = z.record(z.string(), z.unknown());

export const sideEffectClassSchema = z.enum(["none", "read", "staged_write", "write"]);

// ---- grounded task ----------------------------------------------------------

export const groundedColumnSchema = z.object({ name: z.string().min(1), type: z.string().default("unknown") });

export const groundedTableSchema = z.object({
  name: z.string().min(1),
  columns: z.array(groundedColumnSchema),
  rowCount: z.number().int().nonnegative().optional()
});

export const groundedAssertionSchema = z.object({
  id,
  kind: z.string().min(1),
  required: z.boolean(),
  description: z.string().default(""),
  sourceTables: z.array(z.string()).default([]),
  dimensions: z.array(z.string()).default([]),
  /** Structured SQL constraints from the grounded analysis contract, checked against the plan. */
  sqlConstraints: z.array(z.unknown()).default([])
});

export const groundedRequirementSchema = z.object({
  id,
  description: z.string(),
  required: z.boolean(),
  assertions: z.array(groundedAssertionSchema).default([])
});

/**
 * Everything the planner may rely on, built deterministically from the protocol's
 * domain state (never by the model). `eligibleBindings` is the closed world: a plan
 * may scan only these tables and reference only these columns.
 */
export const groundedAnalysisTaskSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION).default(PLAN_SCHEMA_VERSION),
  taskId: id,
  intentText: z.string(),
  datasource: z.object({
    id,
    dialect: z.string().min(1),
    revision: z.string().min(1),
    schemaId: z.string().optional()
  }),
  tables: z.array(groundedTableSchema),
  schemaFingerprint: z.string().min(1),
  semantic: z.object({
    mode: z.string().optional(),
    trust: z.string().optional(),
    warnings: z.array(z.string()).default([])
  }).default({ warnings: [] }),
  requirements: z.array(groundedRequirementSchema),
  eligibleBindings: z.object({
    tables: z.array(z.string()),
    columns: z.record(z.string(), z.array(z.string()))
  })
});

// ---- skills -----------------------------------------------------------------

export const analysisSkillSchema = z.object({
  skillId: id,
  version: z.string().default("1"),
  description: z.string(),
  taskFamilies: z.array(z.string()).min(1),
  allowedOperators: z.array(z.string()).min(1),
  primaryOperators: z.array(z.string()).min(1),
  verificationObligations: z.array(z.string()).default([])
});

// ---- logical plan -----------------------------------------------------------

export const planCoverageSchema = z.object({
  requirementIds: z.array(id).default([]),
  assertionIds: z.array(id).default([])
});

export const analysisLogicalNodeSchema = z.object({
  nodeId: id,
  operator: z.string().min(1),
  inputs: z.array(id).default([]),
  parameters: jsonRecord.default({}),
  verificationObligations: z.array(z.string()).default([]),
  /** Acceptance shape for non-relational outputs; relational nodes leave it empty. */
  outputContract: jsonRecord.default({}),
  sideEffectClass: sideEffectClassSchema.default("none"),
  /** Which requirements/assertions this node's output is evidence for. */
  satisfies: planCoverageSchema.default({ requirementIds: [], assertionIds: [] })
});

export const analysisLogicalPlanSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION).default(PLAN_SCHEMA_VERSION),
  planId: id,
  taskId: id,
  skillId: id,
  nodes: z.array(analysisLogicalNodeSchema).min(1),
  outputNodeIds: z.array(id).min(1),
  source: z.enum(["model", "deterministic", "agent_revision"])
});

// ---- physical plan ----------------------------------------------------------

export const analysisPhysicalNodeSchema = z.object({
  nodeId: id,
  /** The logical node this implements; need not equal nodeId. */
  logicalRef: id,
  /** "sql:<dialect>" in v1. */
  executor: z.string().regex(/^sql:(duckdb|sqlite|postgres|mysql)$/u),
  operator: z.string().min(1),
  inputs: z.array(id),
  parameters: jsonRecord,
  estimatedCost: z.number().nonnegative(),
  estimatedRows: z.number().nonnegative().optional()
});

export const planEstimateSchema = z.object({
  cost: z.number().nonnegative(),
  queries: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  risk: z.number().min(0).max(1),
  value: z.number().min(0).max(1)
});

export const analysisPhysicalPlanSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION).default(PLAN_SCHEMA_VERSION),
  planId: id,
  logicalPlanId: id,
  taskId: id,
  nodes: z.array(analysisPhysicalNodeSchema).min(1),
  /** e.g. "greedy-v1", "beam-v1(k=4)". */
  optimizer: z.string().min(1),
  estimate: planEstimateSchema
});

// ---- executable units -------------------------------------------------------

export const executableUnitPayloadSchema = z.object({
  sql: z.string().min(1),
  dialect: z.enum(["duckdb", "sqlite", "postgres", "mysql"]),
  limit: z.number().int().min(1),
  datasourceId: id,
  datasourceRevision: z.string().min(1),
  schemaFingerprint: z.string().min(1),
  probeSql: z.string().min(1).optional()
});

/**
 * One governed SQL execution: the CTE chain up to `nodeId`. `contentHash` is the
 * SHA-256 of the canonical JSON of {executor, nodeId, inputs, payload}; it is
 * re-checked before execution and is the key for reusing results across replans.
 */
export const executableUnitSchema = z.object({
  unitId: id,
  nodeId: id,
  executor: z.string().min(1),
  role: z.enum(["intermediate", "output"]),
  payload: executableUnitPayloadSchema,
  inputs: z.array(id),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  compiledBy: z.string().default("cte-compiler-v1"),
  satisfies: planCoverageSchema.optional()
});

// ---- execution, decisions, replanning ---------------------------------------

export const planFindingSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  nodeId: id.optional(),
  details: jsonRecord.optional()
});

export const planNodeExecutionSchema = z.object({
  executionId: id,
  planId: id,
  unitId: id,
  nodeId: id,
  contentHash: z.string(),
  status: z.enum(["succeeded", "failed", "skipped", "reused"]),
  rowCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  columns: z.array(z.string()).optional(),
  /** Capped sample for the model; full rows live in the artifact. */
  sampleRows: z.array(z.array(z.unknown())).optional(),
  artifactId: z.string().optional(),
  auditLogId: z.string().optional(),
  probe: z.object({ rowCount: z.number().optional(), distinctKeys: z.number().optional() }).optional(),
  reusedFromExecutionId: id.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  findings: z.array(planFindingSchema).default([]),
  durationMs: z.number().nonnegative().optional()
});

export const plannerDecisionRecordSchema = z.object({
  decisionId: id,
  logicalPlanId: id,
  selectedPhysicalPlanId: id.optional(),
  search: z.string().min(1),
  candidates: z.array(z.object({
    planId: id,
    transforms: z.array(z.string()),
    estimate: planEstimateSchema,
    status: z.enum(["selected", "pruned_dominated", "pruned_infeasible", "considered"])
  })),
  constraints: jsonRecord,
  timingsMs: z.record(z.string(), z.number().nonnegative())
});

export const replanTriggerSchema = z.object({
  kind: z.enum([
    "node_execution_error",
    "verification_failure",
    "cardinality_deviation",
    "query_budget",
    "agent_feedback",
    "schema_changed"
  ]),
  nodeId: id.optional(),
  code: z.string().optional(),
  message: z.string()
});

export const planLineageEntrySchema = z.object({
  planId: id,
  parentPlanId: id.optional(),
  revision: z.number().int().min(1),
  trigger: replanTriggerSchema.optional(),
  source: z.enum(["model", "deterministic", "agent_revision"])
});

export type GroundedColumn = z.infer<typeof groundedColumnSchema>;
export type GroundedTable = z.infer<typeof groundedTableSchema>;
export type GroundedAssertion = z.infer<typeof groundedAssertionSchema>;
export type GroundedRequirement = z.infer<typeof groundedRequirementSchema>;
export type GroundedAnalysisTask = z.infer<typeof groundedAnalysisTaskSchema>;
export type AnalysisSkill = z.infer<typeof analysisSkillSchema>;
export type PlanCoverage = z.infer<typeof planCoverageSchema>;
export type AnalysisLogicalNode = z.infer<typeof analysisLogicalNodeSchema>;
export type AnalysisLogicalPlan = z.infer<typeof analysisLogicalPlanSchema>;
export type AnalysisPhysicalNode = z.infer<typeof analysisPhysicalNodeSchema>;
export type AnalysisPhysicalPlan = z.infer<typeof analysisPhysicalPlanSchema>;
export type PlanEstimate = z.infer<typeof planEstimateSchema>;
export type ExecutableUnitPayload = z.infer<typeof executableUnitPayloadSchema>;
export type ExecutableUnit = z.infer<typeof executableUnitSchema>;
export type PlanFinding = z.infer<typeof planFindingSchema>;
export type PlanNodeExecution = z.infer<typeof planNodeExecutionSchema>;
export type PlannerDecisionRecord = z.infer<typeof plannerDecisionRecordSchema>;
export type ReplanTrigger = z.infer<typeof replanTriggerSchema>;
export type PlanLineageEntry = z.infer<typeof planLineageEntrySchema>;
