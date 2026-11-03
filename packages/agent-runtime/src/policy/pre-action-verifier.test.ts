import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ActionRouter } from "../capabilities/action-router.js";
import { CapabilityRegistry } from "../capabilities/capability-registry.js";
import { InMemoryProtocolStateStore } from "../protocol/in-memory-protocol-state-store.js";
import { ProtocolRuntime } from "../protocol/protocol-runtime.js";
import type { AgentProtocolDefinition, ProtocolActionRecord } from "../protocol/types.js";
import {
  createPreActionVerifier,
  findExternalAccess,
  preActionVerifierFromEnvironment,
  repeatedFailureStreak
} from "./pre-action-verifier.js";

const sql = (text: string) => ({ actionName: "run_sql_readonly", input: { schema_id: "s1", sql: text } });

describe("findExternalAccess", () => {
  it.each([
    ["SELECT * FROM read_csv('/data/answers.csv')", "read_csv"],
    ["select * from READ_PARQUET('s3://bucket/x.parquet')", "read_parquet"],
    ["SELECT getenv('OPENAI_API_KEY')", "getenv"],
    ["SELECT * FROM query('DROP TABLE t')", "query"],
    ["SELECT * FROM glob('/home/*')", "glob"],
    ["WITH x AS (SELECT * FROM read_text ( '/etc/passwd' )) SELECT * FROM x", "read_text"],
    ["SELECT * FROM sqlite_scan('other.db', 't')", "sqlite_scan"]
  ])("blocks external function: %s", (text, fn) => {
    expect(findExternalAccess(text)).toContain(fn);
  });

  it.each([
    "SELECT * FROM '/data/answers.csv'",
    "SELECT * FROM t JOIN 'https://example.com/x.parquet' u ON t.id = u.id",
    'SELECT * FROM "/data/answers.csv"',
    'SELECT * FROM "answers.json"'
  ])("blocks a file used as a table: %s", (text) => {
    expect(findExternalAccess(text)).toBeDefined();
  });

  it.each([
    "SELECT tumor_normal, COUNT(*) FROM samples WHERE case_excluded = 'No' GROUP BY 1",
    "SELECT * FROM \"Sample Table\" WHERE note = 'read_csv(/x) is just text'",
    "SELECT \"query\" FROM logs WHERE path = '/var/log/app.csv'",
    "SELECT corr(a, b) FROM t -- read_csv('/x') in a comment",
    "SELECT * FROM t /* FROM '/x.csv' */ WHERE d > '2020/01/01'",
    "SELECT name FROM files WHERE name GLOB '*.csv'"
  ])("allows ordinary SQL: %s", (text) => {
    expect(findExternalAccess(text)).toBeUndefined();
  });
});

describe("createPreActionVerifier", () => {
  it("rejects external access with its reason code", () => {
    const policy = createPreActionVerifier();
    expect(policy(sql("SELECT * FROM read_csv('/answers.csv')"))).toMatchObject({
      allowed: false,
      reasonCode: "PRE_ACTION_EXTERNAL_ACCESS"
    });
  });

  it("rejects a datasource outside the run's enabled set", () => {
    const policy = createPreActionVerifier({ enabledDatasourceIds: ["kb-domain"] });
    expect(policy({ actionName: "inspect_schema", input: { datasource_id: "other-db" } })).toMatchObject({
      allowed: false,
      reasonCode: "PRE_ACTION_DATASOURCE_SCOPE"
    });
    expect(policy({ actionName: "inspect_schema", input: { datasource_id: "kb-domain" } })).toEqual({ allowed: true });
  });

  it("allows actions without SQL or datasource arguments", () => {
    const policy = createPreActionVerifier({ enabledDatasourceIds: ["kb-domain"] });
    expect(policy({ actionName: "list_data_sources", input: {} })).toEqual({ allowed: true });
    expect(policy({ actionName: "protocol.handoff.propose", input: undefined })).toEqual({ allowed: true });
  });
});

describe("preActionVerifierFromEnvironment", () => {
  it("is off unless DF_PRE_ACTION_VERIFY=1", () => {
    expect(preActionVerifierFromEnvironment({})).toBeUndefined();
    expect(preActionVerifierFromEnvironment({ DF_PRE_ACTION_VERIFY: "0" })).toBeUndefined();
    expect(preActionVerifierFromEnvironment({ DF_PRE_ACTION_VERIFY: "1" })).toBeTypeOf("function");
  });
});

