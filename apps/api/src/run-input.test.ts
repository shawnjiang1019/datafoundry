import type { RunAgentInput } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { extractEffectiveRunConfig } from "./run-input.js";

describe("extractEffectiveRunConfig protocol selection", () => {
  it("parses an explicit protocol identity from run_config", () => {
    const config = extractEffectiveRunConfig(createInput({
      protocol: { id: "data-analysis", version: "1" }
    }));

    expect(config.protocol).toEqual({ protocolId: "data-analysis", protocolVersion: "1" });
  });

  it("rejects a partially specified explicit protocol", () => {
    expect(() => extractEffectiveRunConfig(createInput({
      protocol: { id: "data-analysis" }
    }))).toThrow("INVALID_PROTOCOL_SELECTION");
  });
});

describe("extractEffectiveRunConfig evidence grounding", () => {
  it("enables evidence grounding only when run_config asks for it", () => {
    expect(extractEffectiveRunConfig(createInput({ evidenceGrounding: true })).evidenceGrounding).toBe(true);
    expect(extractEffectiveRunConfig(createInput({ evidence_grounding: true })).evidenceGrounding).toBe(true);
    expect(extractEffectiveRunConfig(createInput({})).evidenceGrounding).toBeUndefined();
  });

  it("enables the answer frame independently of relationship grounding", () => {
    const config = extractEffectiveRunConfig(createInput({ answerFrame: true }));

    expect(config.answerFrame).toBe(true);
    expect(config.evidenceGrounding).toBeUndefined();
  });

  it("reads join and frame binding separately, with noteBinding turning on both", () => {
    const joins = extractEffectiveRunConfig(createInput({ join_binding: true }));
    const frame = extractEffectiveRunConfig(createInput({ frameBinding: true }));
    const both = extractEffectiveRunConfig(createInput({ noteBinding: true }));
    const neither = extractEffectiveRunConfig(createInput({}));

    expect([joins.joinBinding, joins.frameBinding]).toEqual([true, undefined]);
    expect([frame.joinBinding, frame.frameBinding]).toEqual([undefined, true]);
    expect([both.joinBinding, both.frameBinding]).toEqual([true, true]);
    expect([neither.joinBinding, neither.frameBinding]).toEqual([undefined, undefined]);
  });
});

const createInput = (runConfig: Record<string, unknown>): RunAgentInput => ({
  context: [],
  forwardedProps: { run_config: runConfig },
  messages: [],
  runId: "run-1",
  state: {},
  threadId: "thread-1",
  tools: []
});
