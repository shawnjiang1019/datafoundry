import { ToolExecutionError } from "../errors/tool-execution-error.js";
import type { AnalysisValidationFinding } from "./analysis-contract.js";
import type { ProtocolActionHooks, ProtocolHookContext } from "./protocol-extensions.js";
import { verifyAnalysisResult } from "./result-verifier.js";
import type { DataAnalysisState } from "./protocols/data-analysis.js";

/**
 * Action hooks of the data-analysis protocol: the preparatory plan/validate pair
 * before governed SQL, the automatic semantic → contract → result-validation chain,
 * the query-contract and report-commit guards, and the grounded schema projection.
 * Protocols that extend DataAnalysisState compose these instead of re-implementing them.
 */
export const createDataAnalysisHooks = (context: ProtocolHookContext): ProtocolActionHooks => ({
  automaticActions: (actionInput) => dataAnalysisAutomaticActions(actionInput, context),
  preparatoryActions: (actionInput) => dataAnalysisPreparatoryActions(actionInput),
  afterPreparatoryActions: ({ actionName, domain, input: actionInput, phase }) => {
    const dataAnalysisState = domain as DataAnalysisState;
    if (actionName === "run_sql_readonly") {
      assertCurrentQueryContract(dataAnalysisState);
    }
    if (isReportFileAction(actionName, actionInput, phase)) {
      assertRequirementsCommittedBeforeReport(dataAnalysisState);
    }
  },
  projectFinalObservation: ({ actionName, domain, observation }) => actionName === "inspect_schema"
    ? projectGroundedSchemaObservation(observation, domain as DataAnalysisState)
    : observation
});

export const semanticResolutionEventResult = (value: unknown): Record<string, unknown> => {
  const provider = directString(value, "provider");
  const mode = directString(value, "mode");
  const trust = directString(value, "trust");
  const datasourceRevision = directString(value, "datasourceRevision");
  const fallbackReason = directString(value, "fallbackReason");
  return {
    ...(provider ? { provider } : {}),
    ...(mode ? { mode } : {}),
    ...(trust ? { trust } : {}),
    ...(datasourceRevision ? { datasourceRevision } : {}),
    ...(fallbackReason ? { fallbackReason } : {})
  };
};

export const analysisContractGroundingEventResult = (value: unknown): Record<string, unknown> => {
  const requirements = recordArray(value, "requirements").filter((requirement) =>
    directString(requirement, "source") === "user");
  const structuredRequirementIds: string[] = [];
  const manualRequirementIds: string[] = [];
  for (const requirement of requirements) {
    const requirementId = directString(requirement, "id");
    if (!requirementId) {
      continue;
    }
    const hasStructuredAssertion = recordArray(requirement, "assertions").some((assertion) =>
      directString(assertion, "kind") !== "manual");
    (hasStructuredAssertion ? structuredRequirementIds : manualRequirementIds).push(requirementId);
  }
  return {
    ...(directString(value, "datasourceRevision")
      ? { datasourceRevision: directString(value, "datasourceRevision") }
      : {}),
    structuredRequirementIds,
    manualRequirementIds,
    findings: recordArray(value, "findings").map((finding) => ({
      ...(directString(finding, "requirementId")
        ? { requirementId: directString(finding, "requirementId") }
        : {}),
      ...(directString(finding, "code") ? { code: directString(finding, "code") } : {}),
      ...(directString(finding, "message") ? { message: directString(finding, "message") } : {})
    }))
  };
};

export const projectGroundedSchemaObservation = (
  observation: unknown,
  state: DataAnalysisState,
  instruction = [
    "Use the exact requirement_id, assertion_id, aggregate aliases, and expected columns below in",
    "run_sql_readonly. Do not invent or rename contract fields."
  ].join(" ")
): Record<string, unknown> => {
  const schemaObservation = typeof observation === "object" && observation !== null && !Array.isArray(observation)
    ? observation as Record<string, unknown>
    : { schema: observation };
  return {
    ...schemaObservation,
    analysis_contract: {
      instruction,
      requirements: state.requirements
        .filter((requirement) => requirement.source === "user")
        .map((requirement) => ({
          requirement_id: requirement.id,
          description: requirement.description,
          acceptance_criteria: [...requirement.acceptanceCriteria],
          assertions: requirement.assertions.map((assertion) => ({
            assertion_id: assertion.id,
            kind: assertion.kind,
            description: assertion.description,
            source_tables: [...assertion.sourceTables],
            dimensions: [...assertion.dimensions],
            sql_constraints: structuredClone(assertion.sqlConstraints),
            result_checks: structuredClone(assertion.resultChecks),
            claim_values: structuredClone(assertion.claimValues)
          }))
        }))
    }
  };
};

