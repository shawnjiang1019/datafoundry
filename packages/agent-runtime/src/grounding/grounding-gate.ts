import type { GroundingCandidate, GroundingStatus } from "./types.js";

export const GATE_THRESHOLDS = {
  accept: 0.8,
  reject: 0.05,
  minDistinct: 10
} as const;

/**
 * Explainable decision table, applied in order; the first rule that fires sets the status
 * and its reason. No weighted score: each outcome names the evidence that decided it.
 *
 * 1. incompatible types (DataLink type rules)          -> REJECT
 * 2. fewer than 10 distinct values on either side      -> UNCERTAIN (overlap is uninformative)
 * 3. containment below 5%                              -> REJECT
 * 4. containment >= 80% and semantic support           -> ACCEPT
 * 5. containment >= 80% without semantic support       -> UNCERTAIN (coincidental overlap is common)
 * 6. anything in between                               -> UNCERTAIN (partial overlap)
 * Then: two or more ACCEPTs from one source column into the same target table contradict
 * each other, so all of them become UNCERTAIN.
 */
export const applyGroundingGate = (candidates: GroundingCandidate[]): GroundingCandidate[] => {
  const decided = candidates.map((candidate) => ({ ...candidate, ...decide(candidate) }));
  const acceptsPerTarget = new Map<string, number>();
  for (const candidate of decided) {
    if (candidate.status === "ACCEPT") {
      const key = targetTableKey(candidate);
      acceptsPerTarget.set(key, (acceptsPerTarget.get(key) ?? 0) + 1);
    }
  }
  return decided.map((candidate) => candidate.status === "ACCEPT" && (acceptsPerTarget.get(targetTableKey(candidate)) ?? 0) > 1
    ? {
        ...candidate,
        status: "UNCERTAIN" as const,
        reason: `ambiguous: ${acceptsPerTarget.get(targetTableKey(candidate))} columns of ${candidate.to.table} `
          + `pass for ${candidate.from.table}.${candidate.from.column}; ${candidate.reason}`
      }
    : candidate);
};

const decide = (candidate: GroundingCandidate): { status: GroundingStatus; reason: string } => {
  const evidence = candidate.physicalEvidence;
  if (!evidence) {
    return { status: "UNCERTAIN", reason: "not validated against the data" };
  }
  if (!evidence.typeCompatible) {
    return { status: "REJECT", reason: `type_incompatible (${evidence.types})` };
  }
  const overlap = `${evidence.matched} of ${evidence.fromDistinct} distinct values match`
    + (evidence.form === "numeric" ? ` as numbers (as text: ${Math.round(evidence.textOnlyContainment * evidence.fromDistinct)})` : "");
  if (Math.min(evidence.fromDistinct, evidence.toDistinct) < GATE_THRESHOLDS.minDistinct) {
    return { status: "UNCERTAIN", reason: `small_domain: ${overlap}; too few values for overlap to mean anything` };
  }
  if (evidence.containment < GATE_THRESHOLDS.reject) {
    return { status: "REJECT", reason: `no_value_overlap: ${overlap}` };
  }
  if (evidence.containment >= GATE_THRESHOLDS.accept) {
    return candidate.semanticEvidence.length > 0
      ? { status: "ACCEPT", reason: `${overlap}; supported by ${candidate.semanticEvidence.map((item) => item.rule).join(", ")}` }
      : { status: "UNCERTAIN", reason: `physical_only: ${overlap}; no semantic support` };
  }
  return { status: "UNCERTAIN", reason: `partial_overlap: ${overlap}` };
};

const targetTableKey = (candidate: GroundingCandidate): string =>
  `${candidate.from.table}\u0000${candidate.from.column}\u0000${candidate.to.table}`;
