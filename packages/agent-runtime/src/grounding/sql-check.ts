import type { AnalysisAssertion, AnalysisValidationFinding } from "../protocol/analysis-contract.js";
import { validateSqlSemantics } from "../protocol/sql-semantic-validator.js";
import { verifiedJoinRules } from "./evidence-grounding-provider.js";
import type { EvidenceGroundingContext } from "./types.js";

/**
 * The SQL gate's verified-join rules, checked outside a DataFoundry run: one rule set per table
 * pair the notes verified, the same rules bindVerifiedJoins gives the contract's assertions.
 * Used by the notes MCP service, where there is no contract to attach them to.
 *
 * A rule only applies when the query combines both tables of its pair, so a query that never
 * joins them is not checked, and SQL the parser cannot read gives one warning, never a block.
 */
export const checkSqlAgainstNotes = (
  sql: string,
  grounding: EvidenceGroundingContext | undefined,
  dialect = "duckdb"
): AnalysisValidationFinding[] => {
  if (!grounding) return [];
  const assertions = verifiedJoinRules(grounding).map(({ tables, rules }, index): AnalysisAssertion => ({
    id: `notes-join-${index + 1}`,
    requirementId: "notes",
    kind: "metric",
    description: `Verified join between ${tables[0]} and ${tables[1]}`,
    required: true,
    sourceTables: [],
    dimensions: [],
    sqlConstraints: rules,
    resultChecks: [],
    claimValues: []
  }));
  return assertions.length === 0 ? [] : validateSqlSemantics(sql, dialect, assertions);
};

/** A join the data proved wrong: the one finding the notes service blocks a query on. */
export const isRejectedJoin = (finding: AnalysisValidationFinding): boolean =>
  finding.code.startsWith("SQL_SEMANTIC_JOIN_REJECTED");
