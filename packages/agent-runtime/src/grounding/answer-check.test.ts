import { describe, expect, it } from "vitest";

import { createAnswerCheck, finalAnswerSql } from "../protocol/answer-commit-check.js";
import type { DataAnalysisState } from "../protocol/protocols/data-analysis.js";
import type { ProtocolRunState } from "../protocol/types.js";
import type { AnswerFrame } from "./answer-frame.js";
import { checkAnswer } from "./answer-check.js";
import type { EvidenceGroundingContext } from "./types.js";

const QUESTION = "What is the average elevation of the weather stations used for fire site monitoring in the NOAA dataset?";
const LINK = "EXISTS (SELECT 1 FROM \"noaa_wildfires\" WHERE \"noaa_wildfires\".\"station_verified_in_psa\" = \"raws\".\"NWS ID\")";

const grounding = (frame: AnswerFrame, check = true): EvidenceGroundingContext => ({
  question: QUESTION, facts: [], candidates: [], duplicateTables: [], warnings: [], frame,
  ...(check ? { binding: { check: true as const } } : {})
});

// wildfire-hard-17 as the readings the data defines: every station, or the 759 the fire records refer to.
const LINKED: AnswerFrame = { warnings: [], decisions: [{
  aspect: "population", questionPhrase: "which raws rows count",
  options: [
    { label: "every row of raws", table: "raws", sqlWhere: null, keyColumns: [], rows: 2965, units: 2965, status: "checked" },
    { label: "only raws rows that noaa_wildfires refers to (verified link)", table: "raws", sqlWhere: LINK, keyColumns: [],
      rows: 759, units: 759, status: "checked", definedBy: { kind: "link", fromTable: "noaa_wildfires" } }
  ]
}] };

// biomedical: 9 of 153 rows are marked Case_excluded.
const FLAG: AnswerFrame = { warnings: [], decisions: [{
  aspect: "population", questionPhrase: "which clinical rows count (Case_excluded)",
  options: [
    { label: "every row of clinical", table: "clinical", sqlWhere: null, keyColumns: [], rows: 153, units: 153, status: "checked" },
    { label: "only rows not marked excluded by Case_excluded", table: "clinical", keyColumns: [], rows: 144, units: 144,
      sqlWhere: "(\"Case_excluded\" IS NULL OR TRIM(CAST(\"Case_excluded\" AS VARCHAR)) NOT IN ('Yes'))", status: "checked",
      definedBy: { kind: "flag", column: "Case_excluded" } }
  ]
}] };

// A model reading that ignores the question's words, beside one that applies them.
const WORDS: AnswerFrame = { warnings: [], decisions: [{
  aspect: "population", questionPhrase: "used for fire site monitoring",
  options: [
    { label: "all stations", table: "raws", sqlWhere: null, keyColumns: [], rows: 2965, units: 2965, status: "checked",
      unappliedWords: ["used for fire site monitoring"] },
    { label: "stations referenced by fire records", table: "raws", sqlWhere: LINK, keyColumns: [], rows: 759, units: 759,
      status: "checked", unappliedWords: [] }
  ]
}] };

