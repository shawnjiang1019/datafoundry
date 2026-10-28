import { describe, expect, it } from "vitest";

import { ContextBudgetAllocator } from "../../policy/context-budget-allocator.js";
import { ContextPolicy } from "../../policy/context-policy.js";
import { SchemaToolObservationAdapter } from "./schema-tool-observation-adapter.js";

const ROOM = 5000;
const allocator = new ContextBudgetAllocator({
  sourceLimitProfiles: { inspect_schema: { additionalMaxChars: ROOM, maxTables: 20, maxColumnsPerTable: 250 } }
});
const budget = () => allocator.allocate({ sourceType: "tool-observation", toolName: "inspect_schema" });

// 20 shown tables of 60 wide columns (~70k chars): larger than the shared cap, so the schema alone
// always fills its share.
const wideSchema = {
  datasource_id: "lake",
  schema_id: "schema_1",
  tables: Array.from({ length: 40 }, (_, t) => ({
    name: `table_${t}`,
    columns: Array.from({ length: 60 }, (__, c) => ({ name: `column_${c}_with_a_long_name`, type: "VARCHAR" }))
  }))
};

const modelContent = (items: ReturnType<SchemaToolObservationAdapter["toContextItems"]>) =>
  items.filter((item) => item.visibility === "model").map((item) => item.content) as Record<string, unknown>[];

describe("SchemaToolObservationAdapter with an annotation", () => {
  it("gives the annotation its own room, so a full schema plus a full annotation stays under the cap", () => {
    const annotation = { note: "n", tables: { table_0: { author_stated: ["x".repeat(ROOM - 200)] } } };
    const items = new SchemaToolObservationAdapter().toContextItems({ ...wideSchema, describe_tables: annotation }, budget());
    expect(() => new ContextPolicy().applyBudget(items, budget(), (text) => text.length / 4)).not.toThrow();
    const content = JSON.stringify(modelContent(items));
    expect(content).toContain("x".repeat(ROOM - 200));
    expect(budget().maxChars).toBeGreaterThan(ROOM);
  });

  it("replaces an annotation larger than its room with a pointer instead of failing", () => {
    const tooLarge = { note: "n", tables: { table_0: { author_stated: ["y".repeat(ROOM * 2)] } } };
    const items = new SchemaToolObservationAdapter().toContextItems({ ...wideSchema, env_annotation: tooLarge }, budget());
    expect(() => new ContextPolicy().applyBudget(items, budget(), (text) => text.length / 4)).not.toThrow();
    const content = JSON.stringify(modelContent(items));
    expect(content).not.toContain("y".repeat(100));
    expect(content).toContain("Call describe_tables");
  });

  it("leaves results without an annotation as before", () => {
    const items = new SchemaToolObservationAdapter().toContextItems(wideSchema, budget());
    expect(() => new ContextPolicy().applyBudget(items, budget(), (text) => text.length / 4)).not.toThrow();
    expect(JSON.stringify(modelContent(items))).not.toContain("env_annotation");
  });
});
