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
    { clause: "Histology 'serous' selects serous tumors", term: "serous" },
    { clause: "Each row is one sample", term: "sample" },
    { clause: "Excluded cases should be removed", term: "excluded", residual: "whether to drop them" },
    { clause: "Mutation burden is in variants per Mbp", term: "burden" },
    { clause: "Join on participant id", term: "participant" }
  ],
  trees: [
    { status: "confirmed", claim: leaf("value_presence", { table: "mmc1", column: "Histologic_type", value: "serous" }) },
    { status: "refuted", claim: leaf("grain", { table: "mmc1", column: "Proteomics_Participant_ID" }) },
    {
      status: "partial",
      residual: "whether excluded cases should be dropped",
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
    { status: "text_only", residual: "unit not stated", claim: null },
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
  it("renders open items by urgency, then collapses confirmed ones", () => {
    const text = createAssumptionLedgerText(receipt);
    const lines = text.split("\n");

    expect(lines[0]).toBe("Assumption ledger (checked against the data before you started):");
    expect(lines.slice(1, 6).map((line) => line.match(/^- \[(\w+)\]/)?.[1])).toEqual([
      "refuted", "partial", "text_only", "assumed", "confirmed"
    ]);
    expect(lines[1]).toBe("- [refuted] Each row is one sample — grain(mmc1.Proteomics_Participant_ID)");
    expect(lines[2]).toBe(
      "- [partial] Excluded cases should be removed — column_presence(mmc1.Case_excluded); "
        + "value_presence(mmc1.Case_excluded='Yes' where Type='Tumor'); open: whether excluded cases should be dropped"
    );
    expect(lines[3]).toBe("- [text_only] Mutation burden is in variants per Mbp; open: unit not stated");
    expect(lines[4]).toBe("- [assumed] Join on participant id — join_key(left=a.id, right=b.id)");
    expect(lines[5]).toBe("- [confirmed] 1 assumption holds: Histology 'serous' selects serous tumors");
    expect(lines.at(-1)).toMatch(/^Before committing an answer, state how your analysis handles every refuted/);
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
    const text = createAssumptionLedgerText(receipt, 400);

    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toMatch(/^Assumption ledger/);
    expect(text).toContain("[refuted]");
    expect(text).toMatch(/\[assumption ledger truncated: \d of 5 items omitted\]/);
    expect(text).toMatch(/text_only item\.$/);
  });

  it("uses the smaller of its own cap and the source budget", () => {
    const [item] = new AssumptionLedgerContextSource({ receipt }).collect(sourceInput(400));
    expect(String(item?.content).length).toBeLessThanOrEqual(400);
  });

  it("contributes nothing for an empty or malformed receipt", () => {
    const source = new AssumptionLedgerContextSource({ receipt: { trees: [null, { claim: {} }] } });
    expect(source.collect(sourceInput())).toEqual([]);
  });

  it("registers alongside other runtime sources", () => {
    const registry = createDefaultRuntimeContextSourceRegistry({
      additionalSources: [new AssumptionLedgerContextSource({ receipt })]
    });
    expect(registry.list().map((source) => source.sourceType)).toEqual(["assumption-ledger"]);
  });
});
