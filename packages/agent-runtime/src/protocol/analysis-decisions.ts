/**
 * Analysis decisions: choices an answer depends on that the data does not settle. They are
 * seeded from the D-Trail receipt before the run, raised by the agent mid-run, and resolved
 * with analysis_decision_record. Separate from requirements: a decision can be raised mid-run
 * and settled by the question's wording without SQL, so the requirement lifecycle does not fit.
 */

export const ANALYSIS_DECISION_KINDS = [
  "population", "scope", "binning", "boundary", "missing_values",
  "statistic", "counterfactual", "stated_rule", "other"
] as const;
export const ANALYSIS_DECISION_BASIS_KINDS = ["evidence", "question_span", "convention", "unresolved"] as const;
const IMPACTS = ["low", "medium", "high"] as const;

export type AnalysisDecision = {
  id: string;
  kind: (typeof ANALYSIS_DECISION_KINDS)[number];
  question: string;
  options: string[];
  impact: (typeof IMPACTS)[number];
  source: "dtrail" | "agent";
  status: "open" | "resolved";
  choice?: string;
  basis?: { kind: (typeof ANALYSIS_DECISION_BASIS_KINDS)[number]; detail: string };
  evidenceRefs: string[];
  queryAttemptIds: string[];
  /** D-Trail context: the model's hypothesis, its check level and what the checks showed. */
  hypothesis?: string;
  level?: string;
  confidence?: number;
  checks: string[];
};

/** D-Trail classifier receipt (assumptions + evaluated claim trees), checked before the run. */
export type AssumptionReceipt = {
  task_id?: string;
  assumptions?: unknown[];
  trees?: unknown[];
  summary?: Record<string, unknown>;
  probes?: number;
  [key: string]: unknown;
};

const CHECK_LABELS: Record<string, string> = {
  confirmed: "check passed",
  refuted: "check failed",
  skipped: "check not run"
};

/** Every receipt item whose checks did not confirm it becomes an open decision, D1..Dn in order. */
export const createDecisionsFromReceipt = (receipt: AssumptionReceipt | undefined): AnalysisDecision[] => {
  if (!receipt) {
    return [];
  }
  const assumptions = Array.isArray(receipt.assumptions) ? receipt.assumptions : [];
  const trees = Array.isArray(receipt.trees) ? receipt.trees : [];
  const decisions: AnalysisDecision[] = [];
  // d-trail evaluates one tree per assumption, in order.
  trees.forEach((tree, index) => {
    if (!isRecord(tree) || typeof tree.status !== "string" || tree.status === "confirmed") {
      return;
    }
    const assumption = isRecord(assumptions[index]) ? assumptions[index] : {};
    const atoms = claimAtoms(tree.claim);
    const hypothesis = oneLine(text(assumption.clause)
      || atoms.map((atom) => text(atom.prose)).find(Boolean)
      || "(unnamed assumption)");
    const residual = oneLine(text(tree.residual) || text(assumption.residual));
    const scalar = isRecord(tree.scalar) ? tree.scalar : {};
    decisions.push({
      id: `D${decisions.length + 1}`,
      kind: "other",
      question: residual || `Does this hold for this question: ${hypothesis}?`,
      options: [],
      impact: IMPACTS.find((impact) => impact === text(assumption.impact)) ?? "medium",
      source: "dtrail",
      status: "open",
      evidenceRefs: [],
      queryAttemptIds: [],
      hypothesis,
      level: tree.status,
      ...(typeof scalar.confidence === "number" ? { confidence: scalar.confidence } : {}),
      // text_only atoms were never evaluated, so they are not shown as checks.
      checks: tree.status === "text_only" ? [] : renderChecks(tree, atoms)
    });
  });
  return decisions;
};

export type AnalysisDecisionRecordInput = {
  decision_id?: string;
  kind?: string;
  question?: string;
  options?: string[];
  impact?: string;
  choice?: string;
  basis?: { kind?: string; detail?: string };
  evidence_refs?: string[];
};

