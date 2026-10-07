import { describe, expect, it } from "vitest";

import { ContextPackageBuilder } from "../inventory/context-package-builder.js";
import { ContextPromptMaterializer } from "../projection/context-prompt-materializer.js";
import {
  AssumptionLedgerContextSource,
  createAssumptionLedgerText,
  type AssumptionReceipt
} from "./assumption-ledger-context-source.js";
import { createDefaultRuntimeContextSourceRegistry } from "./runtime-context-source-boundary.js";

const leaf = (kind: string, expects: Record<string, unknown>) => ({
  op: null,
  left: null,
  right: null,
  atom: { id: `a-${kind}`, kind, expects, pins: { resolved: true }, prose: "" }
});

const receipt: AssumptionReceipt = {
  task_id: "task_1",
  assumptions: [
    { clause: "Histology 'serous' selects serous tumors", term: "serous", impact: "high" },
    { clause: "Each row is one sample", term: "sample", impact: "medium" },
    { clause: "Excluded cases should be removed", term: "excluded", impact: "high" },
    { clause: "Mutation burden is in variants per Mbp", term: "burden", impact: "low" },
    { clause: "Join on participant id", term: "participant", impact: "medium" }
  ],
  trees: [
    { status: "confirmed", claim: leaf("value_presence", { table: "mmc1", column: "Histologic_type", value: "serous" }) },
    { status: "refuted", claim: leaf("grain", { table: "mmc1", column: "Proteomics_Participant_ID" }) },
    {
      status: "partial",
      residual: "Should rows with Case_excluded='Yes' be dropped?",
      claim: {
        op: "and",
        atom: null,
        left: leaf("column_presence", { table: "mmc1", column: "Case_excluded" }),
        right: leaf("value_presence", {
          table: "mmc1",
          column: "Case_excluded",
          value: "Yes",
          where: { column: "Type", value: "Tumor" }
        })
      }
    },
    { status: "text_only", residual: "unit not stated", claim: leaf("value_presence", { column: "sample", value: "x" }) },
    { status: "assumed", claim: leaf("join_key", { left: "a.id", right: "b.id" }) }
  ],
  summary: { total: 5, confirmed: 1, refuted: 1, partial: 1, assumed: 1, text_only: 1 }
};

const sourceInput = (maxChars?: number) => ({
  budget: { ...(maxChars !== undefined ? { maxChars } : {}) },
  runId: "run-1",
  sessionId: "session-1",
  userId: "user-1"
});

describe("AssumptionLedgerContextSource", () => {
  it("renders unconfirmed items as open decisions, highest impact first; confirmed items are left out", () => {
    const text = createAssumptionLedgerText(receipt);
    const heads = text.split("\n").filter((line) => /^D\d+ /u.test(line));

    expect(text).toMatch(/^Open analysis decisions:/u);
    expect(heads.map((line) => line.match(/^(D\d+) \[impact (\w+)/u)?.slice(1, 3))).toEqual([
      ["D2", "high"], ["D1", "medium"], ["D4", "medium"], ["D3", "low"]
    ]);
    expect(text).not.toContain("Histology 'serous'");
    expect(text).toContain(
      "D2 [impact high; partly checked] Decide: Should rows with Case_excluded='Yes' be dropped?\n"
        + "   hypothesis (unconfirmed): Excluded cases should be removed\n"
        + "   check ran (result not reported): column_presence(mmc1.Case_excluded)"
    );
    expect(text).toContain("D1 [impact medium; contradicted by a check] Decide: Does this hold for this question: "
      + "Each row is one sample?");
    expect(text).toMatch(/High-impact decisions must be recorded before the run can finish\.$/u);
  });

  it("shows confidence and code-written check statements, and no checks for text_only items", () => {
    const text = createAssumptionLedgerText({
      assumptions: [
        { clause: "The table covers all serous tumor samples of the study", impact: "high" },
        { clause: "Flagged rows enter the median" }
      ],
      trees: [
        {
          status: "partial",
          scalar: { confidence: 0.5 },
          residual: "Is every row in the study cohort?",
          claim: leaf("coverage", { table: "mmc1", column: "Histologic_type" }),
          checks: [{ status: "confirmed", statement: "mmc1.Histologic_type is non-null in 104/104 rows" }]
        },
        {
          status: "text_only",
          scalar: { confidence: 0 },
          claim: leaf("column_presence", { column: "Case_excluded" })
        }
      ]
    });

    expect(text).toContain(
      "D1 [impact high; partly checked, confidence 0.50] Decide: Is every row in the study cohort?\n"
        + "   hypothesis (unconfirmed): The table covers all serous tumor samples of the study\n"
        + "   check passed: mmc1.Histologic_type is non-null in 104/104 rows"
    );
    expect(text).toContain("D2 [impact medium; not checked, confidence 0.00] Decide: Does this hold for this "
      + "question: Flagged rows enter the median?\n   hypothesis (unconfirmed): Flagged rows enter the median\n");
    expect(text).not.toContain("column_presence");
  });

  it("emits one mandatory, model-visible item that the prompt planner keeps", () => {
    const items = new AssumptionLedgerContextSource({ receipt }).collect(sourceInput());

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceType: "assumption-ledger",
      visibility: "model",
      trust: "tool",
      retention: "mandatory",
      metadata: { dedupeKeys: ["assumption-ledger"], exclusivityKey: "assumption-ledger", dtrailTaskId: "task_1" }
    });
    const contextPackage = new ContextPackageBuilder().build(items, { runId: "run-1", sessionId: "session-1" });
    const groups = new ContextPromptMaterializer().createGroups({ contextPackage });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ mandatory: true, retention: "mandatory" });
  });

  it("truncates within the budget but keeps the header and the closing instruction", () => {
    const text = createAssumptionLedgerText(receipt, 1100);

    expect(text.length).toBeLessThanOrEqual(1100);
    expect(text).toMatch(/^Open analysis decisions:/u);
    expect(text).toContain("D2 [impact high");
    expect(text).toMatch(/\[assumption ledger truncated: \d of 4 items omitted\]/u);
    expect(text).toMatch(/before the run can finish\.$/u);
  });

  it("uses the smaller of its own cap and the source budget", () => {
    const [item] = new AssumptionLedgerContextSource({ receipt }).collect(sourceInput(400));
    expect(String(item?.content).length).toBeLessThanOrEqual(400);
  });

  it("contributes nothing for an empty, malformed or fully confirmed receipt", () => {
    expect(new AssumptionLedgerContextSource({ receipt: { trees: [null, { claim: {} }] } })
      .collect(sourceInput())).toEqual([]);
    expect(new AssumptionLedgerContextSource({ receipt: { trees: [{ status: "confirmed", claim: null }] } })
      .collect(sourceInput())).toEqual([]);
  });

  it("registers alongside other runtime sources", () => {
    const registry = createDefaultRuntimeContextSourceRegistry({
      additionalSources: [new AssumptionLedgerContextSource({ receipt })]
    });
    expect(registry.list().map((source) => source.sourceType)).toEqual(["assumption-ledger"]);
  });
});