describe("pre-action verifier in the ActionRouter", () => {
  it("stops a harmful SQL call before its executor runs and records the rejection", async () => {
    let executed = false;
    const registry = new CapabilityRegistry();
    registry.register({
      manifest: { id: "test-data", version: "1", provides: ["run_sql_readonly"] },
      actions: [{
        name: "run_sql_readonly",
        exposure: "agent",
        inputSchema: z.object({ schema_id: z.string(), sql: z.string() }),
        outputSchema: z.object({ rows: z.array(z.unknown()) }),
        idempotency: "supported",
        execute: async () => {
          executed = true;
          return { rows: [] };
        }
      }]
    });
    const runtime = new ProtocolRuntime(protocol, new InMemoryProtocolStateStore());
    runtime.start({ runId: "run-1", segmentId: "segment-1", contextPackageRef: { packageId: "c", revision: 0 } });
    const router = new ActionRouter(registry, runtime, {
      serverPolicy: createPreActionVerifier({ enabledDatasourceIds: ["kb-domain"] }),
      projectContext: () => ({ packageId: "c", revision: 1 })
    });

    await expect(router.execute({
      runId: "run-1",
      segmentId: "segment-1",
      actionId: "action-1",
      actionName: "run_sql_readonly",
      input: { schema_id: "s1", sql: "SELECT * FROM '/kramabench/answers.json'" }
    })).rejects.toThrow("ACTION_REJECTED:PRE_ACTION_EXTERNAL_ACCESS:run_sql_readonly");
    expect(executed).toBe(false);
    expect(runtime.getState("run-1", "segment-1").actions).toMatchObject([{
      actionName: "run_sql_readonly",
      status: "rejected",
      reasonCode: "PRE_ACTION_EXTERNAL_ACCESS"
    }]);

    await router.execute({
      runId: "run-1",
      segmentId: "segment-1",
      actionId: "action-2",
      actionName: "run_sql_readonly",
      input: { schema_id: "s1", sql: "SELECT COUNT(*) FROM samples" }
    });
    expect(executed).toBe(true);
  });
});

const record = (actionName: string, status: ProtocolActionRecord["status"], reasonCode?: string): ProtocolActionRecord => ({
  actionId: `${actionName}-${Math.random()}`,
  actionName,
  status,
  inputContextPackageRef: { packageId: "c", revision: 0 },
  ...(reasonCode ? { reasonCode } : {})
});

