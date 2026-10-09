import type { DataGateway } from "@datafoundry/data-gateway";

import type { SqlJoinKey, SqlSemanticConstraint } from "../protocol/analysis-contract.js";
import type { SemanticRequest, SemanticResolution } from "../semantic/types.js";
import type { AgentRunContext } from "../types.js";
import { buildAnswerFrame, renderAnswerFrame, type AnswerFrameProposer } from "./answer-frame.js";
import { applyGroundingGate } from "./grounding-gate.js";
import { readLakeSemantics } from "./lake-semantics.js";
import { validateCandidates } from "./physical-validator.js";
import { linkCandidates } from "./schema-linker.js";
import type {
  EvidenceGroundingContext,
  GroundingCandidate,
  GroundingSchema,
  GroundingSqlProbe,
  LakeSemantics,
  NoteBinding
} from "./types.js";
import { quoteIdent } from "./vocabulary.js";

const SUPPORTED_DIALECTS = new Set(["duckdb"]);
const LAKE_CACHE_LIMIT = 32;
const MAX_RENDERED_RELATIONSHIPS = 12;
const lakeCache = new Map<string, Promise<LakeSemantics>>();

type SemanticResolver = { resolve(request: SemanticRequest): Promise<SemanticResolution> };

export type EvidenceGroundingDeps = {
  inspectSchema(): Promise<GroundingSchema>;
  probe: GroundingSqlProbe;
  /** Lake facts are reused across runs under this key; omit when the revision is unknown. */
  lakeCacheKey?: string;
  /** Check join keys (default). Off when a run asks only for the answer frame. */
  relationships?: boolean;
  /** When set, also list readings of the question and count each one in the data. */
  proposeFrame?: AnswerFrameProposer;
  /** Mark the context so the protocol turns shown joins and/or frame choices into contract rules. */
  binding?: { joins?: boolean; frame?: boolean };
};

/** Semantic candidates → physical validation → gate, for one question. Never throws. */
export const groundEvidence = async (
  question: string,
  deps: EvidenceGroundingDeps
): Promise<EvidenceGroundingContext> => {
  try {
    const schema = await deps.inspectSchema();
    if (!schema.dialect || !SUPPORTED_DIALECTS.has(schema.dialect)) {
      return emptyContext([`EVIDENCE_GROUNDING_UNSUPPORTED_DIALECT:${schema.dialect ?? "unknown"}`]);
    }
    const lake = await cachedLake(deps, schema);
    const candidates = deps.relationships === false ? [] : linkCandidates({ question, schema, lake });
    const validated = await validateCandidates(candidates, schema, deps.probe);
    const gated = applyGroundingGate(validated);
    // The frame writes its readings with the joins grounding verified, so a reading such as
    // "stations the fire records use" is counted through NWS ID instead of a guessed key
    // that matches nothing (wildfire-hard-17: the frame alone counted 0 rows and pointed
    // the agent at every station).
    const verifiedJoins = gated
      .filter((candidate) => candidate.status === "ACCEPT")
      .map((candidate) => `${candidate.from.table}.${candidate.from.column} -> `
        + `${candidate.to.table}.${candidate.to.column}: ${joinCondition(candidate)}`);
    const frame = deps.proposeFrame
      ? await buildAnswerFrame({
          question, schema, facts: lake.facts, verifiedJoins, probe: deps.probe, propose: deps.proposeFrame
        })
      : undefined;
    const binding = noteBinding(deps.binding);
    return {
      facts: lake.facts,
      candidates: gated,
      duplicateTables: lake.duplicateTables,
      ...(frame ? { frame } : {}),
      ...(binding ? { binding } : {}),
      warnings: [
        ...(deps.relationships !== false && candidates.length === 0 ? ["EVIDENCE_GROUNDING_NO_CANDIDATES"] : []),
        ...(frame?.warnings ?? [])
      ]
    };
  } catch (error) {
    return emptyContext([`EVIDENCE_GROUNDING_FAILED:${error instanceof Error ? error.message : String(error)}`]);
  }
};

/**
 * Extends the run's semantic provider instead of replacing it: the existing chain
 * (DataLink → snapshot → physical schema) resolves as before, and the grounding result is
 * attached to its value. Mode and trust are left unchanged, so the protocol does not see a
 * semantic context change; results are cached per question so a later inspect_schema in
 * the same run gets the identical grounding.
 */
export class EvidenceGroundingProvider {
  private readonly perQuestion = new Map<string, Promise<EvidenceGroundingContext>>();

  constructor(
    private readonly inner: SemanticResolver,
    private readonly deps: EvidenceGroundingDeps
  ) {}

  async resolve(request: SemanticRequest): Promise<SemanticResolution> {
    const [base, grounding] = await Promise.all([
      this.inner.resolve(request),
      this.groundOnce(request.query)
    ]);
    const value = isRecord(base.value)
      ? { ...base.value, evidence_grounding: grounding }
      : { ...(base.value === undefined ? {} : { base: base.value }), evidence_grounding: grounding };
    return { ...base, value, capabilities: [...base.capabilities, "evidence-grounding"] };
  }

