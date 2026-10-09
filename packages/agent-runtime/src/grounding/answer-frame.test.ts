import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUserAnalysisRequirements } from "../protocol/analysis-requirements.js";
import { groundingAutomaticActions, projectGroundedSchemaObservation } from "../protocol/data-analysis-hooks.js";
import { createDataAnalysisProtocol, reduceDataAnalysisAction } from "../protocol/protocols/data-analysis.js";
import { answerFramePrompt, buildAnswerFrame, renderAnswerFrame } from "./answer-frame.js";
import type { GroundingSchema, GroundingSqlProbe } from "./types.js";

type DuckConnection = { all(sql: string, callback: (error: Error | null, rows: Record<string, unknown>[]) => void): void };
type DuckDatabase = { connect(): DuckConnection; close(callback: (error: Error | null) => void): void };

let database: DuckDatabase;
let connection: DuckConnection;

const all = (sql: string): Promise<Record<string, unknown>[]> =>
  new Promise((resolve, reject) => connection.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))));

const probe: GroundingSqlProbe = async (sql) => {
  const rows = await all(sql);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((column) => row[column])) };
};

const schema: GroundingSchema = {
  dialect: "duckdb",
  tables: [
    { name: "loss_bands", columns: [{ name: "band", type: "VARCHAR" }, { name: "reports", type: "BIGINT" }] },
    {
      name: "samples",
      columns: [
        { name: "sample_id", type: "VARCHAR" },
        { name: "patient_id", type: "VARCHAR" },
        { name: "excluded", type: "VARCHAR" }
      ]
    }
  ]
};

const proposal = (decisions: unknown[]) => async () => JSON.stringify({ decisions });

beforeAll(async () => {
  const loaded = await import("duckdb") as unknown as { default?: { Database: new (path: string) => DuckDatabase } };
  const duckdb = (loaded.default ?? loaded) as { Database: new (path: string) => DuckDatabase };
  database = new duckdb.Database(":memory:");
  connection = database.connect();
  for (const statement of [
    "CREATE TABLE loss_bands (band VARCHAR, reports BIGINT)",
    "INSERT INTO loss_bands VALUES ('$0', 1613158), ('$1-$500', 516308), ('$501+', 471212)",
    "CREATE TABLE samples (sample_id VARCHAR, patient_id VARCHAR, excluded VARCHAR)",
    "INSERT INTO samples VALUES ('s1','p1','No'), ('s2','p1','No'), ('s3','p2','No'), ('s4','p3','Yes')"
  ]) {
    await all(statement);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => database.close(() => resolve()));
});

