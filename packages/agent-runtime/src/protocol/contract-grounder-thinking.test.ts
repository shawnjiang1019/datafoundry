import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProviderFromConfig, createThinkingSwitchFetch, DISABLE_THINKING_HEADER } from "@datafoundry/providers";

import { createUserAnalysisRequirements } from "./analysis-requirements.js";
import { createModelAnalysisContractGrounder } from "./model-analysis-contract-grounder.js";

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

const completion = (content: string) => new Response(JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "glm-5.3",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}), { status: 200, headers: { "content-type": "application/json" } });

const capture = (requests: Captured[], content = "{}") => async (input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({
    url: String(input),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
  });
  return completion(content);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thinking switch", () => {
  it("turns the header into thinking disabled on GLM endpoints and drops it everywhere", async () => {
    const requests: Captured[] = [];
    const send = (baseUrl: string, headers: Record<string, string>) => createThinkingSwitchFetch(baseUrl, capture(requests))(
      `${baseUrl}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify({ model: "m", messages: [] }) }
    );

    await send("https://open.bigmodel.cn/api/coding/paas/v4", { [DISABLE_THINKING_HEADER]: "1" });
    await send("https://api.openai.com/v1", { [DISABLE_THINKING_HEADER]: "1" });
    await send("https://open.bigmodel.cn/api/coding/paas/v4", {});

    expect(requests.map((request) => request.body.thinking)).toEqual([{ type: "disabled" }, undefined, undefined]);
    expect(requests.every((request) => !request.headers.has(DISABLE_THINKING_HEADER))).toBe(true);
  });

  it("sends the contract grounding call to GLM with thinking disabled", async () => {
    const requests: Captured[] = [];
    const contract = JSON.stringify({ contracts: [{ requirementId: "R1", assertions: [{ kind: "manual", description: "check" }] }] });
    vi.stubGlobal("fetch", capture(requests, contract));
    const provider = createModelProviderFromConfig({
      provider: "openai-compatible",
      model: "glm-5.3",
      base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
      api_key: "test-key"
    });
    if (provider.kind === "mock") throw new Error("expected a real provider");

    const grounded = await createModelAnalysisContractGrounder(provider)({
      requirements: createUserAnalysisRequirements([{ kind: "metric", description: "count", acceptanceCriteria: ["one number"] }]),
      physicalSchema: { tables: [] },
      semanticResolution: { value: {}, capabilities: [], trust: "verified", warnings: [] } as never,
      datasourceRevision: "1"
    });

    expect(grounded.findings).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.thinking).toEqual({ type: "disabled" });
    expect(requests[0]?.headers.has(DISABLE_THINKING_HEADER)).toBe(false);
  });
});
