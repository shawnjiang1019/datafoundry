import { describe, expect, it } from "vitest";

import { createThinkingSwitchFetch, denseToolCallIndexes } from "./index.js";

const stream = (parts: string[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    parts.forEach((part) => controller.enqueue(encoder.encode(part)));
    controller.close();
  }
}), { headers: { "content-type": "text/event-stream" } });

const toolIndexes = (text: string): number[] => text.split("\n")
  .filter((line) => line.startsWith("data:") && line.includes("tool_calls"))
  .flatMap((line) => (JSON.parse(line.slice(5)) as { choices: Array<{ delta: { tool_calls: Array<{ index: number }> } }> })
    .choices.flatMap((choice) => choice.delta.tool_calls.map((call) => call.index)));

const call = (index: number, extra = "") =>
  `data: {"choices":[{"delta":{"tool_calls":[{"index":${index}${extra}}]}}]}\n\n`;

describe("denseToolCallIndexes", () => {
  it("renumbers tool calls that GLM streams with a gap, so the SDK's array has no hole", async () => {
    // archeology-hard-7 (2026-11-06): an index gap crashed the AI SDK at the end of the stream.
    const response = denseToolCallIndexes(stream([
      call(1, ',"id":"a","function":{"name":"run_sql_readonly","arguments":""}'),
      call(1, ',"function":{"arguments":"{}"}'),
      call(3, ',"id":"b","function":{"name":"inspect_schema","arguments":"{}"}'),
      "data: [DONE]\n\n"
    ]));
    const text = await response.text();
    expect(toolIndexes(text)).toEqual([0, 0, 1]);
    expect(text).toContain("data: [DONE]");
  });

  it("leaves dense indexes, text chunks split across reads, and non-stream responses as they are", async () => {
    const parts = [call(0), "data: {\"choices\":[{\"delta\":{\"cont", "ent\":\"hi\"}}]}\n\n", call(1)];
    expect(await denseToolCallIndexes(stream(parts)).text()).toBe(parts.join(""));
    const json = new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } });
    expect(denseToolCallIndexes(json)).toBe(json);
  });

  it("is applied to every response from the provider's fetch", async () => {
    const wrapped = createThinkingSwitchFetch("https://open.bigmodel.cn/api/paas/v4", async () => stream([call(2)]));
    expect(toolIndexes(await (await wrapped("https://x", {})).text())).toEqual([0]);
  });
});
