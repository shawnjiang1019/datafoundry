import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMetadataStore, createVerifiedTestIdentity } from "@datafoundry/metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DTRAIL_MCP_SERVER_ID,
  ensureBuiltinDtrailServer,
  type EnsureBuiltinDtrailServerInput
} from "./builtin-dtrail-server.js";

describe("ensureBuiltinDtrailServer", () => {
  let root: string;
  let input: EnsureBuiltinDtrailServerInput;
  let store: ReturnType<typeof createMetadataStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dtrail-builtin-"));
    store = createMetadataStore({
      database_path: join(root, "metadata.sqlite"),
      secret_master_key: "dtrail-builtin-test-key"
    });
    const identity = createVerifiedTestIdentity(store, { displayName: "Builtin DTrail" });
    input = {
      metadataStore: store,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      env: {
        DTRAIL_BASE_URL: "http://127.0.0.1:8060/mcp",
        DTRAIL_API_URL: "http://127.0.0.1:8061",
        DTRAIL_TOKEN: "dev-token"
      }
    };
  });

  afterEach(() => {
    store.db.close();
  });

  it("skips when d-trail is not configured", () => {
    const result = ensureBuiltinDtrailServer({
      ...input,
      env: {}
    });
    expect(result.action).toBe("not_configured");
  });

  it("creates the dtrail mcp-server resource with the three tools and bearer secret", () => {
    const result = ensureBuiltinDtrailServer(input);
    expect(result.action).toBe("created");
    expect(result.serverUrl).toBe("http://127.0.0.1:8060/mcp");
    expect(result.apiUrl).toBe("http://127.0.0.1:8061");

    const resource = store.configResources.get({
      id: DTRAIL_MCP_SERVER_ID,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      kind: "mcp-server"
    });
    expect(resource.builtin).toBe(true);
    expect(resource.default_enabled).toBe(true);
    expect(resource.name).toBe("d-trail");
    expect(resource.status).toBe("untested");
    expect(resource.payload.transport).toBe("streamable-http");
    expect(resource.payload.apiUrl).toBe("http://127.0.0.1:8061");
    expect(resource.payload.serverUrl).toBe("http://127.0.0.1:8060/mcp");
    expect(resource.payload.authType).toBe("bearer");
    expect(resource.payload.timeoutMs).toBe(30_000);
    expect(resource.payload.toolManifest).toEqual([
      { name: "dtrail_plan_verify" },
      { name: "dtrail_trail_read" },
      { name: "dtrail_candidate_list" }
    ]);

    const secret = store.secrets.get({
      ref: resource.secret_ref as string,
      user_id: input.userId,
      workspace_id: input.workspaceId
    });
    expect(secret).toMatchObject({ token: "dev-token" });
  });

  it("repairs idempotently without duplicating secrets or bumping status", () => {
    ensureBuiltinDtrailServer(input);
    const first = store.configResources.get({
      id: DTRAIL_MCP_SERVER_ID,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      kind: "mcp-server"
    });
    const secretRef = first.secret_ref;

    const second = ensureBuiltinDtrailServer({ ...input, env: { ...input.env, DTRAIL_TIMEOUT_MS: "45000" } });
    expect(second.action).toBe("repaired");

    const updated = store.configResources.get({
      id: DTRAIL_MCP_SERVER_ID,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      kind: "mcp-server"
    });
    expect(updated.secret_ref).toBe(secretRef);
    expect(updated.secret_ref).toBeTruthy();
    expect(updated.payload.timeoutMs).toBe(45_000);
    expect(updated.revision).toBeGreaterThanOrEqual(first.revision);
  });

  it("falls back to defaults when only the REST url is set", () => {
    const result = ensureBuiltinDtrailServer({
      ...input,
      env: { DTRAIL_API_URL: "http://127.0.0.1:8061" }
    });
    expect(result.action).toBe("created");
    expect(result.serverUrl).toBe("http://127.0.0.1:8060/mcp");
  });

  it("records no secret when no token is configured", () => {
    const result = ensureBuiltinDtrailServer({
      ...input,
      env: { DTRAIL_BASE_URL: "http://127.0.0.1:8060/mcp" }
    });
    expect(result.action).toBe("created");
    const resource = store.configResources.get({
      id: DTRAIL_MCP_SERVER_ID,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      kind: "mcp-server"
    });
    expect(resource.payload.authType).toBe("none");
    expect(resource.secret_ref).toBeFalsy();
  });
});
