import { describe, expect, it } from "vitest";

import { ContextPolicy } from "../../policy/context-policy.js";
import { boundStructuredValue } from "./base-tool-observation-adapter.js";
import { fitTablePreview, PreviewTableToolObservationAdapter } from "./data-tool-observation-adapters.js";

/** A wide preview full of quoted text, like mmc1 (179 columns): quotes are escaped again on budget checks. */
const widePreview = (columns: number, rows: number) => ({
  datasource_id: "bio",
  table: "mmc1",
  columns: Array.from({ length: columns }, (_, i) => `col_"${i}"`),
  rows: Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => `value "${r}-${c}" with "quotes"`)),
  row_count: rows,
  env_annotation: { note: "annotation", tables: { mmc1: { eligibility_flags: [{ column: "Case_excluded", keep_value: "'No'" }] } } }
});

const passesBudget = (raw: unknown, maxChars: number) => {
  const items = new PreviewTableToolObservationAdapter().toContextItems(raw, { maxChars });
  return () => new ContextPolicy().applyBudget(items, { maxChars }, (text) => text.length);
};

describe("preview_table observation", () => {
  it("fits an oversized preview as whole rows and columns, keeping the annotation", () => {
    const raw = widePreview(179, 20);
    expect(passesBudget(raw, 12000)).not.toThrow();
    const fitted = fitTablePreview(raw, 12000) as ReturnType<typeof widePreview> & {
      rows_shown: number;
      rows_omitted?: number;
      columns_omitted?: number;
    };
    expect(fitted.env_annotation).toEqual(raw.env_annotation);
    expect(fitted.rows_shown).toBeGreaterThanOrEqual(1);
    expect(fitted.rows_shown + (fitted.rows_omitted ?? 0)).toBe(20);
    expect(fitted.columns.length + (fitted.columns_omitted ?? 0)).toBe(179);
    fitted.rows.forEach((row) => expect(row).toHaveLength(fitted.columns.length));
  });

  it("drops rows before columns", () => {
    const fitted = fitTablePreview(widePreview(5, 400), 6000) as { columns: unknown[]; rows_omitted?: number };
    expect(fitted.columns).toHaveLength(5);
    expect(fitted.rows_omitted).toBeGreaterThan(0);
  });

  it("leaves a preview that fits unchanged", () => {
    const raw = widePreview(3, 2);
    expect(fitTablePreview(raw, 12000)).toBe(raw);
  });

  it("shortens very long cells", () => {
    const raw = { columns: ["note"], rows: [["x".repeat(5000)]] };
    const fitted = fitTablePreview(raw, 1000) as { rows: string[][] };
    expect(fitted.rows[0]?.[0]?.length).toBeLessThan(300);
  });
});

describe("generic bound", () => {
  it("measures the escaped wrapper, so a quote-heavy value never exceeds the budget", () => {
    const value = { text: Array.from({ length: 2000 }, (_, i) => `"q${i}"`).join(",") };
    const bounded = boundStructuredValue(value, 4000);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4000);
    expect(bounded).toMatchObject({ truncated: true });
  });
});
