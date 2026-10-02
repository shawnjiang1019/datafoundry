import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMetadataStore, createVerifiedTestIdentity, type ConfigResourceRecord } from "@datafoundry/metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachmentsToDtrailSources,
  clarifyDtrailRun,
  DTRAIL_WAITING_HUMAN,
  dtrailClarificationToInteraction,
  dtrailSourceKind,
  DtrailBridgeError,
  fetchDtrailAssumptions,
  fetchDtrailRunStatus,
  findDtrailServer,
  handoffDtrailRun,
  submitDtrailRun,
  validateDtrailTrail
} from "./dtrail-bridge.js";

const runResponse = (status: number, body: unknown): Response => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  headers: { get: () => "application/json" }
} as unknown as Response);

describe("dtrailBridge", () => {
  let root: string;
  let metadataStore: ReturnType<typeof createMetadataStore>;
  let userId: string;
  let workspaceId: string;
  const baseUrl = "http://127.0.0.1:8061";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dtrail-bridge-"));
    metadataStore = createMetadataStore({
      database_path: join(root, "metadata.sqlite"),
      secret_master_key: "dtrail-bridge-test-key"
    });
    ({ userId, workspaceId } = createVerifiedTestIdentity(metadataStore, { displayName: "Bridge" }));
    metadataStore.configResources.upsert({
      id: "dtrail",
      user_id: userId,
      workspace_id: workspaceId,
      kind: "mcp-server",
      name: "d-trail",
      payload: {
        transport: "streamable-http",
        serverUrl: "http://127.0.0.1:8060/mcp",
        apiUrl: baseUrl,
        authType: "bearer",
        timeoutMs: 10_000
      },
      secret_ref: metadataStore.secrets.put({
        user_id: userId,
        workspace_id: workspaceId,
        owner_kind: "mcp-server",
        owner_id: "dtrail",
        value: { token: "dev-token" }
      }),
      default_enabled: true,
      builtin: true,
      status: "untested"
    });
  });

  afterEach(() => {
    metadataStore.db.close();
  });

  const options = () => ({ metadataStore, userId, workspaceId });

  it("finds the registered dtrail mcp-server resource", () => {
    const resource = findDtrailServer(options());
    expect(resource?.id).toBe("dtrail");
  });

  it("submits a run and maps the 200 accepted result", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const result = await submitDtrailRun({ ...options(), fetchImpl: async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return runResponse(200, { task_id: "task-1", status: "COMPLETED", workspace: "/runs/task-1" });
    } }, {
      text: "sum amount by region",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }],
      grounder: "baseline",
      budget: { max_result_rows: 10_000 }
    });

    expect(captured?.url).toBe(`${baseUrl}/runs`);
    expect(captured?.init.headers instanceof Headers ? (captured.init.headers as Headers).get("Authorization") : undefined)
      .toBe("Bearer dev-token");
    const body = JSON.parse(captured?.init.body as string);
    expect(body.text).toBe("sum amount by region");
    expect(body.grounder).toBe("baseline");
    expect(body.sources).toEqual([{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]);
    expect(result).toMatchObject({ kind: "accepted", task_id: "task-1", status: "COMPLETED" });
  });

  it("maps a 409 WAITING_HUMAN conflict into the clarification flow", async () => {
    const result = await submitDtrailRun({ ...options(), fetchImpl: async () =>
      runResponse(409, { code: DTRAIL_WAITING_HUMAN, message: "Ambiguous source", stage: "grounding" })
    }, {
      text: "ambiguous query",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });

    expect(result).toEqual({
      kind: "waiting_human",
      code: DTRAIL_WAITING_HUMAN,
      message: "Ambiguous source",
      stage: "grounding"
    });
  });

  it("maps 400/422 into a rejected result", async () => {
    const result = await submitDtrailRun({ ...options(), fetchImpl: async () =>
      runResponse(422, { code: "VERIFICATION_FAILURE", message: "verification did not pass" })
    }, {
      text: "bad query",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });
    expect(result).toMatchObject({ kind: "rejected", code: "VERIFICATION_FAILURE" });
  });

  it("re-submits the same run with the human answer appended", () => {
    const clarification = {
      question: "Which region?",
      stage: "grounding",
      runArgs: { text: "sum amount", sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }] }
    };
    const reSubmitted = clarifyDtrailRun(clarification, "the east region");
    expect(reSubmitted.text).toContain("sum amount");
    expect(reSubmitted.text).toContain("the east region");
    expect(reSubmitted.sources).toEqual(clarification.runArgs.sources);
  });

  it("fetches run status + verification", async () => {
    const status = await fetchDtrailRunStatus({ ...options(), fetchImpl: async () =>
      runResponse(200, {
        task_id: "task-1",
        status: "COMPLETED",
        verification: { status: "pass", checks: [], verifier: "dtrail-verifier-v2" },
        metrics: { tool_calls: 1 },
        error: null
      })
    }, "task-1");
    expect(status.status).toBe("COMPLETED");
    expect(status.verification).toMatchObject({ status: "pass" });
  });

  it("returns a rejected result when the dtrail server is not registered", async () => {
    metadataStore.configResources.delete({
      id: "dtrail",
      user_id: userId,
      workspace_id: workspaceId,
      kind: "mcp-server"
    });
    const result = await submitDtrailRun(options(), {
      text: "hello",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });
    expect(result).toMatchObject({ kind: "rejected", code: "DTRAIL_API_URL_REQUIRED" });
  });

  it("surfaces fetch failures as DtrailBridgeError", async () => {
    await expect(fetchDtrailRunStatus({ ...options(), fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    } }, "task-1")).rejects.toMatchObject({ code: "DTRAIL_API_REQUEST_FAILED" });
  });

  it("maps attachments to d-trail sources by mime/extension", () => {
    expect(dtrailSourceKind("text/csv", "sales.csv")).toBe("csv");
    expect(dtrailSourceKind(undefined, "data.json")).toBe("json");
    expect(dtrailSourceKind("application/x-ndjson", "events.ndjson")).toBe("jsonl");
    const sources = attachmentsToDtrailSources([
      { file_id: "f1", filename: "sales.csv", mime_type: "text/csv", size_bytes: 10, source_path: "/a/sales.csv" },
      { file_id: "f2", filename: "geo.json", size_bytes: 20, source_path: "/a/geo.json" }
    ]);
    expect(sources).toEqual([
      { name: "sales", kind: "csv", path: "/a/sales.csv", description: "sales.csv" },
      { name: "geo", kind: "json", path: "/a/geo.json", description: "geo.json" }
    ]);
  });

  it("handoffs a completed run and records verification + trail validation as evidence", async () => {
    const calls: Array<{ url: string }> = [];
    const decision = await handoffDtrailRun({
      ...options(),
      fetchImpl: async (url) => {
        calls.push({ url: String(url) });
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/runs") || path.endsWith("/runs/")) {
          return runResponse(200, { task_id: "task-9", status: "COMPLETED", workspace: "/runs/task-9" });
        }
        if (path.endsWith("/trail/validate")) {
          return runResponse(200, { integrity: "pass", event_count: 12, head_hash: "abc123" });
        }
        if (path.endsWith("/trail")) {
          return runResponse(200, [{ event_type: "task/received" }]);
        }
        return runResponse(200, {
          task_id: "task-9",
          status: "COMPLETED",
          verification: { status: "pass", checks: [], verifier: "dtrail-verifier-v2" },
          metrics: { tool_calls: 1 },
          error: null
        });
      }
    }, {
      text: "sum amount by region",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });

    expect(decision.status).toBe("completed");
    if (decision.status === "completed") {
      expect(decision.evidence.dtrail_task_id).toBe("task-9");
      expect(decision.evidence.verification).toMatchObject({ status: "pass" });
      expect(decision.evidence.trail_validation).toMatchObject({ integrity: "pass", event_count: 12 });
    }
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns a waiting_human decision that maps into an interaction payload", async () => {
    const decision = await handoffDtrailRun({ ...options(), fetchImpl: async () =>
      runResponse(409, { code: DTRAIL_WAITING_HUMAN, message: "Pick a region", stage: "grounding" })
    }, {
      text: "sum amount",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });

    expect(decision.status).toBe("waiting_human");
    if (decision.status === "waiting_human") {
      expect(decision.clarification.question).toBe("Pick a region");
      const payload = dtrailClarificationToInteraction(decision.clarification, "run-1", "tc-1");
      expect(payload).toEqual({
        question: "Pick a region",
        run_id: "run-1",
        tool_call_id: "tc-1"
      });
    }
  });

  it("returns a failed decision for rejected runs", async () => {
    const decision = await handoffDtrailRun({ ...options(), fetchImpl: async () =>
      runResponse(400, { code: "CONTRACT_INVALID", message: "sources required" })
    }, {
      text: "bi",
      sources: []
    });
    expect(decision).toMatchObject({ status: "failed", code: "CONTRACT_INVALID" });
  });

  it("returns a rejected result when the dtrail server is not configured with an apiUrl", async () => {
    metadataStore.configResources.upsert({
      id: "dtrail",
      user_id: userId,
      workspace_id: workspaceId,
      kind: "mcp-server",
      name: "d-trail",
      payload: { transport: "stdio", command: "dtrail" },
      default_enabled: true,
      builtin: true,
      status: "untested",
      expected_revision: metadataStore.configResources.get({
        id: "dtrail", user_id: userId, workspace_id: workspaceId, kind: "mcp-server"
      }).revision
    });
    const result = await submitDtrailRun(options(), {
      text: "hello",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }]
    });
    expect(result).toMatchObject({ kind: "rejected", code: "DTRAIL_API_URL_REQUIRED" });
  });

  it("carries assume in the POST body when set and omits it when not", async () => {
    const captured: Array<string> = [];
    const submit = (assume?: boolean) => submitDtrailRun({
      ...options(),
      fetchImpl: async (_url, init) => {
        captured.push(init?.body as string);
        return runResponse(200, { task_id: "task-1", status: "COMPLETED", workspace: "/runs/task-1" });
      }
    }, {
      text: "hello",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }],
      ...(assume === undefined ? {} : { assume })
    });
    await submit(true);
    await submit();
    expect(JSON.parse(captured[0]!).assume).toBe(true);
    expect(Object.hasOwn(JSON.parse(captured[1]!), "assume")).toBe(false);
  });

  it("maps the assumptions receipt", async () => {
    const assumptions = await fetchDtrailAssumptions({ ...options(), fetchImpl: async () =>
      runResponse(200, {
        task_id: "task-1",
        assumptions: [{ clause: "sources resolve" }],
        trees: [{ claim: "p1", status: "confirmed", evidence: null, probe_count: 3 }],
        probes: 4,
        summary: { total: 4, confirmed: 2, refuted: 1, assumed: 1 },
        policy: "strict"
      })
    }, "task-1");
    expect(assumptions?.task_id).toBe("task-1");
    expect(assumptions?.summary).toEqual({ total: 4, confirmed: 2, refuted: 1, assumed: 1 });
    expect(assumptions?.trees).toEqual([
      { claim: "p1", status: "confirmed", evidence: null, probe_count: 3 }
    ]);
  });

  it("resolves undefined when the assumptions endpoint has no receipt", async () => {
    const missing = await fetchDtrailAssumptions({ ...options(), fetchImpl: async () =>
      runResponse(404, { code: "NOT_FOUND", message: "no assumptions" })
    }, "task-1");
    const failed = await fetchDtrailAssumptions({ ...options(), fetchImpl: async () =>
      runResponse(500, { code: "DTRAIL_ERROR", message: "boom" })
    }, "task-1");
    expect(missing).toBeUndefined();
    expect(failed).toBeUndefined();
  });

  it("records evidence.assumptions on a completed hand-off", async () => {
    const decision = await handoffDtrailRun({
      ...options(),
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/runs") || path.endsWith("/runs/")) {
          return runResponse(200, { task_id: "task-a", status: "COMPLETED", workspace: "/runs/task-a" });
        }
        if (path.endsWith("/assumptions")) {
          return runResponse(200, {
            task_id: "task-a",
            assumptions: [],
            trees: [],
            probes: 0,
            summary: { total: 0, confirmed: 0, refuted: 1, assumed: 0 }
          });
        }
        if (path.endsWith("/trail/validate")) {
          return runResponse(200, { integrity: "pass", event_count: 2, head_hash: "h" });
        }
        return runResponse(200, {
          task_id: "task-a",
          status: "COMPLETED",
          verification: { status: "pass" },
          metrics: {},
          error: null
        });
      }
    }, {
      text: "sum",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }],
      assume: true
    });
    expect(decision.status).toBe("completed");
    if (decision.status === "completed") {
      expect(decision.evidence.dtrail_task_id).toBe("task-a");
      expect(decision.evidence.assumptions?.summary.refuted).toBe(1);
    }
  });

  it("still completes when the assumptions fetch fails", async () => {
    const decision = await handoffDtrailRun({
      ...options(),
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/runs") || path.endsWith("/runs/")) {
          return runResponse(200, { task_id: "task-b", status: "COMPLETED", workspace: "/runs/task-b" });
        }
        if (path.endsWith("/assumptions")) {
          throw new Error("ECONNREFUSED");
        }
        return runResponse(200, {
          task_id: "task-b",
          status: "COMPLETED",
          verification: { status: "pass" },
          metrics: {},
          error: null
        });
      }
    }, {
      text: "sum",
      sources: [{ name: "sales", kind: "csv", path: "/tmp/sales.csv" }],
      assume: true
    });
    expect(decision.status).toBe("completed");
    if (decision.status === "completed") {
      expect(decision.evidence.assumptions).toBeUndefined();
    }
  });
});