describe("repeated-failure rule", () => {
  const plan = "data.query.plan";
  const fail = (id: string) => record(plan, "failed", `ANALYSIS_REQUIREMENT_NOT_FOUND:${id}`);

  it("counts same-class failures, ignoring the varying detail after the colon", () => {
    const actions = ["a", "b", "c", "d", "e"].map(fail);
    expect(repeatedFailureStreak(actions, plan)).toEqual({
      failures: 5, blockedSince: 0, errorClass: "ANALYSIS_REQUIREMENT_NOT_FOUND"
    });
  });

  it("ends the streak at a success or a different error class, and ignores other actions", () => {
    const actions = [fail("a"), record(plan, "succeeded"), fail("b"), record("list_files", "succeeded"), fail("c")];
    expect(repeatedFailureStreak(actions, plan).failures).toBe(2);
    const mixed = [record(plan, "failed", "QUERY_CONTRACT_VALIDATION_FAILED"), fail("a"), fail("b")];
    expect(repeatedFailureStreak(mixed, plan).failures).toBe(2);
  });

  it("blocks after the threshold, lets one attempt through after the cooldown, then blocks again", () => {
    const history: ProtocolActionRecord[] = ["a", "b", "c", "d"].map(fail);
    const policy = createPreActionVerifier({ maxRepeatedFailures: 5 });
    policy.attachHistory(() => history);
    const ask = () => policy({ actionName: plan, input: {} });
    expect(ask()).toEqual({ allowed: true });
    history.push(fail("e"));
    for (let blocked = 0; blocked < 3; blocked += 1) {
      expect(ask()).toMatchObject({
        allowed: false, reasonCode: "PRE_ACTION_REPEATED_FAILURE:ANALYSIS_REQUIREMENT_NOT_FOUND"
      });
      history.push(record(plan, "rejected", "PRE_ACTION_REPEATED_FAILURE:ANALYSIS_REQUIREMENT_NOT_FOUND"));
    }
    expect(ask()).toEqual({ allowed: true });
    history.push(fail("f"));
    expect(ask()).toMatchObject({ allowed: false });
    expect(policy({ actionName: "inspect_schema", input: {} })).toEqual({ allowed: true });
  });

  it("does not count failures the agent cannot cause, such as provider or parser errors", () => {
    const history = [
      ...["a", "b", "c"].map(fail),
      record(plan, "failed", "AI_APICallError: Rate limit reached"),
      record(plan, "failed", "SQL_SEMANTIC_PARSE_FAILED"),
      fail("d")
    ];
    expect(repeatedFailureStreak(history, plan).failures).toBe(4);
    const policy = createPreActionVerifier({ maxRepeatedFailures: 5 });
    policy.attachHistory(() => history);
    expect(policy({ actionName: plan, input: {} })).toEqual({ allowed: true });
  });

  it("is off at 0 and reads its threshold from the environment", () => {
    const history = ["a", "b", "c", "d", "e", "f"].map(fail);
    const off = createPreActionVerifier({ maxRepeatedFailures: 0 });
    off.attachHistory(() => history);
    expect(off({ actionName: plan, input: {} })).toEqual({ allowed: true });
    const fromEnv = preActionVerifierFromEnvironment({ DF_PRE_ACTION_VERIFY: "1", DF_PRE_ACTION_MAX_REPEATED_FAILURES: "3" });
    fromEnv?.attachHistory(() => history.slice(0, 3));
    expect(fromEnv?.({ actionName: plan, input: {} })).toMatchObject({ allowed: false });
  });

  it("stops a failing loop in the real ActionRouter before the executor runs again", async () => {
    let executions = 0;
    const registry = new CapabilityRegistry();
    registry.register({
      manifest: { id: "test-plan", version: "1", provides: [plan] },
      actions: [{
        name: plan,
        exposure: "agent",
        inputSchema: z.object({ requirement_id: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        idempotency: "supported",
        execute: async (_context, input) => {
          executions += 1;
          throw new Error(`ANALYSIS_REQUIREMENT_NOT_FOUND:${(input as { requirement_id: string }).requirement_id}`);
        }
      }]
    });
    const runtime = new ProtocolRuntime({ ...protocol, phases: { active: { allowedActions: [plan], transitions: [] } } },
      new InMemoryProtocolStateStore());
    runtime.start({ runId: "run-1", segmentId: "segment-1", contextPackageRef: { packageId: "c", revision: 0 } });
    const policy = createPreActionVerifier({ maxRepeatedFailures: 5 });
    policy.attachHistory(() => runtime.getState("run-1", "segment-1").actions);
    const router = new ActionRouter(registry, runtime, {
      serverPolicy: policy,
      projectContext: () => ({ packageId: "c", revision: 1 })
    });
    const attempt = (n: number) => router.execute({
      runId: "run-1", segmentId: "segment-1", actionId: `a${n}`, actionName: plan, input: { requirement_id: `guess-${n}` }
    });
    for (let n = 0; n < 5; n += 1) {
      await expect(attempt(n)).rejects.toThrow();
    }
    expect(executions).toBe(5);
    await expect(attempt(5)).rejects.toThrow(
      "ACTION_REJECTED:PRE_ACTION_REPEATED_FAILURE:ANALYSIS_REQUIREMENT_NOT_FOUND:data.query.plan"
    );
    expect(executions).toBe(5);
  });
});

const protocol: AgentProtocolDefinition<Record<string, never>> = {
  id: "test/pre-action",
  version: "1",
  initialPhase: "active",
  phases: { active: { allowedActions: ["run_sql_readonly"], transitions: [] } },
  createInitialState: () => ({}),
  completionPolicy: () => ({ status: "continue", reasons: ["not done"], allowedActions: [] })
};
