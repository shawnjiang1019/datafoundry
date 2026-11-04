import { describe, expect, it } from "vitest";

import { checkAnswer } from "./answer-check.js";
import { definedMeasures, namedMeasures } from "./defined-measures.js";
import type { EvidenceGroundingContext, GroundingSchema, GroundingSqlProbe } from "./types.js";

// Shaped like the KramaBench biomedical and legal lakes (biomedical-hard-3, legal-hard-17).
const schema: GroundingSchema = {
  dialect: "duckdb",
  tables: [
    { name: "apm_subtypes", columns: [{ name: "idx", type: "VARCHAR" }, { name: "APP_Z_score", type: "DOUBLE" }] },
    { name: "clinical", columns: [{ name: "idx", type: "VARCHAR" }, { name: "Age", type: "DOUBLE" }, { name: "Tumor_Size_cm", type: "DOUBLE" }] },
    { name: "report_categories", columns: [
      { name: "Rank", type: "VARCHAR" }, { name: "Category", type: "VARCHAR" },
      { name: "# of Reports", type: "VARCHAR" }, { name: "Percentage", type: "VARCHAR" }
    ] },
    { name: "categories_over_years", columns: [
      { name: "Year", type: "VARCHAR" }, { name: "Category", type: "VARCHAR" },
      { name: "# of Reports", type: "VARCHAR" }, { name: "Percentage", type: "VARCHAR" }
    ] },
    { name: "losses_by_age", columns: [{ name: "Age Range", type: "VARCHAR" }, { name: "Percentage Reporting $ Loss", type: "VARCHAR" }] }
  ]
};

const probe: GroundingSqlProbe = async (sql) => {
  if (sql.includes("\"report_categories\"") && sql.includes("\"Category\"")) {
    return { columns: ["label", "value"], rows: [["Identity Theft", "17.54%"], ["Auto Related", "2.28%"], ["Imposter Scams", "13.07%"]] };
  }
  if (sql.includes("\"categories_over_years\"") && sql.includes("\"Category\"")) {
    return { columns: ["label", "value"], rows: [["Auto Related", "2.28%"], ["Auto Related", "2.10%"], ["Identity Theft", "17.54%"]] };
  }
  return { columns: ["label", "value"], rows: [] };
};

const LEGAL_17 = "If the 2007 report category distribution were exactly like the 2024 ones, how many reports in 2007 would be Auto Related?";
const BIO_3 = "What is the age of the patient with the lowest APP-Z score?";

const grounding = (measures: EvidenceGroundingContext["measures"]): EvidenceGroundingContext =>
  ({ facts: [], candidates: [], duplicateTables: [], warnings: [], ...(measures ? { measures } : {}) });

describe("defined measures", () => {
  it("finds a numeric column the question names outright, and not a plain attribute", () => {
    expect(namedMeasures(BIO_3, schema)).toEqual([{ kind: "named", table: "apm_subtypes", column: "APP_Z_score", phrase: "app z score" }]);
    // "age" is named too, but it is one word and no measure word: an attribute, not a measure.
    expect(namedMeasures("What is the average tumor size?", schema)).toEqual([]);
  });

  it("finds a stated share for a category the question names, with its value only when unique", async () => {
    const measures = await definedMeasures({ question: LEGAL_17, schema, probe });

    expect(measures).toEqual([
      { kind: "share", table: "report_categories", column: "Percentage", labelColumn: "Category", label: "Auto Related", value: "2.28%" },
      // One row per year: the share is noted, its value is not.
      { kind: "share", table: "categories_over_years", column: "Percentage", labelColumn: "Category", label: "Auto Related" }
    ]);
    // "Percentage Reporting $ Loss" is a different measure, not a stated share.
    expect(measures.some((measure) => measure.table === "losses_by_age")).toBe(false);
  });

  it("challenges an answer that computes the measure itself, and not one that reads it", async () => {
    const legal = grounding(await definedMeasures({ question: LEGAL_17, schema, probe }));
    const computed = "SELECT ROUND(t2007 * a.n / s.total) FROM (SELECT CAST(REPLACE(\"# of Reports\", ',', '') AS BIGINT) AS n "
      + "FROM categories_over_years WHERE \"Year\" = '2024' AND \"Category\" = 'Auto Related') a, totals s";

    expect(checkAnswer({ question: LEGAL_17, sql: computed, grounding: legal })).toMatchObject({
      code: "DEFINED_MEASURE_IGNORED", evidence: { table: "report_categories", value: "2.28%" }
    });
    expect(checkAnswer({ question: LEGAL_17, sql: "SELECT \"Percentage\" FROM report_categories WHERE \"Category\" = 'Auto Related'", grounding: legal }))
      .toBeUndefined();
    // A query about another category is not challenged for this one.
    expect(checkAnswer({ question: LEGAL_17, sql: "SELECT COUNT(*) FROM report_categories WHERE \"Category\" = 'Imposter Scams'", grounding: legal }))
      .toBeUndefined();

    const bio = grounding(namedMeasures(BIO_3, schema));
    expect(checkAnswer({ question: BIO_3, sql: "SELECT idx, (v - AVG(v) OVER ()) / STDDEV(v) OVER () AS z FROM app ORDER BY z LIMIT 1", grounding: bio })?.code)
      .toBe("DEFINED_MEASURE_IGNORED");
    expect(checkAnswer({ question: BIO_3, sql: "SELECT idx FROM apm_subtypes ORDER BY APP_Z_score LIMIT 1", grounding: bio })).toBeUndefined();
  });
});
