/**
 * Provision the d-trail MCP server resource for each user+workspace.
 *
 * d-trail is an optional, separately-run service (its own Python repo). When the
 * deployment opts in via env (`DTRAIL_BASE_URL`/`DTRAIL_API_URL`/`DTRAIL_TOKEN`),
 * this registers the `dtrail` `mcp-server` config resource with the three read-only
 * dtrail tools, its bearer secret, and `default_enabled` so the resource flows into
 * `enabledMcpServerIds` through the workspace run defaults. Idempotent and gated on
 * env so a deployment without d-trail is unaffected.
 */
import type { MetadataStore } from "@datafoundry/metadata";

export const DTRAIL_MCP_SERVER_ID = "dtrail";
export const DTRAIL_MCP_SERVER_NAME = "d-trail";
export const DTRAIL_DEFAULT_MCP_URL = "http://127.0.0.1:8060/mcp";
export const DTRAIL_DEFAULT_API_URL = "http://127.0.0.1:8061";
export const DTRAIL_DEFAULT_TIMEOUT_MS = 30_000;

export const DTRAIL_TOOL_MANIFEST = [
  { name: "dtrail_plan_verify" },
  { name: "dtrail_trail_read" },
  { name: "dtrail_candidate_list" }
] as const;

export type EnsureBuiltinDtrailServerInput = {
  metadataStore: MetadataStore;
  userId: string;
  workspaceId: string;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
};

export type EnsureBuiltinDtrailServerResult = {
  action: "created" | "repaired" | "skipped" | "not_configured";
  serverUrl?: string;
  apiUrl?: string;
};

const envString = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Ensure the current user has a usable `dtrail` mcp-server resource.
 * Safe to call repeatedly; intended to run from builtin config bootstrap.
 */
export const ensureBuiltinDtrailServer = (
  input: EnsureBuiltinDtrailServerInput
): EnsureBuiltinDtrailServerResult => {
  const env = input.env ?? process.env;
  const apiUrl = envString(env, "DTRAIL_API_URL");
  const baseUrl = envString(env, "DTRAIL_BASE_URL");
  if (!apiUrl && !baseUrl) {
    return { action: "not_configured" };
  }
  const serverUrl = baseUrl ?? DTRAIL_DEFAULT_MCP_URL;
  const resolvedApiUrl = apiUrl ?? DTRAIL_DEFAULT_API_URL;
  const token = envString(env, "DTRAIL_TOKEN");
  const timeoutMs = toNumber(envString(env, "DTRAIL_TIMEOUT_MS"), DTRAIL_DEFAULT_TIMEOUT_MS);

  const common = {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    kind: "mcp-server" as const,
    id: DTRAIL_MCP_SERVER_ID
  };
  const current = input.metadataStore.configResources.find(common);

  let secretRef = current?.secret_ref;
  if (token) {
    if (current?.secret_ref) {
      secretRef = input.metadataStore.secrets.put({
        ...common,
        owner_kind: "mcp-server",
        owner_id: DTRAIL_MCP_SERVER_ID,
        value: { token },
        secret_ref: current.secret_ref
      });
    } else {
      secretRef = input.metadataStore.secrets.put({
        ...common,
        owner_kind: "mcp-server",
        owner_id: DTRAIL_MCP_SERVER_ID,
        value: { token }
      });
    }
  }

  const payload = {
    transport: "streamable-http",
    serverUrl,
    apiUrl: resolvedApiUrl,
    toolManifest: [...DTRAIL_TOOL_MANIFEST],
    ...(token ? { authType: "bearer" as const } : { authType: "none" as const }),
    timeoutMs
  };

  input.metadataStore.configResources.upsert({
    ...common,
    name: current?.name ?? DTRAIL_MCP_SERVER_NAME,
    description: current?.description ?? "d-trail trace and plan-verification service.",
    payload,
    ...(secretRef ? { secret_ref: secretRef } : {}),
    default_enabled: true,
    builtin: true,
    status: current?.status ?? "untested",
    ...(current?.revision !== undefined ? { expected_revision: current.revision } : {})
  });

  return {
    action: current ? "repaired" : "created",
    serverUrl,
    apiUrl: resolvedApiUrl
  };
};
