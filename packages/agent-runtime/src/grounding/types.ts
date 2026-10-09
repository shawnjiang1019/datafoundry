import type { AnswerFrame } from "./answer-frame.js";

/**
 * Evidence-aware grounding: semantic candidates (dictionary text, names) validated against
 * the data before the agent writes SQL. Every relationship keeps the evidence that produced
 * it, so a benchmark trace shows why a join key was accepted or rejected.
 */

export type GroundingColumnRef = { table: string; column: string };

/** A statement about one column, anchored to the physical schema. */
export type SemanticFact = {
  subject: GroundingColumnRef;
  text: string;
  source: { kind: "dictionary_table"; ref: string };
  extractedBy: "deterministic";
};

export type SemanticEvidence = {
  rule: "same_name" | "target_name_in_source_context" | "identifier_names_target_table";
  detail: string;
  quote?: string;
};

export type PhysicalEvidence = {
  fromDistinct: number;
  toDistinct: number;
  toNonNull: number;
  matched: number;
  containment: number;
  form: "text" | "numeric";
  textOnlyContainment: number;
  targetUniqueRate: number;
  typeCompatible: boolean;
  types: string;
};

export type GroundingStatus = "ACCEPT" | "REJECT" | "UNCERTAIN";

export type GroundingCandidate = {
  from: GroundingColumnRef;
  to: GroundingColumnRef;
  relation: "references";
  /** How strongly the question points at the source column (term overlap, 0..1). */
  relevance: number;
  semanticEvidence: SemanticEvidence[];
  physicalEvidence?: PhysicalEvidence;
  status?: GroundingStatus;
  reason?: string;
};

/** Lake-level facts computed once per datasource revision. */
export type LakeSemantics = {
  facts: SemanticFact[];
  dictionaryTables: string[];
  /** Pairs of tables with the same columns and exactly the same rows. */
  duplicateTables: Array<[string, string]>;
};

export type NoteBinding = { joins?: true; frame?: true };

export type EvidenceGroundingContext = {
  facts: SemanticFact[];
  candidates: GroundingCandidate[];
  duplicateTables: Array<[string, string]>;
  /** Readings of the question checked against the data, when the run asks for them. */
  frame?: AnswerFrame;
  /** Note binding: which shown notes become rules the SQL gate enforces (verified joins, frame choices). */
  binding?: NoteBinding;
  warnings: string[];
};

/** Read-only SQL against the run's datasource; rows come back as positional arrays. */
export type GroundingSqlProbe = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;

export type GroundingSchema = {
  dialect?: string;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
};
