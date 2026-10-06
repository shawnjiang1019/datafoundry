import type { RunAgentInput } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { ASSUMPTION_RECEIPT_MAX_CHARS, assumptionsLoadedPayload, extractEffectiveRunConfig } from "./run-input.js";

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

describe("extractEffectiveRunConfig assumption receipt", () => {
  const receipt = {
    task_id: "task_1",
    assumptions: [{ clause: "Each row is one sample", term: "sample" }],
    trees: [{ status: "refuted", claim: null }],
    summary: { total: 1, refuted: 1 },
    conditioner_reply: "raw model text"
  };

  it("parses a valid receipt and drops conditioner_reply", () => {
    const config = extractEffectiveRunConfig(createInput({ assumptionReceipt: receipt }));

    expect(config.assumptionReceipt).toEqual({
      task_id: "task_1",
      assumptions: receipt.assumptions,
      trees: receipt.trees,
      summary: receipt.summary
    });
    expect(assumptionsLoadedPayload(config.assumptionReceipt!)).toEqual({
      dtrail_task_id: "task_1",
      item_count: 1,
      assumption_count: 1,
      summary: { total: 1, refuted: 1 }
    });
  });

  it("unwraps the GET /runs/{id}/assumptions body", () => {
    const config = extractEffectiveRunConfig(createInput({
      assumptionReceipt: { task_id: "task_1", assumptions: { ...receipt, task_id: undefined } }
    }));

    expect(config.assumptionReceipt?.trees).toEqual(receipt.trees);
    expect(config.assumptionReceipt).not.toHaveProperty("conditioner_reply");
  });

  it("ignores malformed receipts without failing the run", () => {
    for (const assumptionReceipt of ["text", [receipt], { trees: "x" }, { assumptions: 3, trees: [] }]) {
      expect(extractEffectiveRunConfig(createInput({ assumptionReceipt })).assumptionReceipt).toBeUndefined();
    }
    expect(extractEffectiveRunConfig(createInput({})).assumptionReceipt).toBeUndefined();
  });

  it("ignores an oversized receipt", () => {
    const huge = { ...receipt, trees: [{ status: "assumed", note: "x".repeat(ASSUMPTION_RECEIPT_MAX_CHARS) }] };
    expect(extractEffectiveRunConfig(createInput({ assumptionReceipt: huge })).assumptionReceipt).toBeUndefined();
  });

  it("does not count a stripped conditioner_reply toward the size cap", () => {
    const big = { ...receipt, conditioner_reply: "x".repeat(ASSUMPTION_RECEIPT_MAX_CHARS) };
    expect(extractEffectiveRunConfig(createInput({ assumptionReceipt: big })).assumptionReceipt).toBeDefined();
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