/** Resolve a known decision, or raise and resolve a new one when decision_id is omitted. */
export const recordDecision = (
  decisions: AnalysisDecision[],
  input: AnalysisDecisionRecordInput,
  knownEvidenceRefs: string[]
): AnalysisDecision[] => {
  const choice = text(input.choice);
  if (!choice) {
    throw new Error("ANALYSIS_DECISION_CHOICE_REQUIRED");
  }
  const basisKind = ANALYSIS_DECISION_BASIS_KINDS.find((kind) => kind === input.basis?.kind);
  const basisDetail = text(input.basis?.detail);
  if (!basisKind || !basisDetail) {
    throw new Error("ANALYSIS_DECISION_BASIS_REQUIRED");
  }
  const evidenceRefs = (input.evidence_refs ?? []).filter((ref) => typeof ref === "string" && ref.length > 0);
  if (basisKind === "evidence" && evidenceRefs.length === 0) {
    throw new Error("ANALYSIS_DECISION_EVIDENCE_REQUIRED");
  }
  const unknownRef = evidenceRefs.find((ref) => !knownEvidenceRefs.includes(ref));
  if (unknownRef) {
    throw new Error(`ANALYSIS_DECISION_EVIDENCE_UNKNOWN:${unknownRef}`);
  }
  const offered = (input.options ?? []).map(text).filter(Boolean);
  const resolve = (decision: AnalysisDecision): AnalysisDecision => {
    const options = unique([...decision.options, ...offered]);
    if (options.length > 0 && !options.includes(choice)) {
      throw new Error(`ANALYSIS_DECISION_CHOICE_NOT_AN_OPTION:${decision.id}`);
    }
    return {
      ...decision,
      options: options.length > 0 ? options : [choice],
      status: "resolved",
      choice,
      basis: { kind: basisKind, detail: basisDetail },
      evidenceRefs: unique([...decision.evidenceRefs, ...evidenceRefs])
    };
  };
  if (input.decision_id) {
    if (!decisions.some((decision) => decision.id === input.decision_id)) {
      throw new Error(`ANALYSIS_DECISION_NOT_FOUND:${input.decision_id}`);
    }
    return decisions.map((decision) => decision.id === input.decision_id ? resolve(decision) : decision);
  }
  const question = text(input.question);
  if (!question) {
    throw new Error("ANALYSIS_DECISION_QUESTION_REQUIRED");
  }
  return [...decisions, resolve({
    id: `D${decisions.length + 1}`,
    kind: ANALYSIS_DECISION_KINDS.find((kind) => kind === input.kind) ?? "other",
    question,
    options: [],
    impact: IMPACTS.find((impact) => impact === input.impact) ?? "medium",
    source: "agent",
    status: "open",
    evidenceRefs: [],
    queryAttemptIds: [],
    checks: []
  })];
};

/** Link query attempts to the decisions whose choice they apply. */
export const linkDecisionsToAttempt = (
  decisions: AnalysisDecision[],
  decisionIds: string[],
  attemptId: string
): AnalysisDecision[] => {
  const unknownId = decisionIds.find((id) => !decisions.some((decision) => decision.id === id));
  if (unknownId) {
    throw new Error(`ANALYSIS_DECISION_NOT_FOUND:${unknownId}`);
  }
  return decisions.map((decision) => decisionIds.includes(decision.id)
    ? { ...decision, queryAttemptIds: unique([...decision.queryAttemptIds, attemptId]) }
    : decision);
};

/** High-impact decisions still open block completion. */
export const openDecisionReasons = (decisions: AnalysisDecision[]): string[] => decisions
  .filter((decision) => decision.status === "open" && decision.impact === "high")
  .map((decision) => `ANALYSIS_DECISION_OPEN:${decision.id}`);

/** Code-written statements of what each check showed; older receipts fall back to the predicate. */
const renderChecks = (tree: Record<string, unknown>, atoms: Record<string, unknown>[]): string[] => {
  if (Array.isArray(tree.checks)) {
    return tree.checks.filter(isRecord).map((check) => {
      const label = CHECK_LABELS[text(check.status)] ?? "check inconclusive";
      return `${label}: ${oneLine(text(check.statement) || text(check.kind))}`;
    });
  }
  return atoms.map(renderAtom).filter(Boolean).map((atom) => `check ran (result not reported): ${atom}`);
};

const claimAtoms = (claim: unknown): Record<string, unknown>[] => {
  if (!isRecord(claim)) {
    return [];
  }
  if (isRecord(claim.atom)) {
    return [claim.atom];
  }
  return [...claimAtoms(claim.left), ...claimAtoms(claim.right)];
};

/** kind(table.column='value'[, slot=value][ where col='value']) */
const renderAtom = (atom: Record<string, unknown>): string => {
  const expects = isRecord(atom.expects) ? atom.expects : {};
  const table = text(expects.table);
  const column = text(expects.column);
  let subject = table && column ? `${table}.${column}` : column || table;
  if (expects.value !== undefined && expects.value !== null) {
    subject += `=${literal(expects.value)}`;
  }
  const slots = Object.entries(expects)
    .filter(([key, value]) => !["table", "column", "value", "where"].includes(key) && isScalar(value))
    .map(([key, value]) => `${key}=${String(value)}`);
  const where = isRecord(expects.where) && text(expects.where.column)
    ? ` where ${text(expects.where.column)}=${literal(expects.where.value)}`
    : "";
  const args = [subject, ...slots].filter(Boolean).join(", ") + where;
  return args ? `${text(atom.kind) || "check"}(${args})` : "";
};

const literal = (value: unknown): string => (typeof value === "string" ? `'${value}'` : String(value));

const isScalar = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) || typeof value === "number" || typeof value === "boolean";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const oneLine = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();

const unique = (values: string[]): string[] => [...new Set(values)];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