  private groundOnce(question: string): Promise<EvidenceGroundingContext> {
    let pending = this.perQuestion.get(question);
    if (!pending) {
      pending = groundEvidence(question, this.deps);
      this.perQuestion.set(question, pending);
    }
    return pending;
  }
}

/** Wire the provider to the run's governed data gateway: same read-only guard and audit log as agent SQL. */
export const createEvidenceGroundingProvider = (input: {
  inner: SemanticResolver;
  dataGateway: DataGateway;
  runContext: AgentRunContext;
  datasourceId: string;
  datasourceRevision: string;
  relationships: boolean;
  proposeFrame?: AnswerFrameProposer | undefined;
  binding?: { joins?: boolean; frame?: boolean } | undefined;
  abortSignal?: AbortSignal | undefined;
}): EvidenceGroundingProvider => {
  const scope = {
    user_id: input.runContext.user_id,
    ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
    datasource_id: input.datasourceId,
    ...(input.abortSignal ? { signal: input.abortSignal } : {})
  };
  return new EvidenceGroundingProvider(input.inner, {
    inspectSchema: () => input.dataGateway.inspectSchema(scope),
    probe: async (sql) => {
      const result = await input.dataGateway.runSqlReadonly({ ...scope, sql, limit: 1000 });
      return { columns: result.columns, rows: result.rows };
    },
    relationships: input.relationships,
    ...(input.proposeFrame ? { proposeFrame: input.proposeFrame } : {}),
    ...(input.binding ? { binding: input.binding } : {}),
    ...(input.datasourceRevision !== "unknown"
      ? {
          lakeCacheKey: [
            input.runContext.user_id,
            input.runContext.workspace_id ?? "default",
            input.datasourceId,
            input.datasourceRevision
          ].join(":")
        }
      : {})
  });
};

/**
 * The agent-facing view: relationships the agent would plausibly get wrong, nothing else.
 *
 * Shown: ACCEPTs that column names alone would not reveal (the key was found through
 * documentation, or only matches after numeric normalization), the rejected alternatives
 * in the same target table (the tempting wrong keys), and ambiguous results. Hidden: joins
 * whose names already line up (start_year -> Year, state -> State), which the agent finds by
 * reading the schema. Returns undefined when there is nothing worth showing.
 */
export const renderGroundingForAgent = (
  context: EvidenceGroundingContext | undefined
): Record<string, unknown> | undefined => {
  if (!context) {
    return undefined;
  }
  const accepted = context.candidates.filter((candidate) => candidate.status === "ACCEPT");
  const shownAccepts = accepted.filter(namesAloneWouldMiss);
  const acceptedTargets = new Set(shownAccepts.map(targetTableKey));
  const alternatives = context.candidates.filter((candidate) => candidate.status !== "ACCEPT" && (
    acceptedTargets.has(targetTableKey(candidate)) || candidate.reason?.startsWith("ambiguous")
  ));
  const shown = [...shownAccepts, ...alternatives].slice(0, MAX_RENDERED_RELATIONSHIPS);
  if (shown.length === 0) {
    return undefined;
  }
  const omitted = accepted.length - shownAccepts.length;
  return {
    instruction: [
      "Join keys checked against the full data before any SQL ran.",
      "ACCEPT: names or documentation support it and the values overlap; use the join condition given.",
      "REJECT: tested, the values do not overlap; do not join on it.",
      "UNCERTAIN: not settled; verify before relying on it.",
      "These describe how tables link, not which rows the question needs."
    ].join(" "),
    relationships: shown.map((candidate) => ({
      from: `${candidate.from.table}.${candidate.from.column}`,
      to: `${candidate.to.table}.${candidate.to.column}`,
      status: candidate.status,
      evidence: candidate.reason,
      ...(documentation(candidate) ? { documentation: documentation(candidate) } : {}),
      ...(candidate.status === "ACCEPT" ? { join_condition: joinCondition(candidate) } : {})
    })),
    ...(context.duplicateTables.length > 0
      ? { notes: context.duplicateTables.map(([left, right]) => `${left} and ${right} hold exactly the same rows.`) }
      : {}),
    ...(omitted > 0 ? { omitted: `${omitted} join(s) whose column names already match were verified and not listed.` } : {})
  };
};

/**
 * Note binding: the joins shown to the agent become rules, grouped by the table pair they link.
 *
 * A pair is bound only when renderGroundingForAgent shows one of its ACCEPTs (a key names
 * alone would miss); then any accepted key between the two tables satisfies the join rule, and
 * the rejected alternatives shown beside it are forbidden. UNCERTAIN keys are never bound.
 */
