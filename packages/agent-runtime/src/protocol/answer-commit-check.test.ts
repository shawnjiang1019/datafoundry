import { describe, expect, it } from "vitest";

import { createAnswerCheck, createAnswerCommitCheck, finalAnswerSql, finalAnswerValue, uncommittedAnswerReason } from "./answer-commit-check.js";
import type { ProtocolRunState } from "./types.js";

const runState = (domain: Record<string, unknown>, overrides: Partial<ProtocolRunState> = {}): ProtocolRunState => ({
  protocolId: "data-analysis",
  status: "active",
  domain,
  ...overrides
}) as unknown as ProtocolRunState;

const bound = (status: string, frame = true) => runState({
  evidenceGrounding: { facts: [], candidates: [], duplicateTables: [], warnings: [], binding: { frame } },
  frameChoices: ["F1.2"],
  requirements: [{ id: "CORE_QUERY", status: "validated" }, { id: "R1", status }]
});

describe("answer commit check", () => {
  it("asks for a commit only when frame binding is on and the answer is not reported", () => {
    expect(uncommittedAnswerReason(bound("evidenced"))).toMatch(/not committed \(R1\).*frame choices \(F1\.2\)/u);
    expect(uncommittedAnswerReason(bound("reported"))).toBeUndefined();
    expect(uncommittedAnswerReason(bound("evidenced", false))).toBeUndefined();
    expect(uncommittedAnswerReason(runState({ requirements: [{ id: "R1", status: "pending" }] }))).toBeUndefined();
    expect(uncommittedAnswerReason({ ...bound("evidenced"), protocolId: "general-task" })).toBeUndefined();
    expect(uncommittedAnswerReason({ ...bound("evidenced"), status: "terminal" } as ProtocolRunState)).toBeUndefined();
  });

  it("sends the agent back at most twice, then lets the run end", async () => {
    const check = createAnswerCommitCheck({ getState: () => bound("evidenced") });

    expect((await check.run()).score).toBe(0);
    expect((await check.run()).score).toBe(0);
    expect(await check.run()).toEqual({ score: 1 });
  });

  it("passes once the answer is committed, and never blocks on a state it cannot read", async () => {
    let state = bound("evidenced");
    const check = createAnswerCommitCheck({ getState: () => state });

    expect((await check.run()).score).toBe(0);
    state = bound("reported");
    expect(await check.run()).toEqual({ score: 1 });
    expect(await createAnswerCommitCheck({ getState: () => { throw new Error("gone"); } }).run()).toEqual({ score: 1 });
  });
});

const attempt = (id: string, sql: string, status: string, resultRows: unknown[][], verifiedValues: unknown[] = []) =>
  ({ id, sql, status, resultRows, verifiedValues });

// The answer 1.23 comes from Q1, which recomputes the z-score; Q2, run after, only looks the stated column up.
const checkedRun = () => runState({
  evidenceGrounding: {
    question: "What is the APP z-score of patient 7?",
    facts: [], candidates: [], duplicateTables: [], warnings: [],
    measures: [{ kind: "named", table: "patients", column: "APP_Z_score", phrase: "APP z-score" }],
    binding: { check: true }
  },
  requirements: [],
  queryAttempts: [
    attempt("Q1", "SELECT (app - AVG(app) OVER ()) / STDDEV(app) OVER () AS z FROM patients", "executed", [[7, 1.2345]]),
    attempt("Q2", "SELECT APP_Z_score FROM patients WHERE id = 7", "evidenced", [[0.52]])
  ]
});

describe("answer check: the query the answer came from", () => {
  const domain = () => checkedRun().domain as never;

  it("picks the latest query whose result holds the answer, else the last verified one", () => {
    expect(finalAnswerSql(domain(), "Done.\nFINAL_ANSWER: 1.23")).toMatch(/STDDEV/u);
    expect(finalAnswerSql(domain(), "FINAL_ANSWER: 0.52")).toMatch(/APP_Z_score/u);
    expect(finalAnswerSql(domain(), "FINAL_ANSWER: 99")).toMatch(/APP_Z_score/u);
    expect(finalAnswerSql(domain(), "no answer line")).toMatch(/APP_Z_score/u);
    expect(finalAnswerSql(domain())).toMatch(/APP_Z_score/u);
  });

  it("reads numbers with their rounding, lists by column, and strings without case", () => {
    expect(finalAnswerValue("FINAL_ANSWER: 2,065.10")).toEqual({ number: 2065.1, tolerance: 0.005 });
    expect(finalAnswerValue("final_answer： \"Delaware\"")).toBe("Delaware");
    const lists = { queryAttempts: [attempt("Q1", "SELECT name, n FROM t", "executed", [["CDK12", 3], ["SMARCA4", 2]])] } as never;
    expect(finalAnswerSql(lists, "FINAL_ANSWER: [\"cdk12\", \"SMARCA4\"]")).toBe("SELECT name, n FROM t");
  });

  it("challenges the query the answer came from, and says so when the answer is unchanged", async () => {
    const check = createAnswerCheck({ getState: checkedRun });
    const output = "FINAL_ANSWER: 1.23";

    const first = await check.run({ output });
    expect(first.score).toBe(0);
    expect(first.reason).toMatch(/^DEFINED_MEASURE_IGNORED: The question asks/u);
    const second = await check.run({ output });
    expect(second.score).toBe(0);
    expect(second.reason).toMatch(/Your answer is still 1\.23/u);
    expect(await check.run({ output })).toEqual({ score: 1 });
  });

  it("lets an answer from a query with no conflict through", async () => {
    expect(await createAnswerCheck({ getState: checkedRun }).run({ output: "FINAL_ANSWER: 0.52" })).toEqual({ score: 1 });
  });
});
