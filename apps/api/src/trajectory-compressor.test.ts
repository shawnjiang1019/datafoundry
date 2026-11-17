import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { compressRun, parseCompressed } from "./trajectory-compressor.js";

const REPLY = {
  run_id: "run-1", text: "GOAL: \"q\"\n", tokens: 800, source_tokens: 9000, budget: 6000, budget_satisfied: false,
  archive: "abc", path: "/x",
  digest: { unrepaired: 1, repeated: 0, failures: [{ action: "preview_table", code: "ACTION_EXECUTION_FAILED", count: 1, repaired: false, message: "No files found" }] }
};

describe("trajectory compressor client", () => {
  let server: Server | undefined;
  const saved = { ...process.env };
  afterEach(() => {
    server?.close();
    server = undefined;
    process.env = { ...saved };
  });

  const listen = async (status: number, body: unknown, seen: unknown[]): Promise<string> => {
    server = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => { data += chunk; });
      request.on("end", () => {
        seen.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(data) });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it("does nothing unless DF_TRAJECTORY_COMPRESSION=1", async () => {
    delete process.env.DF_TRAJECTORY_COMPRESSION;
    expect(await compressRun("run-1")).toBeUndefined();
  });

  it("posts the run id, budget and token, and reads the packet and digest", async () => {
    const seen: unknown[] = [];
    process.env.DF_TRAJECTORY_COMPRESSION = "1";
    process.env.COMPRESSOR_URL = `${await listen(200, REPLY, seen)}/`;
    process.env.COMPRESSOR_TOKEN = "t";
    process.env.COMPRESSOR_BUDGET = "4000";
    const result = await compressRun("run-1");
    expect(seen).toEqual([{ url: "/compress", auth: "Bearer t", body: { run_id: "run-1", budget: 4000 } }]);
    expect(result).toMatchObject({ runId: "run-1", tokens: 800, sourceTokens: 9000, budgetSatisfied: false, unrepaired: 1 });
    expect(result?.failures[0]).toEqual({ action: "preview_table", code: "ACTION_EXECUTION_FAILED", count: 1, repaired: false, message: "No files found" });
  });

  it("returns undefined when the service fails, so the run still completes", async () => {
    process.env.DF_TRAJECTORY_COMPRESSION = "1";
    process.env.COMPRESSOR_URL = await listen(500, { error: "broken" }, []);
    expect(await compressRun("run-1")).toBeUndefined();
    process.env.COMPRESSOR_URL = "http://127.0.0.1:9";
    expect(await compressRun("run-1")).toBeUndefined();
  });

  it("reads a reply with missing fields safely", () => {
    expect(parseCompressed("r", {})).toEqual({ runId: "r", text: "", tokens: 0, sourceTokens: 0, budgetSatisfied: true,
      archive: "", failures: [], unrepaired: 0, repeated: 0 });
  });
});