export const verifiedJoinRules = (
  context: EvidenceGroundingContext
): Array<{ tables: [string, string]; rules: SqlSemanticConstraint[] }> => {
  const accepted = context.candidates.filter((candidate) => candidate.status === "ACCEPT");
  const shownAccepts = accepted.filter(namesAloneWouldMiss);
  const shownTargets = new Set(shownAccepts.map(targetTableKey));
  const pairs = new Map(shownAccepts.map((candidate) => {
    const tables = tablePair(candidate);
    return [tables.join("\u0000"), tables] as const;
  }));
  return [...pairs.values()].map((tables) => {
    const linksPair = (candidate: GroundingCandidate) => tablePair(candidate).join("\u0000") === tables.join("\u0000");
    const keys = accepted.filter(linksPair);
    const condition = joinCondition(shownAccepts.find(linksPair) as GroundingCandidate);
    const rejected = context.candidates.filter((candidate) =>
      candidate.status === "REJECT" && linksPair(candidate) && shownTargets.has(targetTableKey(candidate)));
    return {
      tables,
      rules: [
        { kind: "join", tables, anyOf: keys.map(joinKey), condition },
        ...rejected.map((candidate) => ({ kind: "avoid_join" as const, key: joinKey(candidate), instead: condition }))
      ]
    };
  });
};

const tablePair = (candidate: GroundingCandidate): [string, string] =>
  [candidate.from.table, candidate.to.table].sort() as [string, string];

const joinKey = (candidate: GroundingCandidate): SqlJoinKey => ({
  left: { ...candidate.from },
  right: { ...candidate.to },
  ...(matchesOnlyAsNumbers(candidate) ? { compare: "numeric" as const } : {})
});

const matchesOnlyAsNumbers = (candidate: GroundingCandidate): boolean => {
  const evidence = candidate.physicalEvidence;
  return evidence?.form === "numeric" && evidence.textOnlyContainment < evidence.containment;
};

/** Counts for the protocol event, so benchmark traces show what grounding decided. */
export const summarizeGrounding = (context: EvidenceGroundingContext): Record<string, unknown> => ({
  facts: context.facts.length,
  candidates: context.candidates.length,
  accepted: context.candidates.filter((candidate) => candidate.status === "ACCEPT").length,
  rejected: context.candidates.filter((candidate) => candidate.status === "REJECT").length,
  uncertain: context.candidates.filter((candidate) => candidate.status === "UNCERTAIN").length,
  ...(context.frame
    ? {
        frameDecisions: context.frame.decisions.length,
        frameShown: (renderAnswerFrame(context.frame)?.decisions as unknown[] | undefined)?.length ?? 0
      }
    : {}),
  ...(context.warnings.length > 0 ? { warnings: [...context.warnings] } : {})
});

const namesAloneWouldMiss = (candidate: GroundingCandidate): boolean => {
  const evidence = candidate.physicalEvidence;
  const namesLineUp = candidate.semanticEvidence.some((item) =>
    item.rule === "same_name" || item.rule === "target_name_in_source_context");
  return !namesLineUp
    || (evidence?.form === "numeric" && evidence.containment - evidence.textOnlyContainment >= 0.2);
};

const joinCondition = (candidate: GroundingCandidate): string => {
  const from = `${quoteIdent(candidate.from.table)}.${quoteIdent(candidate.from.column)}`;
  const to = `${quoteIdent(candidate.to.table)}.${quoteIdent(candidate.to.column)}`;
  const evidence = candidate.physicalEvidence;
  if (matchesOnlyAsNumbers(candidate)) {
    const asNumber = (ref: string) => `TRY_CAST(TRIM(CAST(${ref} AS VARCHAR)) AS DOUBLE)`;
    return `${asNumber(from)} = ${asNumber(to)}`;
  }
  const [fromType, toType] = (evidence?.types ?? "").split("->");
  return fromType === toType ? `${from} = ${to}` : `TRIM(CAST(${from} AS VARCHAR)) = TRIM(CAST(${to} AS VARCHAR))`;
};

const documentation = (candidate: GroundingCandidate): string | undefined =>
  candidate.semanticEvidence.find((evidence) => evidence.quote)?.quote;

const cachedLake = (deps: EvidenceGroundingDeps, schema: GroundingSchema): Promise<LakeSemantics> => {
  if (!deps.lakeCacheKey) {
    return readLakeSemantics(schema, deps.probe);
  }
  let pending = lakeCache.get(deps.lakeCacheKey);
  if (!pending) {
    pending = readLakeSemantics(schema, deps.probe);
    pending.catch(() => lakeCache.delete(deps.lakeCacheKey as string));
    lakeCache.set(deps.lakeCacheKey, pending);
    if (lakeCache.size > LAKE_CACHE_LIMIT) {
      lakeCache.delete(lakeCache.keys().next().value as string);
    }
  }
  return pending;
};

const noteBinding = (binding: EvidenceGroundingDeps["binding"]): NoteBinding | undefined =>
  binding?.joins || binding?.frame
    ? { ...(binding.joins ? { joins: true as const } : {}), ...(binding.frame ? { frame: true as const } : {}) }
    : undefined;

const emptyContext = (warnings: string[]): EvidenceGroundingContext =>
  ({ facts: [], candidates: [], duplicateTables: [], warnings });

const sourceKey = (candidate: GroundingCandidate): string =>
  `${candidate.from.table}\u0000${candidate.from.column}`;

const targetTableKey = (candidate: GroundingCandidate): string =>
  `${sourceKey(candidate)}\u0000${candidate.to.table}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
