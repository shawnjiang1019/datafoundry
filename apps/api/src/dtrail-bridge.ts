/**
 * dtrailBridge — deterministic hand-off of a resolved DataFoundry run to the d-trail
 * service over its REST API (the pilot path; no MCP dependency).
 *
 * d-trail owns compute + verification + the Trail. DataFoundry keeps orchestration
 * (agent loop, tools, budgets, clarification, UI) and hands one resolved task to
 * d-trail, then surfaces d-trail's verification / WAITING_HUMAN back through the
 * existing run + interaction flow.
 *
 * Pinned to d-trail's REST shapes (src/dtrail_service/api.py + src/dtrail/contracts.py):
 *   POST /runs  {text, task?, sql?, sources:[{name,kind,path,table,description,aliases}],
 *                budget?, workspace_id?, grounder?}
 *       -> 200 {task_id, status, workspace}
 *       -> 409 {code:"WAITING_HUMAN", message, stage}
 *       400/422 {code, message}
 *   GET  /runs/{task_id}            -> {task_id, status, verification, metrics, error}
 *   GET  /runs/{task_id}/trail      -> event list
 *   GET  /runs/{task_id}/trail/validate -> {integrity, event_count, head_hash}
 *   GET  /runs/{task_id}/assumptions -> assumption receipt (404 when not classified)
 */
import type { MetadataStore } from "@datafoundry/metadata";
import type { WorkspaceAttachment } from "@datafoundry/agent-runtime";

export const DTRAIL_WAITING_HUMAN = "WAITING_HUMAN";

// ---- request / response shapes (mirrors d-trail RunRequest + outcome) ----------

export type DtrailSourceSpecInput = {
  name: string;
  kind: string;
  path: string;
  table?: string;
  description?: string;
  aliases?: Record<string, string>;
};

export type DtrailRunArgs = {
  text: string;
  sources: DtrailSourceSpecInput[];
  assume?: boolean;
  grounder?: string;
  workspace_id?: string;
  budget?: {
    max_rows?: number;
    max_result_rows?: number;
    max_bytes?: number;
    timeout_seconds?: number;
    max_tool_calls?: number;
  };
};

export type DtrailRunAccepted = {
  kind: "accepted";
  task_id: string;
  status: string;
  workspace: string;
};

export type DtrailWaitingHuman = {
  kind: "waiting_human";
  code: "WAITING_HUMAN";
  message: string;
  stage: string | null;
};

export type DtrailRunRejected = {
  kind: "rejected";
  code: string;
  message: string;
};

export type DtrailSubmitResult = DtrailRunAccepted | DtrailWaitingHuman | DtrailRunRejected;

export type DtrailRunStatus = {
  task_id: string;
  status: string;
  verification: unknown | null;
  metrics: Record<string, unknown>;
  error: { code: string; message: string; stage?: string } | null;
};

export type DtrailTrailValidation = {
  integrity: string;
  event_count: number;
  head_hash: string;
};

export type DtrailAssumptionsTree = {
  claim: string;
  status: string;
  evidence: unknown;
  probe_count?: number;
  scalar?: unknown;
};

export type DtrailAssumptionsSummary = {
  total: number;
  confirmed: number;
  refuted: number;
  assumed: number;
};

export type DtrailAssumptions = {
  task_id: string;
  assumptions: unknown[];
  trees: DtrailAssumptionsTree[];
  probes: number;
  summary: DtrailAssumptionsSummary;
  policy?: string;
  error?: string;
};

export type DtrailBridgeOptions = {
  metadataStore: MetadataStore;
  userId: string;
  workspaceId: string;
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
};

/** Find the registered dtrail `mcp-server` resource for this user+workspace. */
export const findDtrailServer = (options: DtrailBridgeOptions) => {
  const { metadataStore, userId, workspaceId } = options;
  return metadataStore.configResources.find({
    id: "dtrail",
    user_id: userId,
    workspace_id: workspaceId,
    kind: "mcp-server"
  });
};

/** Build the base URL for the d-trail REST API from the mcp-server resource payload. */
export const dtrailApiUrl = (resource: { payload: Record<string, unknown> }): string | undefined => {
  const raw = stringValue(resource.payload.apiUrl) ?? stringValue(resource.payload.url);
  if (!raw) {
    return undefined;
  }
  try {
    const base = new URL(raw);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      return undefined;
    }
    return base.href.endsWith("/") ? base.href : `${base.href}/`;
  } catch {
    return undefined;
  }
};

