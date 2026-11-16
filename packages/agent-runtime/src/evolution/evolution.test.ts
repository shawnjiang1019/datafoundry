import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ProtocolRunState } from "../protocol/types.js";
import { forbiddenTerms, lessonRejection, renderLessons, type Lesson } from "./lessons.js";
import { recordRunSignal, takeRunSignals } from "./run-signals.js";
import { parseLessonReply, RuntimeEvolution, runtimeEvolutionFromEnvironment } from "./runtime-evolution.js";
import { summarizeTrajectory, type TrajectorySummary } from "./trajectory.js";

const HARD_7 = "What was the difference in bacterial exceedance rates (to 2 decimal places) for marine beach samples "
  + "collected in 2023 between communities with more than 50% environmental justice (EJ) populations?";

const state = (domain: Record<string, unknown>, actions: unknown[] = []): ProtocolRunState => ({
  protocolId: "data-analysis",
  actions,
  domain: { decisions: [], queryAttempts: [], reportedClaims: [], ...domain }
}) as unknown as ProtocolRunState;

const summary = (runId: string, overrides: Partial<TrajectorySummary> = {}): TrajectorySummary => ({
  runId,
  question: HARD_7,
  finalAnswer: "0.11",
  committedValues: ["0.11"],
  decisions: [],
  queries: { executed: 4, evidenced: 2, notExecuted: 0 },
  failedActions: [],
  signals: [],
  flags: [],
  ...overrides
});

describe("trajectory summary", () => {
  it("flags a challenged answer that stayed the same, from the run alone (environment-hard-7)", () => {
    recordRunSignal("run-7", { source: "answer-form", answer: "0.11", detail: "below 1, the question asks for a rate" });
    const result = summarizeTrajectory({
      runId: "run-7",
      question: HARD_7,
      state: state({ reportedClaims: [{ values: [{ name: "difference", value: 0.11 }] }] }),
      finalText: "about 11 percentage points\nFINAL_ANSWER: 0.11",
      signals: takeRunSignals("run-7")
    });
    expect(result.finalAnswer).toBe("0.11");
    expect(result.flags).toContain("The answer-form check sent the agent back, and the final answer stayed the same.");
    expect(takeRunSignals("run-7")).toEqual([]);
  });

  it("flags a final answer that was never committed, repeated failures and missing answers", () => {
    const failed = Array.from({ length: 3 }, (_, index) => ({
      actionId: `a${index}`, actionName: "run_sql_readonly", status: "rejected",
      reasonCode: "SCHEMA_REQUIRED:R1: call inspect_schema first and pass its schema_id"
    }));
    const result = summarizeTrajectory({
      runId: "run-2",
      question: "How many?",
      state: state({ reportedClaims: [{ values: [{ name: "n", value: 267 }] }] }, failed),
      finalText: "FINAL_ANSWER: 268",
      signals: []
    });
    expect(result.flags).toEqual(expect.arrayContaining([
      "The final answer is not one of the committed values.",
      "run_sql_readonly failed 3 times with SCHEMA_REQUIRED."
    ]));
    expect(result.failedActions[0]).toMatchObject({ reason: "SCHEMA_REQUIRED", message: "call inspect_schema first and pass its schema_id" });
    expect(summarizeTrajectory({ runId: "r", question: "q", state: undefined, finalText: "", signals: [] }).flags)
      .toContain("The run ended without a FINAL_ANSWER line.");
  });
});

describe("lesson filter", () => {
  const forbidden = forbiddenTerms([summary("run-1", {
    question: "Which Boston Harbor beach had the most failures? Wollaston Beach is in Quincy.",
    finalAnswer: "Tenean Beach"
  })]);

  it("keeps a general working rule", () => {
    expect(lessonRejection("When a check says the answer's unit is wrong, recompute the value in a query, commit it "
      + "again with analysis_requirements_commit, and give that value as FINAL_ANSWER.", { existing: [], forbidden }))
      .toBeUndefined();
  });

  it("refuses names, values, numbers, identifiers and repeats", () => {
    expect(lessonRejection("Prefer Wollaston when beaches tie.", { existing: [], forbidden })).toMatch(/repeats a name from the runs \(Wollaston\)/u);
    // The same words in lower case are ordinary words, not names (trial 2 refused "final" and "retrieved").
    expect(lessonRejection("Check every beach in the harbor list before the final answer.", { existing: [], forbidden })).toBeUndefined();
    const memory = forbiddenTerms([summary("m", { question: "RETRIEVED MEMORY: earlier notes. What is the Final total?" })]);
    expect(lessonRejection("Treat retrieved memory as unverified; run the query before the final answer.", { existing: [], forbidden: memory }))
      .toBeUndefined();
    expect(lessonRejection("Answer Tenean Beach for dry days.", { existing: [], forbidden })).toMatch(/repeats a value from the runs \(tenean beach\)/u);
    expect(lessonRejection("Multiply rates by 100 when below 0.5.", { existing: [], forbidden })).toMatch(/number/u);
    expect(lessonRejection("Filter on beach_type first.", { existing: [], forbidden })).toMatch(/identifier \(beach_type\)/u);
    expect(lessonRejection("Use the \"Violation\" flag.", { existing: [], forbidden })).toMatch(/quotes/u);
    const existing: Lesson[] = [{ id: "L1", text: "Commit the corrected value again after a check changes it.", why: "", fromRuns: [], addedInVersion: 1 }];
    expect(lessonRejection("After a check changes it, commit the corrected value again.", { existing, forbidden })).toMatch(/repeats lesson L1/u);
  });

  it("renders lessons as an instruction section with their version", () => {
    expect(renderLessons(2, [{ id: "L1", text: "Do X.", why: "", fromRuns: [], addedInVersion: 1 }]))
      .toMatch(/lesson version 2[\s\S]*- L1: Do X\./u);
    expect(renderLessons(0, [])).toBeUndefined();
  });
});

