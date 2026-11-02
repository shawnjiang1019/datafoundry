import { describe, expect, it } from "vitest";

import { ContextBudgetAllocator } from "../../policy/context-budget-allocator.js";
import { registerDefaultToolObservationAdapters } from "../default-tool-observation-adapters.js";
import { ToolObservationAdapterRegistry } from "../tool-observation-adapter-registry.js";
import { ConcludeStageToolObservationAdapter } from "./stage-plan-tool-observation-adapter.js";

const budget = () => new ContextBudgetAllocator().allocate({ sourceType: "tool-observation", toolName: "conclude_stage" });

describe("ConcludeStageToolObservationAdapter", () => {
  it("shows the model the verdict only, not d-trail's envelope", () => {
    const verdict = {
      contract_version: "dtrail-annotation-paging/0.1", environment_id: "env", session_id: "run-1",
      accepted: false, errors: ["output 'answer' must be a number"], rejected_attempts: 1, ready: ["s2"], done: false
    };
    const items = new ConcludeStageToolObservationAdapter().toContextItems(verdict, budget());
    expect(items.map((item) => item.visibility)).toEqual(["model", "activity"]);
    expect(items[0]?.content).toEqual({
      accepted: false, errors: ["output 'answer' must be a number"], rejected_attempts: 1, ready: ["s2"], done: false,
      source: "d-trail-stage-plan"
    });
  });

  it("is a default adapter, so a run that exposes conclude_stage can start", () => {
    const registry = new ToolObservationAdapterRegistry();
    registerDefaultToolObservationAdapters({ registry });
    expect(registry.resolveByToolName("conclude_stage")).toBeInstanceOf(ConcludeStageToolObservationAdapter);
  });
});