describe("buildAnswerFrame", () => {
  it("counts every reading in the data without choosing one", async () => {
    const frame = await buildAnswerFrame({
      question: "What proportion of fraud reporters lost between $1-$500?",
      schema,
      facts: [],
      probe,
      propose: proposal([{
        aspect: "denominator",
        question_phrase: "fraud reporters",
        options: [
          { label: "all reporters", table: "loss_bands", sql_where: null, key_columns: [] },
          { label: "reporters who lost money", table: "\"loss_bands\"", sql_where: "\"band\" <> '$0'", key_columns: [] }
        ]
      }])
    });

    expect(frame.decisions[0]?.options.map((option) => [option.label, option.rows, option.status])).toEqual([
      ["all reporters", 3, "checked"],
      ["reporters who lost money", 2, "checked"]
    ]);
  });

  it("counts distinct units when one row is not one unit", async () => {
    const frame = await buildAnswerFrame({
      question: "How many patients are in the study?",
      schema,
      facts: [],
      probe,
      propose: proposal([{
        aspect: "population",
        question_phrase: "in the study",
        options: [
          { label: "all samples", table: "samples", sql_where: null, key_columns: ["patient_id"] },
          { label: "not excluded", table: "samples", sql_where: "\"excluded\" = 'No'", key_columns: ["patient_id"] }
        ]
      }])
    });

    expect(frame.decisions[0]?.options.map((option) => [option.rows, option.units])).toEqual([[4, 3], [3, 2]]);
    expect(renderAnswerFrame(frame)).toMatchObject({
      decisions: [{
        aspect: "population",
        options: [
          { reading: "all samples", rows: 4, distinct_units: 3, note: "4 rows are 3 distinct units" },
          { reading: "not excluded", selects: "\"samples\" WHERE \"excluded\" = 'No'", rows: 3, distinct_units: 2 }
        ]
      }]
    });
  });

  it("flags a reading that selects nothing and drops one that cannot run", async () => {
    const frame = await buildAnswerFrame({
      question: "q",
      schema,
      facts: [],
      probe,
      propose: proposal([{
        aspect: "population",
        question_phrase: "used by",
        options: [
          { label: "wrong key", table: "samples", sql_where: "\"sample_id\" = 'missing'", key_columns: [] },
          { label: "bad sql", table: "samples", sql_where: "\"no_such_column\" = 1", key_columns: [] },
          { label: "unknown table", table: "nowhere", sql_where: null, key_columns: [] }
        ]
      }])
    });

    expect(frame.decisions[0]?.options.map((option) => option.status)).toEqual(["empty", "invalid", "invalid"]);
    expect(renderAnswerFrame(frame)).toMatchObject({
      decisions: [{ options: [{ reading: "wrong key", rows: 0, note: "matches no rows as written" }] }]
    });
  });

  it("shows nothing when every reading selects the same rows", async () => {
    const frame = await buildAnswerFrame({
      question: "q",
      schema,
      facts: [],
      probe,
      propose: proposal([{
        aspect: "unit",
        question_phrase: "reports",
        options: [
          { label: "rows", table: "loss_bands", sql_where: null, key_columns: [] },
          { label: "bands", table: "loss_bands", sql_where: "\"band\" IS NOT NULL", key_columns: [] }
        ]
      }])
    });

    expect(renderAnswerFrame(frame)).toBeUndefined();
  });

  it("retries an unusable proposal once, then degrades to a warning", async () => {
    let calls = 0;
    const flaky = async () => (calls += 1) === 1
      ? "{\"decisions\": [" // truncated output, as glm-5.3 returned once offline
      : JSON.stringify({ decisions: [] });
    await expect(buildAnswerFrame({ question: "q", schema, facts: [], probe, propose: flaky }))
      .resolves.toMatchObject({ decisions: [], warnings: ["ANSWER_FRAME_NO_DECISIONS"] });
    expect(calls).toBe(2);

    await expect(buildAnswerFrame({
      question: "q", schema, facts: [], probe, propose: async () => "not json"
    })).resolves.toMatchObject({ decisions: [], warnings: [expect.stringMatching(/^ANSWER_FRAME_PROPOSAL_FAILED/u)] });
  });

  it("reads the first JSON object when the model wraps it or adds prose after it", async () => {
    const decisions = [{
      aspect: "denominator",
      question_phrase: "reporters",
      options: [{ label: "all {braces} \"quoted\"", table: "loss_bands", sql_where: null, key_columns: [] }]
    }];
    const wrapped = async () =>
      `Here is the frame:\n\`\`\`json\n${JSON.stringify({ decisions })}\n\`\`\`\n{"note": "trailing object"}`;

    const frame = await buildAnswerFrame({ question: "q", schema, facts: [], probe, propose: wrapped });

    expect(frame.decisions[0]?.options[0]).toMatchObject({ label: "all {braces} \"quoted\"", rows: 3 });
  });

  it("shows at most three decisions, contradicted readings first", async () => {
    const decision = (aspect: string, where: string) => ({
      aspect,
      question_phrase: aspect,
      options: [
        { label: "all", table: "loss_bands", sql_where: null, key_columns: [] },
        { label: "some", table: "loss_bands", sql_where: where, key_columns: [] }
      ]
    });
    const frame = await buildAnswerFrame({
      question: "q", schema, facts: [], probe,
      propose: proposal([
        decision("unit", "\"band\" = '$0'"),
        decision("denominator", "\"band\" <> '$0'"),
        decision("population", "\"band\" = '$1-$500'"),
        decision("population", "\"band\" = 'none'")
      ])
    });

    expect((renderAnswerFrame(frame)?.decisions as Array<{ question_phrase: string; aspect: string }>)
      .map((item) => item.aspect)).toEqual(["population", "population", "denominator"]);
  });

  it("reaches the agent's schema view and the contract grounder through semantic resolution", async () => {
    const frame = await buildAnswerFrame({
      question: "q", schema, facts: [], probe,
      propose: proposal([{
        aspect: "denominator",
        question_phrase: "fraud reporters",
        options: [
          { label: "all reporters", table: "loss_bands", sql_where: null, key_columns: [] },
          { label: "reporters who lost money", table: "loss_bands", sql_where: "\"band\" <> '$0'", key_columns: [] }
        ]
      }])
    });
    const resolution = {
      value: { tables: [], evidence_grounding: { facts: [], candidates: [], duplicateTables: [], frame, warnings: [] } },
      capabilities: ["physical-schema", "evidence-grounding"],
      mode: "fallback"
    };
    const initial = createDataAnalysisProtocol([], createUserAnalysisRequirements([{
      kind: "metric", description: "Share of reporters", acceptanceCriteria: ["One proportion"]
    }])).createInitialState({ contextPackageRef: { packageId: "package-1", revision: 1 }, runId: "run-1" });
    const state = reduceDataAnalysisAction(initial, "semantic.context.resolve", resolution);
    const [contract] = groundingAutomaticActions({
      actionName: "semantic.context.resolve",
      domain: initial,
      input: { physicalSchema: { tables: [] }, datasourceRevision: "1" },
      rawResult: resolution
    }, { runId: "run-1", intentText: "q", tools: {}, getDomain: () => initial });

    expect(projectGroundedSchemaObservation({ tables: [] }, state)).toMatchObject({
      answer_frame: { decisions: [{ aspect: "denominator" }] }
    });
    expect(projectGroundedSchemaObservation({ tables: [] }, state)).not.toHaveProperty("grounded_relationships");
    expect(contract?.input).toMatchObject({
      semanticResolution: { value: { answer_frame: { decisions: [{ aspect: "denominator" }] } } }
    });
  });

  it("asks for readings, not an answer, and includes dictionary descriptions", () => {
    const prompt = answerFramePrompt("q", schema, [{
      subject: { table: "samples", column: "excluded" },
      text: "Yes when the case was removed from the study",
      source: { kind: "dictionary_table", ref: "dict.name = 'excluded'" },
      extractedBy: "deterministic"
    }]);

    expect(prompt).toContain("Do not pick one and do not say which is right.");
    expect(prompt).toContain("\"samples\".\"excluded\": Yes when the case was removed from the study");
  });
});
