import { describe, expect, it } from "vitest";

import { isLogScaleName, scaleNote } from "./scale-note.js";

describe("isLogScaleName", () => {
  it("finds log words in column names", () => {
    expect(isLogScaleName("Log2_variant_per_Mbp")).toBe(true);
    expect(isLogScaleName("logFC")).toBe(true);
    expect(isLogScaleName("expr_ln")).toBe(true);
  });

  it("ignores words that only contain the letters", () => {
    expect(isLogScaleName("catalog_id")).toBe(false);
    expect(isLogScaleName("Histologic_type")).toBe(false);
    expect(isLogScaleName("login_count")).toBe(false);
  });
});

describe("scaleNote", () => {
  it("notes a median taken over a log column", () => {
    const sql = "SELECT MEDIAN(Log2_variant_per_Mbp) AS median_final FROM t WHERE Histologic_type = 'Serous'";
    const note = scaleNote(sql, ["median_final"]);
    expect(note).toContain("Log2_variant_per_Mbp");
    expect(note).toContain("2^x");
    expect(note).toContain("Keep the log scale only when the question's own words ask");
    expect(note).toContain("A column's name, how the data is stored, or an unconfirmed assumption");
  });

  it("notes a result column named as log", () => {
    expect(scaleNote("SELECT sample, \"Log2_variant_per_Mbp\" FROM t", ["sample", "Log2_variant_per_Mbp"]))
      .toBeDefined();
  });

  it("is silent when the query converts back", () => {
    expect(scaleNote("SELECT MEDIAN(POWER(2, Log2_variant_per_Mbp)) AS m FROM t", ["m"])).toBeUndefined();
    expect(scaleNote("SELECT MEDIAN(2 ^ log2_expr) AS m FROM t", ["m"])).toBeUndefined();
    expect(scaleNote("SELECT AVG(EXP(ln_value)) AS m FROM t", ["m"])).toBeUndefined();
  });

  it("is silent for scale-free results", () => {
    expect(scaleNote("SELECT CORR(log2_a, log2_b) AS r FROM t", ["r"])).toBeUndefined();
    expect(scaleNote("SELECT COUNT(log2_a) AS n_rows FROM t", ["n_rows"])).toBeUndefined();
    expect(scaleNote("SELECT gene, RANK() OVER (ORDER BY log2fc) AS r FROM t", ["gene", "r"])).toBeUndefined();
  });

  it("is silent when the log column is only a filter", () => {
    expect(scaleNote("SELECT gene FROM t WHERE log2fc > 1", ["gene"])).toBeUndefined();
  });

  it("is silent when the agent applies log itself", () => {
    expect(scaleNote("SELECT AVG(LOG(price)) AS m FROM t", ["m"])).toBeUndefined();
  });

  it("ignores log words inside string literals", () => {
    expect(scaleNote("SELECT MEDIAN(value) AS m FROM t WHERE unit = 'log2'", ["m"])).toBeUndefined();
  });

  it("notes each column once per run", () => {
    const noted = new Set<string>();
    const sql = "SELECT MEDIAN(Log2_variant_per_Mbp) AS m FROM t";
    expect(scaleNote(sql, ["m"], noted)).toBeDefined();
    expect(scaleNote(sql, ["m"], noted)).toBeUndefined();
    expect(scaleNote("SELECT AVG(log10_dose) AS d FROM t", ["d"], noted)).toContain("log10_dose");
  });
});
