import { describe, expect, it } from "vitest";

import { createAnswerCommitCheck, uncommittedAnswerReason } from "./answer-commit-check.js";
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