const dataAnalysisPreparatoryActions = (input: {
  actionName: string;
  input: unknown;
}): Array<{ actionName: string; input: unknown }> => input.actionName === "run_sql_readonly"
  ? [
      { actionName: "data.query.plan", input: input.input },
      { actionName: "data.query.validate", input: input.input }
    ]
  : [];

const assertCurrentQueryContract = (state: DataAnalysisState): void => {
  if (state.currentQueryValidated) {
    return;
  }
  const attempt = state.queryAttempts.find((candidate) => candidate.id === state.currentQueryAttemptId)
    ?? state.queryAttempts.at(-1);
  const findings = attempt?.validationFindings ?? [];
  const findingCodes = findings.map((finding) => finding.code).join(", ") || "QUERY_CONTRACT_INVALID";
  const exactCorrections = findings.map((finding) => finding.message).join(" ")
    || "The query does not satisfy its selected analysis assertions.";
  throw new ToolExecutionError({
    ok: false,
    isError: true,
    error: {
      code: "QUERY_CONTRACT_VALIDATION_FAILED",
      category: "validation",
      message: `SQL was not executed because contract validation failed: ${findingCodes}. ${exactCorrections}`,
      executionStatus: "not_started",
      retryable: false,
      details: {
        queryAttemptId: attempt?.id ?? "unknown",
        findings: structuredClone(findings),
        allowedActions: ["data.query.plan", "data.query.validate", "inspect_schema", "preview_table"]
      }
    },
    recovery: {
      strategy: "refresh_and_replan",
      instruction: `Apply these exact SQL corrections, then submit a new query plan: ${exactCorrections}`,
      avoid: ["Do not repeat the same invalid SQL without addressing the listed findings."]
    }
  });
};

export const assertRequirementsCommittedBeforeReport = (state: DataAnalysisState): void => {
  const incomplete = state.requirements.filter((requirement) =>
    requirement.source === "user" && requirement.required && requirement.status !== "reported");
  if (incomplete.length === 0) {
    return;
  }
  throw new ToolExecutionError({
    ok: false,
    isError: true,
    error: {
      code: "ANALYSIS_REQUIREMENTS_COMMIT_REQUIRED",
      category: "validation",
      message: "The final analysis output cannot be written until every required analysis claim is committed.",
      executionStatus: "not_started",
      retryable: false,
      details: {
        requirementIds: incomplete.map((requirement) => requirement.id),
        requirements: incomplete.map((requirement) => ({
          id: requirement.id,
          status: requirement.status,
          recovery: requirement.status === "evidenced"
            ? "Commit this claim with analysis_requirements_commit."
            : "Finish validated SQL evidence before committing this claim."
        }))
      }
    },
    recovery: {
      strategy: "refresh_and_replan",
      instruction: "Commit evidenced claims, finish any still-pending analyses, then write the final output.",
      avoid: ["Do not retry the final report write while required claims remain unreported."]
    }
  });
};

export const isReportFileAction = (actionName: string, input: unknown, phase: string): boolean => {
  if (actionName !== "write_file" && actionName !== "edit_file") {
    return false;
  }
  if (phase === "synthesis") {
    return true;
  }
  const filePath = directString(input, "path") ?? directString(input, "filename") ?? "";
  return /\.(?:html?|markdown|md|rst|txt)$/iu.test(filePath.trim().replace(/\/+$/u, ""));
};

/** inspect_schema → semantic.context.resolve → analysis.contract.ground, the grounding
 * chain every analysis protocol shares. Returns [] for any other action. */
export const groundingAutomaticActions = (input: {
  actionName: string;
  domain: unknown;
  input: unknown;
  rawResult: unknown;
}, context: ProtocolHookContext): Array<{ actionName: string; input: unknown }> => {
  if (input.actionName === "inspect_schema" && context.semanticProvider && context.semanticRequest) {
    return [{
      actionName: "semantic.context.resolve",
      input: {
        ...context.semanticRequest,
        // The semantic service needs the actual task description; a weak follow-up
        // like "再次尝试" would only return noise, so inherit the session intent text.
        query: context.intentText,
        physicalSchema: input.rawResult
      }
    }];
  }
  if (input.actionName === "semantic.context.resolve") {
    const state = input.domain as DataAnalysisState;
    const userRequirements = state.requirements.filter((requirement) => requirement.source === "user");
    if (userRequirements.length === 0 || state.contractGrounded) {
      return [];
    }
    return [{
      actionName: "analysis.contract.ground",
      input: {
        requirements: state.requirements,
        physicalSchema: recordValue(input.input, "physicalSchema"),
        semanticResolution: input.rawResult,
        datasourceRevision: directString(input.input, "datasourceRevision") ?? "unknown"
      }
    }];
  }
  return [];
};

