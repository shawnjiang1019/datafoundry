import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { NotesToolError, type NotesTools } from "./tools.js";

/**
 * The notes tools over MCP. The descriptions are what a model reads to decide when to call each
 * tool, so they say when, not only what: ground first, check_answer before the final answer.
 */
export const createNotesMcpServer = (tools: NotesTools, datasources: string[]): McpServer => {
  const server = new McpServer({ name: "datafoundry-notes", version: "0.2.0" });
  const datasource = z.string().describe(`The data source to use. One of: ${datasources.join(", ") || "none configured"}.`);

  server.registerTool("ground", {
    description: "Call first, once per question. Returns facts about the data for this question, each checked "
      + "in the data (for example a join key that column names alone would miss), and a notes_id for the other tools.",
    inputSchema: {
      question: z.string().describe("The question, as asked."),
      datasource,
      show_readings: z.boolean().optional().describe("Also return readings of the question with row counts. Off by default.")
    }
  }, async (input) => respond(() => tools.ground(input)));

  server.registerTool("run_sql", {
    description: "Run one read-only SQL query (DuckDB). Pass the notes_id from ground so the query is checked "
      + "against the notes first: a join the data proved wrong is blocked, other problems come back with the rows. "
      + "Large results are cut to the first rows that fit (see truncated); filter or aggregate to see more.",
    inputSchema: {
      sql: z.string().describe("One SELECT or WITH statement."),
      notes_id: z.string().optional().describe("From ground. Without it the query runs unchecked."),
      datasource: datasource.optional()
    }
  }, async (input) => respond(() => tools.runSql(input)));

  server.registerTool("check_sql", {
    description: "Optional: check a query against the notes without running it. Advice only.",
    inputSchema: { notes_id: z.string(), sql: z.string() }
  }, async (input) => respond(() => tools.checkSql(input)));

  server.registerTool("check_answer", {
    description: "Call before giving your final answer. Checks the query your answer came from against facts "
      + "verified in the data. Returns ok, or one challenge: if challenged, recompute and call again.",
    inputSchema: {
      notes_id: z.string(),
      answer: z.string().optional().describe("Your final answer."),
      final_sql: z.string().optional().describe("The query the answer came from. Defaults to the last query run through run_sql.")
    }
  }, async (input) => respond(() => tools.checkAnswer(input)));

  return server;
};

const respond = async (call: () => Promise<unknown>): Promise<CallToolResult> => {
  try {
    const result = await call();
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  } catch (error) {
    if (error instanceof NotesToolError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
};
