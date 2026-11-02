import { describe, expect, it } from "vitest";

import { buildAgentInstructions } from "../index.js";
import {
  CONCLUDE_STAGE_TOOL_NAME,
  createConcludeStageTool,
  fetchStagePlan,
  renderStagePlan,
  stagePlanConfigFromEnvironment,
  type StagePlan
} from "./stage-plan.js";

const plan: StagePlan = {
  pinned: ["count fires, not acres"],
  stages: [
    {
      stage_id: "s1", method: "prepare", goal: "Label each state by party.", inputs: [],
      outputs: ["party_by_state"], context: { tables: ["votes"] },
      output_contracts: { party_by_state: { type: "object", description: "state -> party", max_chars: 2000 } }
    },
    {
      stage_id: "s2", method: "answer", goal: "Compare fire counts.", inputs: [["s1", "party_by_state"]],
      outputs: ["answer"], context: { tables: ["fires"] },
      output_contracts: { answer: { type: "string", max_chars: 12 } }
    }
  ]
};

const recordingFetch = (reply: unknown) => {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(reply));
  }) as typeof fetch;
  return { calls, fetchImpl };
};

describe("stage plan", () => {
  it("is configured only when DF_STAGE_PLAN_URL is set", () => {
    expect(stagePlanConfigFromEnvironment({})).toBeUndefined();
    expect(stagePlanConfigFromEnvironment({ DF_STAGE_PLAN_URL: "http://h:1/", DF_STAGE_PLAN_TOKEN: "t" }))
      .toEqual({ url: "http://h:1", token: "t" });
  });

  it("fetches the plan for the run's session, and gives up quietly when it cannot", async () => {
    const { calls, fetchImpl } = recordingFetch({ plan });
    const config = { url: "http://h:1", token: "t" };
    expect(await fetchStagePlan(config, "env 1", "run-1", "q?", fetchImpl)).toEqual(plan);
    expect(calls[0]?.url).toBe("http://h:1/annotation/env%201/plan");
    expect(calls[0]?.body).toEqual({ session_id: "run-1", question: "q?" });
    expect(calls[0]?.headers.authorization).toBe("Bearer t");
    const refused = recordingFetch({ error: { failure_class: "plan_invalid" } });
    expect(await fetchStagePlan(config, "env", "run-1", "q?", refused.fetchImpl)).toBeUndefined();
    const down = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect(await fetchStagePlan(config, "env", "run-1", "q?", down)).toBeUndefined();
  });

  it("renders stages with what each reads and must report", () => {
    const text = renderStagePlan(plan);
    expect(text).toContain("Keep throughout: count fires, not acres.");
    expect(text).toContain("Stage s2 (answer): Compare fire counts. Tables: fires. Reads: s1.party_by_state.");
    expect(text).toContain("answer (string, at most 12 chars)");
  });

  it("puts the plan in the instructions only with the tool", () => {
    const base = {
      runContext: { run_id: "run-1", user_input: "q" }, collaborationToolsEnabled: false,
      commandExecutionEnabled: false, taskToolsEnabled: false, selectedSkills: [], protocolId: "data-analysis",
      mcpToolNames: [], analysisRequirements: [], workspaceAttachments: [], stagePlan: plan
    } as unknown as Parameters<typeof buildAgentInstructions>[0];
    expect(buildAgentInstructions({ ...base, toolNames: [CONCLUDE_STAGE_TOOL_NAME] })).toContain("Stage s1");
    expect(buildAgentInstructions({ ...base, toolNames: [] })).not.toContain("Stage s1");
  });

  it("conclude_stage posts the outputs and returns D-Trail's verdict", async () => {
    const { calls, fetchImpl } = recordingFetch({ accepted: true, ready: ["s2"], done: false });
    const tool = createConcludeStageTool({ url: "http://h:1" }, "env", "run-1", fetchImpl);
    const execute = tool.execute as unknown as (input: unknown) => Promise<unknown>;
    expect(await execute({ stage_id: "s1", outputs: { party_by_state: { CA: "D" } } }))
      .toEqual({ accepted: true, ready: ["s2"], done: false });
    expect(calls[0]?.body).toEqual({ session_id: "run-1", stage_id: "s1", outputs: { party_by_state: { CA: "D" } } });
  });
});
