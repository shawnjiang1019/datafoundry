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
/** What the agent may record: settled, or chosen-but-not-confirmed (never blocks completion). */
export const ANALYSIS_DECISION_RECORD_STATUSES = ["resolved", "undecided"] as const;
const IMPACTS = ["low", "medium", "high"] as const;

/** D-Trail resolver verdict for an assumption no predicate could check (a stronger model's reading). */
export type AnalysisDecisionResolution = {
  status: "resolved" | "undecided";
  quote: string;
  quoteVerified: boolean;
  readings: string[];
  recommended: number;
  confidence: string;
  narrowsQuote: boolean;
  narrowing: string;
  rationale: string;
};

export type AnalysisDecision = {
  id: string;
  kind: (typeof ANALYSIS_DECISION_KINDS)[number];
  question: string;
  options: string[];
  impact: (typeof IMPACTS)[number];
  source: "dtrail" | "agent";
  status: "open" | "resolved" | "undecided";
  resolution?: AnalysisDecisionResolution;
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
    const resolution = readResolution(tree.resolution);
    decisions.push({
      id: `D${decisions.length + 1}`,
      kind: "other",
      question: residual || `Does this hold for this question: ${hypothesis}?`,
      // The resolver's readings are the options to choose between.
      options: resolution ? [...resolution.readings] : [],
      ...(resolution ? { resolution } : {}),
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
  status?: string;
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
  const status = ANALYSIS_DECISION_RECORD_STATUSES.find((value) => value === input.status) ?? "resolved";
  const basisKind = ANALYSIS_DECISION_BASIS_KINDS.find((kind) => kind === input.basis?.kind);
  const basisDetail = text(input.basis?.detail);
  if (!basisKind || !basisDetail) {
    throw new Error("ANALYSIS_DECISION_BASIS_REQUIRED");
  }
  // Previews and question quotes are evidence too; artifact ids are only required to exist when given.
  const evidenceRefs = (input.evidence_refs ?? []).filter((ref) => typeof ref === "string" && ref.length > 0);
  if (basisKind === "evidence" && evidenceRefs.length === 0) {
    throw new Error(`ANALYSIS_DECISION_EVIDENCE_REQUIRED: cite an artifact id ${
      knownEvidenceRefs.length > 0 ? `(${knownEvidenceRefs.slice(-5).join(", ")})` : ""
    } or a previewed table such as preview:<table>`);
  }
  const offered = (input.options ?? []).map(text).filter(Boolean);
  const resolve = (decision: AnalysisDecision): AnalysisDecision => {
    // Options the decision already had (from the resolver or an earlier record) are binding;
    // options offered in this call only widen an open-ended decision.
    const seeded = decision.options.length > 0;
    const options = unique([...decision.options, ...(seeded ? [] : offered)]);
    const matched = matchOption(choice, options);
    if (seeded && matched === undefined) {
      throw new Error(`ANALYSIS_DECISION_CHOICE_NOT_AN_OPTION:${decision.id}: choose one of ${
        options.map((option, index) => `${index + 1}. ${option}`).join(" | ")} (by number or text)`);
    }
    // A reading the resolver could not settle, or that narrows the question's words, is not
    // confirmed by quoting the question: it needs evidence, or it stays undecided.
    if (seeded && status === "resolved" && basisKind === "question_span"
        && (decision.resolution?.status === "undecided" || decision.resolution?.narrowsQuote)) {
      throw new Error(`ANALYSIS_DECISION_NOT_CONFIRMED_BY_QUOTE:${decision.id}: record it with status "undecided" `
        + "(it will not block completion), or resolve it with an evidence basis");
    }
    return {
      ...decision,
      options: matched === undefined ? [...options, choice] : options,
      status,
      choice: matched ?? choice,
      basis: { kind: basisKind, detail: basisDetail },
      evidenceRefs: unique([...decision.evidenceRefs, ...evidenceRefs.filter((ref) => ref)])
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

/** The option a choice refers to: its number (1-based), or its text ignoring case and spacing. */
const matchOption = (choice: string, options: string[]): string | undefined => {
  const number = /^(?:option|reading)?\s*(\d+)$/iu.exec(choice.trim());
  if (number) {
    return options[Number(number[1]) - 1];
  }
  const key = (value: string): string => value.toLowerCase().replaceAll(/\s+/gu, " ").trim();
  return options.find((option) => key(option) === key(choice));
};

const readResolution = (value: unknown): AnalysisDecisionResolution | undefined => {
  if (!isRecord(value) || (value.status !== "resolved" && value.status !== "undecided")) {
    return undefined;  // no resolver ran, or it failed
  }
  const readings = (Array.isArray(value.readings) ? value.readings : [])
    .map((reading) => oneLine(isRecord(reading) ? text(reading.reading) : text(reading)))
    .filter(Boolean);
  if (readings.length === 0) {
    return undefined;
  }
  const recommended = typeof value.recommended === "number" && value.recommended >= 0
    && value.recommended < readings.length ? value.recommended : 0;
  return {
    status: value.status,
    quote: oneLine(text(value.quote)),
    quoteVerified: value.quote_verified === true,
    readings,
    recommended,
    confidence: text(value.confidence) || "low",
    narrowsQuote: value.narrows_quote === true,
    narrowing: oneLine(text(value.narrowing)),
    rationale: oneLine(text(value.rationale))
  };
};

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
