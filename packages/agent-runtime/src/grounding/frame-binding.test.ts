import { describe, expect, it } from "vitest";

import { createUserAnalysisRequirements } from "../protocol/analysis-requirements.js";
import { createDataAnalysisProtocol, reduceDataAnalysisAction } from "../protocol/protocols/data-analysis.js";
import { fieldsNotPerUnit, missingWhereParts } from "../protocol/sql-semantic-validator.js";
import { renderAnswerFrame, resolveFrameChoice, type AnswerFrame } from "./answer-frame.js";

// Shaped like KramaBench biomedical: which serous samples count changes the answer.
const FRAME: AnswerFrame = {
  warnings: [],
  decisions: [{
    aspect: "population",
    questionPhrase: "patients with serous tumor samples",
    options: [
      {
        label: "any histologic type containing serous",
        table: "samples",
        sqlWhere: "\"Histologic_type\" ILIKE '%serous%'",
        keyColumns: ["pid"],
        rows: 14,
        units: 14,
        status: "checked"
      },
      {
        label: "exactly serous, cases not excluded",
        table: "samples",
        sqlWhere: "\"Histologic_type\" = 'Serous' AND (\"Case_excluded\" IS NULL OR \"Case_excluded\" = 'No')",
        keyColumns: ["pid"],
        rows: 12,
        units: 12,
        status: "checked"
      }
    ]
  }]
};