describe("checkAnswer", () => {
  it("challenges an answer over every station when the question names the fire records and only 759 are linked", () => {
    const challenge = checkAnswer({ question: QUESTION, sql: "SELECT AVG(\"Elevation\") AS e FROM \"raws\"", grounding: grounding(LINKED) });

    expect(challenge?.code).toBe("LINKED_POPULATION_IGNORED");
    expect(challenge?.message).toContain("only 759 rows of raws");
    // Using the fire records at all, however the join is written, is not challenged.
    expect(checkAnswer({
      question: QUESTION,
      sql: "SELECT AVG(r.\"Elevation\") FROM raws r JOIN noaa_wildfires f ON f.station_verified_in_psa = r.\"NWS ID\"",
      grounding: grounding(LINKED)
    })).toBeUndefined();
    // A question that never mentions the fire records leaves the whole table alone.
    expect(checkAnswer({ question: "What is the average elevation of RAWS stations?", sql: "SELECT AVG(\"Elevation\") FROM raws", grounding: grounding(LINKED) }))
      .toBeUndefined();
  });

  it("challenges an answer that ignores an exclusion flag, and not one that uses it", () => {
    expect(checkAnswer({ question: "Average age of patients?", sql: "SELECT AVG(\"Age\") FROM clinical", grounding: grounding(FLAG) })?.code)
      .toBe("EXCLUSION_FLAG_IGNORED");
    expect(checkAnswer({
      question: "Average age of patients?",
      sql: "SELECT AVG(\"Age\") FROM clinical WHERE \"Case_excluded\" = 'No'",
      grounding: grounding(FLAG)
    })).toBeUndefined();
  });

  it("counts a flag as applied only where it picks rows, not where it is only listed", () => {
    const check = (sql: string) => checkAnswer({ question: "Average age of patients?", sql, grounding: grounding(FLAG) })?.code;

    // biomedical-easy-2, 2026-11-03: the final query listed Case_excluded and the answer averaged every row.
    expect(check("SELECT \"Proteomics_Participant_ID\", \"Age\", \"Case_excluded\" FROM clinical WHERE \"Histologic_type\" = 'Serous'"))
      .toBe("EXCLUSION_FLAG_IGNORED");
    expect(check("SELECT AVG(CASE WHEN \"Case_excluded\" = 'No' THEN \"Age\" END) FROM clinical")).toBeUndefined();
    expect(check("SELECT AVG(\"Age\") FROM clinical GROUP BY \"Case_excluded\" HAVING \"Case_excluded\" = 'No'")).toBeUndefined();
    expect(check("WITH kept AS (SELECT * FROM clinical WHERE \"Case_excluded\" <> 'Yes') SELECT AVG(\"Age\") FROM kept")).toBeUndefined();
    // Grouping by the flag splits the marked rows from the rest.
    expect(check("SELECT \"Case_excluded\", AVG(\"Age\") FROM clinical GROUP BY \"Case_excluded\"")).toBeUndefined();
    // A lookup that reads the flag of the row it answers from uses it (biomedical-hard-3, right at 60).
    expect(checkAnswer({ question: "What is the age of the patient with the lowest APP-Z score?",
      sql: "SELECT idx, \"Age\", \"Case_excluded\" FROM clinical WHERE idx = 'S019'", grounding: grounding(FLAG) })).toBeUndefined();
    // SQL the parser cannot read is judged by mention, so it is not challenged when it names the flag.
    expect(check("SELECT AVG(\"Age\") FROM clinical WHERE \"Case_excluded\" = 'No' QUALIFY 1 = 1 ;; garbage(")).toBeUndefined();
  });

  it("challenges the whole table when a reading that applies the question's words differs a lot", () => {
    const challenge = checkAnswer({ question: QUESTION, sql: "SELECT AVG(\"Elevation\") FROM raws", grounding: grounding(WORDS) });

    expect(challenge?.code).toBe("READING_IGNORES_QUESTION");
    expect(checkAnswer({ question: QUESTION, sql: `SELECT AVG("Elevation") FROM raws WHERE ${LINK}`, grounding: grounding(WORDS) }))
      .toBeUndefined();
  });

  it("stays silent on a query that does not read the table a reading is about", () => {
    expect(checkAnswer({ question: QUESTION, sql: "SELECT COUNT(*) FROM noaa_wildfires", grounding: grounding(LINKED) })).toBeUndefined();
    expect(checkAnswer({ question: QUESTION, sql: "SELECT 1", grounding: undefined })).toBeUndefined();
  });
});

describe("answer check hook", () => {
  const state = (sql: string | undefined, check = true): ProtocolRunState => ({
    protocolId: "data-analysis",
    status: "active",
    runId: "run-check",
    domain: {
      evidenceGrounding: grounding(LINKED, check),
      queryAttempts: sql ? [{ id: "Q1", sql, status: "evidenced" }] : [],
      requirements: []
    } as unknown as DataAnalysisState
  }) as unknown as ProtocolRunState;

  it("sends the agent back with the challenge, at most twice, and only in check mode", async () => {
    const hook = createAnswerCheck({ getState: () => state("SELECT AVG(\"Elevation\") FROM raws") });

    const first = await hook.run();
    expect(first.score).toBe(0);
    expect(first.reason).toMatch(/^LINKED_POPULATION_IGNORED: /u);
    expect((await hook.run()).score).toBe(0);
    expect(await hook.run()).toEqual({ score: 1 });
    expect(await createAnswerCheck({ getState: () => state("SELECT AVG(\"Elevation\") FROM raws", false) }).run()).toEqual({ score: 1 });
    expect(await createAnswerCheck({ getState: () => state(undefined) }).run()).toEqual({ score: 1 });
  });

  it("takes the last verified query as the one the answer came from", () => {
    const domain = { queryAttempts: [
      { id: "Q1", sql: "SELECT 1", status: "evidenced" },
      { id: "Q2", sql: "SELECT 2", status: "executed" },
      { id: "Q3", sql: "SELECT 3", status: "planned" }
    ] } as unknown as DataAnalysisState;

    expect(finalAnswerSql(domain)).toBe("SELECT 1");
  });
});