const bearerToken = (options: DtrailBridgeOptions, resource: { secret_ref?: string; payload: Record<string, unknown> }): string | undefined => {
  if ((stringValue(resource.payload.authType) ?? "none") !== "bearer" || !resource.secret_ref) {
    return undefined;
  }
  const secret = options.metadataStore.secrets.get({
    ref: resource.secret_ref,
    workspace_id: options.workspaceId,
    user_id: options.userId
  });
  return stringValue(recordValue(secret)?.token) ?? stringValue(recordValue(secret)?.apiKey);
};

const dtrailFetch = async (
  options: DtrailBridgeOptions,
  baseUrl: string,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown }
): Promise<Response> => {
  const resource = findDtrailServer(options);
  if (!resource) {
    throw new DtrailBridgeError("DTRAIL_SERVER_NOT_FOUND", "No dtrail mcp-server resource is registered.");
  }
  const headers = new Headers({ Accept: "application/json" });
  const token = bearerToken(options, resource);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const method = init?.method ?? "GET";
  if (init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const timeoutMs = numberValue(resource.payload.timeoutMs) ?? options.timeoutMs ?? 30_000;
  const url = new URL(path.replace(/^\/+/, ""), baseUrl).toString();
  try {
    return await (options.fetchImpl ?? fetch)(url, {
      method,
      headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new DtrailBridgeError(
      "DTRAIL_API_REQUEST_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
};

export class DtrailBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DtrailBridgeError";
  }
}

/** Map d-trail's error/conflict body into a discriminated result. */
export const parseDtrailErrorBody = (status: number, data: unknown, fallback: string): DtrailSubmitResult => {
  const record = recordValue(data);
  const code = stringValue(record?.code) ?? "DTRAIL_API_FAILED";
  const message = stringValue(record?.message) ?? fallback;
  if (status === 409) {
    return { kind: "waiting_human", code: DTRAIL_WAITING_HUMAN, message, stage: stringValue(record?.stage) ?? null };
  }
  return { kind: "rejected", code, message };
};

/** Submit one resolved task to d-trail (deterministic hand-off). */
export const submitDtrailRun = async (
  options: DtrailBridgeOptions,
  args: DtrailRunArgs
): Promise<DtrailSubmitResult> => {
  const resource = findDtrailServer(options);
  const url = resource ? dtrailApiUrl(resource) : undefined;
  if (!url) {
    return { kind: "rejected", code: "DTRAIL_API_URL_REQUIRED", message: "d-trail apiUrl is not configured." };
  }
  const response = await dtrailFetch(options, url, "/runs", { method: "POST", body: args });
  const text = await readResponseText(response);
  const data = parseJson(text);
  if (response.status === 200) {
    return {
      kind: "accepted",
      task_id: stringValue(recordValue(data)?.task_id) ?? "",
      status: stringValue(recordValue(data)?.status) ?? "COMPLETED",
      workspace: stringValue(recordValue(data)?.workspace) ?? ""
    };
  }
  return parseDtrailErrorBody(response.status, data, text);
};

/** Poll GET /runs/{task_id} for the terminal outcome + verification receipt. */
export const fetchDtrailRunStatus = async (
  options: DtrailBridgeOptions,
  taskId: string
): Promise<DtrailRunStatus> => {
  const resource = findDtrailServer(options);
  const url = resource ? dtrailApiUrl(resource) : undefined;
  if (!url) {
    throw new DtrailBridgeError("DTRAIL_API_URL_REQUIRED", "d-trail apiUrl is not configured.");
  }
  const response = await dtrailFetch(options, url, `/runs/${encodeURIComponent(taskId)}`);
  const text = await readResponseText(response);
  const data = parseJson(text);
  if (!response.ok) {
    throw new DtrailBridgeError(
      stringValue(recordValue(data)?.code) ?? `DTRAIL_API_FAILED:${response.status}`,
      stringValue(recordValue(data)?.message) ?? text
    );
  }
  const record = recordValue(data) ?? {};
  return {
    task_id: stringValue(record.task_id) ?? taskId,
    status: stringValue(record.status) ?? "UNKNOWN",
    verification: record.verification ?? null,
    metrics: recordValue(record.metrics) ?? {},
    error: recordValue(record.error) as DtrailRunStatus["error"] ?? null
  };
};

/** Fetch the raw trail (audit readback) for a completed d-trail run. */
export const fetchDtrailTrail = async (
  options: DtrailBridgeOptions,
  taskId: string
): Promise<unknown[]> => {
  const resource = findDtrailServer(options);
  const url = resource ? dtrailApiUrl(resource) : undefined;
  if (!url) {
    throw new DtrailBridgeError("DTRAIL_API_URL_REQUIRED", "d-trail apiUrl is not configured.");
  }
  const response = await dtrailFetch(options, url, `/runs/${encodeURIComponent(taskId)}/trail`);
  const text = await readResponseText(response);
  const data = parseJson(text);
  if (!response.ok) {
    throw new DtrailBridgeError(
      stringValue(recordValue(data)?.code) ?? `DTRAIL_API_FAILED:${response.status}`,
      stringValue(recordValue(data)?.message) ?? text
    );
  }
  return Array.isArray(data) ? data : [];
};

/** Fetch the integrity validation result for a run's trail. */
export const validateDtrailTrail = async (
  options: DtrailBridgeOptions,
  taskId: string
): Promise<DtrailTrailValidation> => {
  const resource = findDtrailServer(options);
  const url = resource ? dtrailApiUrl(resource) : undefined;
  if (!url) {
    throw new DtrailBridgeError("DTRAIL_API_URL_REQUIRED", "d-trail apiUrl is not configured.");
  }
  const response = await dtrailFetch(options, url, `/runs/${encodeURIComponent(taskId)}/trail/validate`);
  const text = await readResponseText(response);
  const data = parseJson(text);
  if (!response.ok) {
    throw new DtrailBridgeError(
      stringValue(recordValue(data)?.code) ?? `DTRAIL_API_FAILED:${response.status}`,
      stringValue(recordValue(data)?.message) ?? text
    );
  }
  const record = recordValue(data) ?? {};
  return {
    integrity: stringValue(record.integrity) ?? "unknown",
    event_count: numberValue(record.event_count) ?? 0,
    head_hash: stringValue(record.head_hash) ?? ""
  };
};

/**
 * Fetch the assumptions receipt for a run (best-effort): the classifier is
 * optional, so a missing receipt (404 or any non-ok) resolves to undefined.
 */
export const fetchDtrailAssumptions = async (
  options: DtrailBridgeOptions,
  taskId: string
): Promise<DtrailAssumptions | undefined> => {
  const resource = findDtrailServer(options);
  const url = resource ? dtrailApiUrl(resource) : undefined;
  if (!url) {
    return undefined;
  }
  const response = await dtrailFetch(options, url, `/runs/${encodeURIComponent(taskId)}/assumptions`);
  const text = await readResponseText(response);
  const data = parseJson(text);
  if (!response.ok) {
    return undefined;
  }
  const record = recordValue(data) ?? {};
  const result: DtrailAssumptions = {
    task_id: stringValue(record.task_id) ?? taskId,
    assumptions: Array.isArray(record.assumptions) ? record.assumptions : [],
    trees: Array.isArray(record.trees) ? record.trees as DtrailAssumptions["trees"] : [],
    probes: numberValue(record.probes) ?? 0,
    summary: summaryValue(record.summary)
  };
  const policy = stringValue(record.policy);
  if (policy) {
    result.policy = policy;
  }
  const errorValue = stringValue(record.error);
  if (errorValue) {
    result.error = errorValue;
  }
  return result;
};

// ---- WAITING_HUMAN round-trip (t4) --------------------------------------------

/**
 * A human question surfaced from d-trail, mapped into DataFoundry's clarification
 * flow. `resume` points back at the args to re-submit once the answer arrives.
 */
export type DtrailClarification = {
  question: string;
  stage: string | null;
  runArgs: DtrailRunArgs;
  taskId?: string;
};

/** Combine the original text with the human's answer and re-submit the same run. */
export const clarifyDtrailRun = (
  clarification: DtrailClarification,
  answer: string
): DtrailRunArgs => {
  const text = [clarification.runArgs.text, answer].filter(Boolean).join("\n");
  return { ...clarification.runArgs, text };
};

// ---- clarification → interaction mapping (t4) ------------------------------------

/** Interrupt payload shaped for DataFoundry's ask_user / interaction flow. */
export type DtrailInteractionPayload = {
  question: string;
  run_id: string;
  tool_call_id: string;
};

/**
 * Map a returned d-trail WAITING_HUMAN into the payload DataFoundry surfaces as a
 * human clarification (ask_user). The caller persists it via the interaction runtime
 * and routes the answer back into {@link clarifyDtrailRun}.
 */
export const dtrailClarificationToInteraction = (
  clarification: Omit<DtrailClarification, "runArgs">,
  runId: string,
  toolCallId: string
): DtrailInteractionPayload => ({
  question: clarification.question,
  run_id: runId,
  tool_call_id: toolCallId
});

// ---- deterministic orchestrator (t2/t4) ------------------------------------------

export type DtrailRunDecision = {
  status: "completed";
  evidence: DtrailRunEvidence;
} | {
  status: "waiting_human";
  clarification: DtrailClarification;
} | {
  status: "failed";
  code: string;
  message: string;
};

/**
 * Deterministic single-task hand-off: submit the run, and if d-trail asks a human
 * question, return immediately so the caller can surface it (round-trip is driven by
 * {@link clarifyDtrailRun} + re-calling this with the clarified text). Records the
 * verification + trail as run evidence on completion.
 */
export const handoffDtrailRun = async (
  options: DtrailBridgeOptions,
  args: DtrailRunArgs
): Promise<DtrailRunDecision> => {
  const submitted = await submitDtrailRun(options, args);
  if (submitted.kind === "rejected") {
    return { status: "failed", code: submitted.code, message: submitted.message };
  }
  if (submitted.kind === "waiting_human") {
    return {
      status: "waiting_human",
      clarification: {
        question: submitted.message,
        stage: submitted.stage,
        runArgs: args
      }
    };
  }
  const status = await fetchDtrailRunStatus(options, submitted.task_id);
  const evidence: DtrailRunEvidence = {
    dtrail_task_id: submitted.task_id,
    dtrail_status: status.status,
    verification: status.verification
  };
  try {
    evidence.trail_validation = await validateDtrailTrail(options, submitted.task_id);
  } catch {
    // Trail audit is best-effort for the pilot; the verification receipt stands alone.
  }
  try {
    const assumptions = await fetchDtrailAssumptions(options, submitted.task_id);
    if (assumptions) {
      evidence.assumptions = assumptions;
    }
  } catch {
    // Assumption classification is optional; the outcome still stands without the receipt.
  }
  return { status: "completed", evidence };
};

// ---- evidence recording shape (t2) ---------------------------------------------

/** Evidence the bridge writes back against the DataFoundry run after a hand-off. */
export type DtrailRunEvidence = {
  dtrail_task_id: string;
  dtrail_status: string;
  verification: unknown | null;
  trail_validation?: DtrailTrailValidation;
  assumptions?: DtrailAssumptions;
  clarifying?: DtrailClarification;
};

// ---- mapping helpers for file-attachment sources (t3) --------------------------

const MIME_KIND: Array<{ mime: string; kind: string }> = [
  { mime: "text/csv", kind: "csv" },
  { mime: "application/json", kind: "json" },
  { mime: "application/jsonl", kind: "jsonl" },
  { mime: "application/x-ndjson", kind: "jsonl" }
];

const EXT_KIND: Array<[string, string]> = [
  [".csv", "csv"],
  [".json", "json"],
  [".jsonl", "jsonl"],
  [".ndjson", "jsonl"]
];

/** Infer a d-trail source kind from a materialized attachment. Default: csv. */
export const dtrailSourceKind = (mimeType: string | undefined, filename: string): string => {
  const byMime = MIME_KIND.find((entry) => entry.mime === mimeType);
  if (byMime) {
    return byMime.kind;
  }
  const lower = filename.toLowerCase();
  const byExt = EXT_KIND.find(([ext]) => lower.endsWith(ext));
  return byExt?.[1] ?? "csv";
};

/** Map materialized workspace attachments into d-trail SourceSpec inputs. */
export const attachmentsToDtrailSources = (
  attachments: WorkspaceAttachment[]
): DtrailSourceSpecInput[] =>
  attachments.map((attachment) => ({
    name: deriveSourceName(attachment.filename),
    kind: dtrailSourceKind(attachment.mime_type, attachment.filename),
    path: attachment.source_path,
    description: attachment.filename
  }));

const deriveSourceName = (filename: string): string => {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return base || "dataset";
};

// ---- small helpers ---------------------------------------------------------------

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const summaryValue = (value: unknown): DtrailAssumptionsSummary => {
  const record = recordValue(value) ?? {};
  return {
    total: numberValue(record.total) ?? 0,
    confirmed: numberValue(record.confirmed) ?? 0,
    refuted: numberValue(record.refuted) ?? 0,
    assumed: numberValue(record.assumed) ?? 0
  };
};

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseJson = (text: string): unknown => {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const readResponseText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};