/** After a governed SQL result: validate it against the current attempt's assertions
 * and bind evidence when it passes. */
export const resultEvidenceActions = (
  rawResult: unknown,
  actionInput: unknown,
  state: DataAnalysisState,
  extraFindings: AnalysisValidationFinding[] = []
): Array<{ actionName: string; input: unknown }> => {
  const artifactId = nestedString(rawResult, "result", "artifact_id")
    ?? directString(rawResult, "artifact_id");
  const auditLogId = nestedString(rawResult, "result", "audit_log_id")
    ?? directString(rawResult, "audit_log_id");
  const resultFields = nestedStringArray(rawResult, "result", "columns");
  const validation = validateAnalysisResult(rawResult, actionInput, state, extraFindings);
  return [
    { actionName: "analysis.result.validate", input: validation },
    ...(artifactId && validation.valid
      ? [{
          actionName: "analysis.evidence.bind",
          input: {
            artifact_id: artifactId,
            ...(auditLogId ? { audit_log_id: auditLogId } : {}),
            evidence_refs: [artifactId],
            result_fields: resultFields
          }
        }]
      : [])
  ];
};

const dataAnalysisAutomaticActions = (input: {
  actionName: string;
  domain: unknown;
  input: unknown;
  rawResult: unknown;
}, context: ProtocolHookContext): Array<{ actionName: string; input: unknown }> => {
  if (input.actionName === "inspect_schema" || input.actionName === "semantic.context.resolve") {
    return groundingAutomaticActions(input, context);
  }
  if (input.actionName !== "run_sql_readonly") {
    return [];
  }
  return resultEvidenceActions(input.rawResult, input.input, input.domain as DataAnalysisState);
};

export const validateAnalysisResult = (
  value: unknown,
  actionInput: unknown,
  state: DataAnalysisState,
  extraFindings: AnalysisValidationFinding[] = []
): {
  valid: boolean;
  reasons: string[];
  validation_findings: AnalysisValidationFinding[];
  verified_values: unknown[];
} => {
  const result = recordValue(value, "result");
  const columns = recordValue(result, "columns");
  const rows = recordValue(result, "rows");
  const rowCount = recordValue(result, "row_count");
  const auditLogId = directString(result, "audit_log_id");
  const expectedColumns = recordStringArray(actionInput, "expected_columns");
  const missingColumns = expectedColumns.filter((column) => !Array.isArray(columns) || !columns.includes(column));
  const reasons = [
    ...(Array.isArray(columns) ? [] : ["RESULT_COLUMNS_REQUIRED"]),
    ...(Array.isArray(rows) ? [] : ["RESULT_ROWS_REQUIRED"]),
    ...(typeof rowCount === "number" && rowCount >= 0 ? [] : ["RESULT_ROW_COUNT_REQUIRED"]),
    ...(auditLogId ? [] : ["RESULT_AUDIT_LOG_REQUIRED"]),
    ...missingColumns.map((column) => `RESULT_EXPECTED_COLUMN_MISSING:${column}`)
  ];
  const structuralFindings: AnalysisValidationFinding[] = reasons.map((reason) => ({
    code: reason,
    message: `Result contract failed: ${reason}.`,
    severity: "error"
  }));
  const attempt = state.queryAttempts?.find((candidate) => candidate.id === state.currentQueryAttemptId);
  const verification = Array.isArray(columns) && Array.isArray(rows) && typeof rowCount === "number"
    ? verifyAnalysisResult({
        columns: columns.filter((column): column is string => typeof column === "string"),
        rows,
        rowCount
      }, attempt?.assertions ?? [])
    : { valid: false, findings: [], verifiedValues: [] };
  const validationFindings = [...structuralFindings, ...verification.findings, ...extraFindings];
  return {
    valid: validationFindings.every((finding) => finding.severity !== "error"),
    reasons: validationFindings.map((finding) => finding.code),
    validation_findings: validationFindings,
    verified_values: verification.verifiedValues
  };
};

const nestedString = (value: unknown, parent: string, key: string): string | undefined =>
  directString(recordValue(value, parent), key);

const nestedStringArray = (value: unknown, parent: string, key: string): string[] =>
  recordStringArray(recordValue(value, parent), key);

const directString = (value: unknown, key: string): string | undefined => {
  const field = recordValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const recordStringArray = (value: unknown, key: string): string[] => {
  const field = recordValue(value, key);
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
};

const recordArray = (value: unknown, key: string): unknown[] => {
  const field = recordValue(value, key);
  return Array.isArray(field) ? field : [];
};

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