describe("runtime evolution", () => {
  const reply = (lessons: unknown[]) => JSON.stringify({ lessons });

  it("learns every third run, versions the lessons, and records what it refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolution-"));
    const prompts: string[] = [];
    const evolution = new RuntimeEvolution({ dir, every: 3, log: () => undefined });
    const model = async (prompt: string) => {
      prompts.push(prompt);
      return `Here you go: ${reply([
        { text: "After a check sends you back, change the committed value too, not only the text.", why: "kept 0.11", from_runs: ["r3", "nope"] },
        { text: "Use Tenean Beach.", why: "bad", from_runs: ["r1"] }
      ])}`;
    };
    expect(await evolution.afterRun({ userId: "u1", summary: summary("r1"), model })).toEqual({ version: 0, evolved: false });
    expect(await evolution.afterRun({ userId: "u1", summary: summary("r2"), model })).toEqual({ version: 0, evolved: false });
    expect(prompts).toHaveLength(0);
    expect(await evolution.afterRun({ userId: "u1", summary: summary("r3", { finalAnswer: "Tenean Beach" }), model }))
      .toEqual({ version: 1, evolved: true });
    expect(prompts[0]).toMatch(/"run_id": "r1"[\s\S]*"run_id": "r3"/u);
    const current = evolution.current("u1");
    expect(current.version).toBe(1);
    expect(current.lessons).toEqual([expect.objectContaining({ id: "L1", fromRuns: ["r3"], addedInVersion: 1 })]);
    const file = JSON.parse(readFileSync(join(dir, "u1", "evolution.json"), "utf8"));
    expect(file.pending).toEqual([]);
    expect(file.versions[0].rejected).toEqual([{ text: "Use Tenean Beach.", reason: expect.stringMatching(/tenean beach/u) }]);
    expect(evolution.current("someone-else").version).toBe(0);
  });

  it("keeps runs pending when the model fails, and learns from them on the next run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolution-"));
    const evolution = new RuntimeEvolution({ dir, every: 2, log: () => undefined });
    const failing = async () => { throw new Error("rate limited"); };
    await evolution.afterRun({ userId: "u", summary: summary("a"), model: failing });
    expect(await evolution.afterRun({ userId: "u", summary: summary("b"), model: failing })).toEqual({ version: 0, evolved: false });
    const working = async () => reply([{ text: "Commit before writing the final answer.", why: "w", from_runs: ["a"] }]);
    expect(await evolution.afterRun({ userId: "u", summary: summary("c"), model: working })).toEqual({ version: 1, evolved: true });
    expect(evolution.current("u").lessons[0]?.fromRuns).toEqual(["a"]);
  });

  it("serializes runs that end together so none is lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolution-"));
    const evolution = new RuntimeEvolution({ dir, every: 3, log: () => undefined });
    const model = async () => reply([]);
    await Promise.all(["a", "b", "c"].map((id) => evolution.afterRun({ userId: "u", summary: summary(id), model })));
    const file = JSON.parse(readFileSync(join(dir, "u", "evolution.json"), "utf8"));
    expect(file.versions[0].fromRuns).toEqual(["a", "b", "c"]);
  });

  it("counts a follow-up turn in the same session as the same question, keeping its signals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolution-"));
    const evolution = new RuntimeEvolution({ dir, every: 2, log: () => undefined });
    const model = async () => reply([]);
    const signal = { source: "decision-outcomes", detail: "invariant claim" };
    await evolution.afterRun({ userId: "u", summary: summary("a", { sessionId: "s1", signals: [signal] }), model });
    // The runner's follow-up asks only for the FINAL_ANSWER line (environment-hard-12, trial 1).
    expect(await evolution.afterRun({ userId: "u", model,
      summary: summary("a2", { sessionId: "s1", question: "Give the FINAL_ANSWER line.", finalAnswer: "Wollaston Beach" }) }))
      .toEqual({ version: 0, evolved: false });
    const pending = JSON.parse(readFileSync(join(dir, "u", "evolution.json"), "utf8")).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ runId: "a2", question: HARD_7, finalAnswer: "Wollaston Beach", signals: [signal] });
    expect(await evolution.afterRun({ userId: "u", summary: summary("b", { sessionId: "s2" }), model }))
      .toEqual({ version: 1, evolved: true });
  });

  it("keeps the batch and the writer's reply in each version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evolution-"));
    const evolution = new RuntimeEvolution({ dir, every: 1, log: () => undefined });
    await evolution.afterRun({ userId: "u", summary: summary("a"), model: async () => "nothing to add" });
    const version = JSON.parse(readFileSync(join(dir, "u", "evolution.json"), "utf8")).versions[0];
    expect(version.batch.map((item: TrajectorySummary) => item.runId)).toEqual(["a"]);
    expect(version.reply).toBe("nothing to add");
  });

  it("is off unless enabled, and reads its settings from the environment", () => {
    expect(runtimeEvolutionFromEnvironment({}, "/d")).toBeUndefined();
    expect(runtimeEvolutionFromEnvironment({ DF_RUNTIME_EVOLUTION: "1", DF_EVOLUTION_EVERY: "3" }, "/d")).toEqual({ dir: "/d", every: 3 });
    expect(parseLessonReply("no json")).toEqual([]);
  });
});