describe("answer frame binding", () => {
  it("adds ids only when binding is on, and resolves them back to the reading", () => {
    const advisory = renderAnswerFrame(FRAME) as { decisions: Array<Record<string, unknown>> };
    const bound = renderAnswerFrame(FRAME, { binding: true }) as { decisions: Array<{ id: string; options: Array<{ id: string }> }> };

    expect(advisory.decisions[0]).not.toHaveProperty("id");
    expect(bound.decisions[0]?.id).toBe("F1");
    expect(bound.decisions[0]?.options.map((option) => option.id)).toEqual(["F1.1", "F1.2"]);
    expect(resolveFrameChoice(FRAME, "F1.2")?.option.label).toBe("exactly serous, cases not excluded");
    expect(resolveFrameChoice(FRAME, "F1.3")).toBeUndefined();
  });

  describe("missingWhereParts", () => {
    const reading = { table: "samples", where: FRAME.decisions[0]?.options[1]?.sqlWhere as string };

    it("accepts the reading's WHERE however the query writes it", () => {
      expect(missingWhereParts(
        `SELECT AVG(s."Age") FROM samples s WHERE (s."case_excluded" IS NULL OR s."Case_excluded" = 'No') `
          + `AND s.histologic_type = 'Serous'`,
        "duckdb",
        reading
      )).toEqual([]);
      expect(missingWhereParts(
        `WITH serous AS (SELECT * FROM samples WHERE "Histologic_type" = 'Serous' `
          + `AND ("Case_excluded" IS NULL OR "Case_excluded" = 'No')) SELECT AVG("Age") FROM serous`,
        "duckdb",
        reading
      )).toEqual([]);
    });

    it("counts rows an aggregate selects for itself with FILTER or CASE WHEN", () => {
      const lowHumidity = { table: "fires", where: "\"avrh_mean\" < 30" };

      expect(missingWhereParts(
        "SELECT AVG(fatalities) FILTER (WHERE avrh_mean < 30) - AVG(fatalities) AS diff FROM fires",
        "duckdb",
        lowHumidity
      )).toEqual([]);
      expect(missingWhereParts(
        "SELECT SUM(CASE WHEN avrh_mean < 30 THEN fatalities ELSE 0 END) AS low FROM fires",
        "duckdb",
        lowHumidity
      )).toEqual([]);
    });

    it("names each part a query leaves out or changes", () => {
      expect(missingWhereParts(
        `SELECT AVG("Age") FROM samples WHERE "Histologic_type" ILIKE '%serous%'`,
        "duckdb",
        reading
      )).toEqual([
        "\"Histologic_type\" = 'Serous'",
        "(\"Case_excluded\" IS NULL OR \"Case_excluded\" = 'No')"
      ]);
    });
  });

  describe("protocol", () => {
    const requirements = createUserAnalysisRequirements([{
      kind: "metric",
      description: "Average age of serous patients",
      acceptanceCriteria: ["One number"],
      assertions: [{
        kind: "metric",
        description: "average age",
        sourceTables: ["samples"],
        claimValues: [{ name: "avg_age", field: "avg_age", required: true }]
      }]
    }]);
    const ANSWER = `SELECT AVG("Age") AS avg_age FROM samples`;
    const grounded = (binding: boolean, frame: AnswerFrame = FRAME) => {
      let state = createDataAnalysisProtocol([], requirements)
        .createInitialState({ contextPackageRef: { packageId: "p", revision: 0 }, runId: "run-frame" });
      state = reduceDataAnalysisAction(state, "inspect_schema", { schema_id: "s", tables: [{ name: "samples" }] });
      state = reduceDataAnalysisAction(state, "semantic.context.resolve", {
        mode: "live",
        trust: "verified",
        value: {
          evidence_grounding: {
            facts: [], candidates: [], duplicateTables: [], warnings: [], frame,
            ...(binding ? { binding: { frame: true } } : {})
          }
        }
      });
      return reduceDataAnalysisAction(state, "analysis.contract.ground", { requirements });
    };
    const plan = (state: ReturnType<typeof grounded>, sql: string, frameChoices?: string[]) =>
      reduceDataAnalysisAction(state, "data.query.plan", {
        sql,
        assertion_ids: ["R1.A1"],
        ...(frameChoices ? { frame_choices: frameChoices } : {})
      });
    const validate = (state: ReturnType<typeof grounded>) => reduceDataAnalysisAction(state, "data.query.validate", { valid: true });

    it("requires a known choice before a query that answers the question", () => {
      expect(() => plan(grounded(true), ANSWER)).toThrow(/ANALYSIS_FRAME_CHOICE_REQUIRED: .*F1\.1 .*F1\.2/u);
      expect(() => plan(grounded(true), ANSWER, ["F1.9"])).toThrow("ANALYSIS_FRAME_CHOICE_UNKNOWN:F1.9: valid ids are F1.1, F1.2.");
      expect(plan(grounded(false), ANSWER).frameChoices).toBeUndefined();
    });

    it("rejects SQL that skips the chosen rows and accepts SQL that selects them", () => {
      const skipped = validate(plan(grounded(true), ANSWER, ["F1.2"]));
      const applied = validate(plan(
        grounded(true),
        `${ANSWER} WHERE "Histologic_type" = 'Serous' AND ("Case_excluded" IS NULL OR "Case_excluded" = 'No')`,
        ["F1.2"]
      ));

      expect(skipped.frameChoices).toEqual(["F1.2"]);
      expect(skipped.currentQueryValidated).toBe(false);
      expect(skipped.queryAttempts.at(-1)?.validationFindings.map((finding) => finding.code))
        .toEqual(["SQL_SEMANTIC_FRAME_READING_MISSING:F1.2"]);
      expect(applied.currentQueryValidated).toBe(true);
    });

    it("rejects a value computed over repeated rows when the chosen unit is a distinct key", () => {
      const perPatient: AnswerFrame = {
        warnings: [],
        decisions: [{
          aspect: "unit",
          questionPhrase: "average age of patients",
          options: [
            { label: "one patient", table: "samples", sqlWhere: null, keyColumns: ["pid"], rows: 153, units: 123, status: "checked" },
            { label: "one sample row", table: "samples", sqlWhere: null, keyColumns: ["aliquot"], rows: 153, units: 153, status: "checked" }
          ]
        }]
      };
      const perRow = validate(plan(grounded(true, perPatient), ANSWER, ["F1.1"]));
      const perUnit = validate(plan(
        grounded(true, perPatient),
        `SELECT AVG(age) AS avg_age FROM (SELECT pid, ANY_VALUE("Age") AS age FROM samples GROUP BY pid) p`,
        ["F1.1"]
      ));
      const rowReading = validate(plan(grounded(true, perPatient), ANSWER, ["F1.2"]));

      expect(perRow.queryAttempts.at(-1)?.validationFindings.map((finding) => finding.code))
        .toEqual(["SQL_SEMANTIC_FRAME_UNIT_MISSING:F1.1"]);
      expect(perUnit.currentQueryValidated).toBe(true);
      expect(rowReading.currentQueryValidated).toBe(true);
    });

    it("leaves side checks the contract adds (non-metric assertions) out of frame binding", () => {
      const withSideCheck = createUserAnalysisRequirements([{
        kind: "metric",
        description: "Average age of serous patients",
        acceptanceCriteria: ["One number"],
        assertions: [{
          kind: "grain",
          description: "rows per patient",
          sourceTables: ["samples"],
          claimValues: [{ name: "rows", field: "rows", required: true }]
        }]
      }]);
      let state = createDataAnalysisProtocol([], withSideCheck)
        .createInitialState({ contextPackageRef: { packageId: "p", revision: 0 }, runId: "run-side" });
      state = reduceDataAnalysisAction(state, "inspect_schema", { schema_id: "s", tables: [{ name: "samples" }] });
      state = reduceDataAnalysisAction(state, "semantic.context.resolve", {
        mode: "live",
        trust: "verified",
        value: { evidence_grounding: { facts: [], candidates: [], duplicateTables: [], warnings: [], frame: FRAME, binding: { frame: true } } }
      });
      state = reduceDataAnalysisAction(state, "analysis.contract.ground", { requirements: withSideCheck });
      const checked = reduceDataAnalysisAction(
        reduceDataAnalysisAction(state, "data.query.plan", { sql: "SELECT COUNT(*) AS rows FROM samples", assertion_ids: ["R1.A1"] }),
        "data.query.validate",
        { valid: true }
      );

      expect(checked.currentQueryValidated).toBe(true);
    });

    it("keeps a choice for later queries, and a new choice replaces it", () => {
      const first = plan(grounded(true), ANSWER, ["F1.2"]);
      const later = plan(first, ANSWER);
      const changed = plan(first, ANSWER, ["F1.1"]);

      expect(later.frameChoices).toEqual(["F1.2"]);
      expect(changed.frameChoices).toEqual(["F1.1"]);
    });
  });

  describe("fieldsNotPerUnit", () => {
    const station = { keyColumns: ["NWS ID"], fields: ["avg_elevation"] };
    const JOINED = `WITH joined AS (SELECT r."NWS ID" AS nws, r."Elevation" AS elev FROM fires f `
      + `JOIN raws r ON CAST(r."NWS ID" AS BIGINT) = f.station_ref)`;

    it("flags an average over the joined rows even when a DISTINCT relation exists beside it", () => {
      // wildfire-hard-17, 2026-10-08: the per-station CTE was built, the per-fire average reported.
      const sql = `${JOINED}, stations AS (SELECT DISTINCT nws, elev FROM joined)
        SELECT (SELECT AVG(elev) FROM joined) AS avg_elevation, (SELECT AVG(elev) FROM stations) AS avg_alt,
               (SELECT COUNT(*) FROM joined) AS fire_rows FROM joined LIMIT 1`;

      expect(fieldsNotPerUnit(sql, "duckdb", { keyColumns: ["NWS ID"], fields: ["avg_elevation", "avg_alt", "fire_rows"] }))
        .toEqual(["avg_elevation"]);
    });

    it("accepts DISTINCT, GROUP BY (also by position) and COUNT(DISTINCT key) on the key", () => {
      expect(fieldsNotPerUnit(`${JOINED}, s AS (SELECT DISTINCT nws, elev FROM joined) SELECT AVG(elev) AS avg_elevation FROM s`,
        "duckdb", station)).toEqual([]);
      expect(fieldsNotPerUnit(`${JOINED} SELECT AVG(e) AS avg_elevation FROM (SELECT nws, ANY_VALUE(elev) AS e FROM joined GROUP BY 1) t`,
        "duckdb", station)).toEqual([]);
      expect(fieldsNotPerUnit(`${JOINED} SELECT COUNT(DISTINCT nws) AS stations FROM joined`,
        "duckdb", { keyColumns: ["NWS ID"], fields: ["stations"] })).toEqual([]);
    });

    it("follows a value read from a derived relation", () => {
      expect(fieldsNotPerUnit(`${JOINED}, agg AS (SELECT AVG(elev) AS a FROM joined) SELECT a AS avg_elevation FROM agg`,
        "duckdb", station)).toEqual(["avg_elevation"]);
    });

    it("does not judge a query it cannot parse or that names none of the fields", () => {
      expect(fieldsNotPerUnit("SELECT AVG(x) AS avg_elevation FROM t QUALIFY 1", "duckdb", station)).toBeUndefined();
      expect(fieldsNotPerUnit("SELECT AVG(x) AS other FROM t", "duckdb", station)).toBeUndefined();
    });
  });
});
