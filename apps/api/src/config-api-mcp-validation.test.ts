import { describe, expect, it } from "vitest";

import { validateMcpServerPayload } from "./config-api.js";

describe("MCP server registration check", () => {
  it("accepts a server the run resolver can connect to", () => {
    expect(() => validateMcpServerPayload("s", { transport: "streamable-http", serverUrl: "http://127.0.0.1:8080/mcp" }))
      .not.toThrow();
    expect(() => validateMcpServerPayload("s", { url: "http://x/mcp" })).not.toThrow();
    expect(() => validateMcpServerPayload("s", { transport: "stdio", command: "server --stdio" })).not.toThrow();
  });

  it("refuses a server with no URL, and settings nested under payload", () => {
    expect(() => validateMcpServerPayload("s", { transport: "streamable-http" })).toThrow(/^MCP_SERVER_URL_REQUIRED:s/u);
    expect(() => validateMcpServerPayload("s", { payload: { serverUrl: "http://x/mcp" } }))
      .toThrow(/^MCP_SERVER_PAYLOAD_NESTED:s/u);
    expect(() => validateMcpServerPayload("s", { transport: "stdio" })).toThrow(/^MCP_STDIO_COMMAND_REQUIRED:s/u);
  });
});
