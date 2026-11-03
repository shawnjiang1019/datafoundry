#!/usr/bin/env node
/**
 * Stop hook: Claude may finish a data answer only after the notes service's check_answer has
 * approved the last query it ran. This is the "runner enforces the double-check" integration
 * (level C), done the Claude Code way.
 *
 * The notes are held by the MCP server Claude Code started, so this hook does not call the
 * service. It reads the session transcript instead: if Claude ran queries through run_sql and
 * no check_answer after the last one said ok, it blocks the stop and says why. The service
 * allows two challenges per question, then returns ok, so this ends; as a backstop the hook
 * also lets Claude stop after MAX_BLOCKS blocks in one session.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = "mcp__notes__";
const MAX_BLOCKS = 2;

const input = JSON.parse(readFileSync(0, "utf8"));
const allow = () => process.exit(0);
const block = (reason) => {
  const counter = join(tmpdir(), `notes-stop-hook-${input.session_id}.count`);
  let blocks = 0;
  try { blocks = Number(readFileSync(counter, "utf8")) || 0; } catch { /* first block */ }
  if (blocks >= MAX_BLOCKS) allow();
  writeFileSync(counter, String(blocks + 1));
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
};

// The transcript, in order: each tool call and, by id, the text of its result.
const calls = [];
const results = new Map();
for (const line of readFileSync(input.transcript_path, "utf8").split("\n")) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const part of content) {
    if (part.type === "tool_use") calls.push({ id: part.id, name: part.name });
    if (part.type === "tool_result") {
      const text = typeof part.content === "string"
        ? part.content
        : (part.content ?? []).map((piece) => piece.text ?? "").join("");
      results.set(part.tool_use_id, text);
    }
  }
}

const lastQuery = calls.findLastIndex((call) => call.name === `${TOOL}run_sql`);
if (lastQuery < 0) allow(); // not a data answer through the notes
const check = calls.slice(lastQuery + 1).findLast((call) => call.name === `${TOOL}check_answer`);
if (!check) {
  block("Before you finish, call check_answer with your notes_id, your answer and final_sql "
    + "(the query your answer came from). It checks the answer against facts verified in the data.");
}
let verdict;
try { verdict = JSON.parse(results.get(check.id) ?? "{}"); } catch { verdict = {}; }
if (verdict.status === "challenge") {
  block(`check_answer challenged your answer: ${verdict.message} `
    + "If this applies to the question, recompute, then call check_answer again on the new query.");
}
allow();
