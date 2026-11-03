#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { duckDbDatasource, type NotesDatasource } from "./datasource.js";
import { createNotesMcpServer } from "./mcp.js";
import { createNotesTools } from "./tools.js";

const USAGE = "Usage: datafoundry-notes-mcp --data <name>=<path to .duckdb> [--data ...] [--max-challenges <n>]";

/** Reads `--data name=path` (repeatable) and `--max-challenges n`. */
export const parseArgs = (argv: string[]): { datasources: Record<string, NotesDatasource>; maxChallenges?: number } => {
  const datasources: Record<string, NotesDatasource> = {};
  let maxChallenges: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--data" && value) {
      const split = value.indexOf("=");
      if (split <= 0) throw new Error(`--data expects <name>=<path>, got "${value}". ${USAGE}`);
      datasources[value.slice(0, split)] = duckDbDatasource(resolve(value.slice(split + 1)));
      index += 1;
    } else if (flag === "--max-challenges" && value) {
      maxChallenges = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}". ${USAGE}`);
    }
  }
  if (Object.keys(datasources).length === 0) throw new Error(`At least one --data is required. ${USAGE}`);
  return { datasources, ...(maxChallenges !== undefined ? { maxChallenges } : {}) };
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const server = createNotesMcpServer(createNotesTools(options), Object.keys(options.datasources));
  // stdout carries the MCP protocol; anything for people goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(`[notes-mcp] ready: ${Object.keys(options.datasources).join(", ")}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[notes-mcp] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
