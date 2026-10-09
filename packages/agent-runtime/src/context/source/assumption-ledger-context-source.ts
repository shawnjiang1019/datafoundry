import {
  createDecisionsFromReceipt,
  type AnalysisDecision,
  type AssumptionReceipt
} from "../../protocol/analysis-decisions.js";
import { createContextItem, type ContextItem } from "../inventory/context-item.js";
import { createContextSourceMetadata } from "../inventory/context-source-metadata.js";
import type { RuntimeContextSource, RuntimeContextSourceInput } from "./runtime-context-source.js";

export type { AssumptionReceipt } from "../../protocol/analysis-decisions.js";

const DEFAULT_MAX_LEDGER_CHARS = 6000;
const LEVEL_LABELS: Record<string, string> = {
  refuted: "contradicted by a check",
  partial: "partly checked",
  text_only: "not checked",
  assumed: "checks inconclusive"
};
const IMPACT_ORDER = ["high", "medium", "low"] as const;
const LEDGER_HEADER =
  "Open analysis decisions: choices this answer depends on that the data has not settled, found before you "
  + "started. Each hypothesis is UNCONFIRMED and is not a rule; only \"check passed\" lines are facts, and only "
  + "for the exact rows and columns they name.";
const LEDGER_FOOTER =
  "Resolve each decision from the data and the task wording with analysis_decision_record (choice + basis). Where "
  + "readings are listed, work through each against the exact question words before choosing; a reading that "
  + "narrows those words needs evidence. If the evidence does not settle it, record status \"undecided\": it does "
  + "not block the run, and the final answer must list it as NOT CONFIRMED with the reading used. Cite "
  + "decision_ids on every run_sql_readonly call that applies a choice. High-impact decisions must be recorded "
  + "before the run can finish.";

export type AssumptionLedgerContextSourceOptions = {
  receipt: AssumptionReceipt;
  maxChars?: number;
};

export class AssumptionLedgerContextSource implements RuntimeContextSource {
  readonly sourceType = "assumption-ledger";

  constructor(private readonly options: AssumptionLedgerContextSourceOptions) {}

  collect(input: RuntimeContextSourceInput): ContextItem[] {
    if (createDecisionsFromReceipt(this.options.receipt).length === 0) {
      return [];
    }
    const maxChars = Math.min(
      this.options.maxChars ?? DEFAULT_MAX_LEDGER_CHARS,
      input.budget.maxChars ?? DEFAULT_MAX_LEDGER_CHARS
    );
    const taskId = this.options.receipt.task_id;
    return [
      createContextItem({
        id: "assumption-ledger",
        sourceType: this.sourceType,
        sourceId: "dtrail-assumptions",
        groupId: "assumption-ledger",
        visibility: "model",
        trust: "tool",
        retention: "mandatory",
        priority: 90,
        content: createAssumptionLedgerText(this.options.receipt, maxChars),
        metadata: createContextSourceMetadata({
          dedupeKeys: ["assumption-ledger"],
          exclusivityKey: "assumption-ledger",
          scope: { sessionId: input.sessionId, userId: input.userId },
          sourceKind: "assumption-ledger",
          sourceOwner: "dtrail"
        }, {
          atomic: true,
          groupKind: "source",
          ...(typeof taskId === "string" ? { dtrailTaskId: taskId } : {})
        })
      })
    ];
  }
}

/** Render the receipt's open decisions, highest impact first, with their unconfirmed hypotheses and checks. */
export const createAssumptionLedgerText = (
  receipt: AssumptionReceipt,
  maxChars = DEFAULT_MAX_LEDGER_CHARS
): string => {
  const decisions = createDecisionsFromReceipt(receipt);
  const ordered = IMPACT_ORDER.flatMap((impact) => decisions.filter((decision) => decision.impact === impact));
  return fitLines(ordered.map(renderDecision), maxChars);
};

const renderDecision = (decision: AnalysisDecision): string => {
  const level = decision.level ? `; ${LEVEL_LABELS[decision.level] ?? decision.level}` : "";
  const confidence = decision.confidence === undefined ? "" : `, confidence ${decision.confidence.toFixed(2)}`;
  return [
    `${decision.id} [impact ${decision.impact}${level}${confidence}] Decide: ${decision.question}`,
    ...(decision.hypothesis ? [`   hypothesis (unconfirmed): ${decision.hypothesis}`] : []),
    ...decision.checks.map((check) => `   ${check}`),
    ...(decision.resolution ? renderResolution(decision.resolution) : [])
  ].join("\n");
};

/** The independent resolver's reading: the quoted words, every reading, and whether it is settled. */
const renderResolution = (resolution: NonNullable<AnalysisDecision["resolution"]>): string[] => [
  resolution.status === "undecided"
    ? "   resolver: UNDECIDED — NOT CONFIRMED; choose a reading below and record it as \"undecided\" unless evidence settles it"
    : `   resolver: favours reading ${resolution.recommended + 1} (confidence ${resolution.confidence}); still unconfirmed`,
  ...(resolution.quote ? [`   question words: "${resolution.quote}"${resolution.quoteVerified ? "" : " (not found verbatim)"}`] : []),
  ...(resolution.narrowsQuote ? [`   warning: the hypothesis narrows those words — ${resolution.narrowing}`] : []),
  ...resolution.readings.map((reading, index) =>
    `   ${index + 1}. ${reading}${index === resolution.recommended ? "  [resolver's pick]" : ""}`),
  ...(resolution.rationale ? [`   why: ${resolution.rationale}`] : [])
];

/** Keep header and footer; drop the least urgent (trailing) items that do not fit. */
const fitLines = (body: string[], maxChars: number): string => {
  const full = [LEDGER_HEADER, ...body, LEDGER_FOOTER].join("\n");
  if (full.length <= maxChars) {
    return full;
  }
  const kept: string[] = [];
  let used = LEDGER_HEADER.length + LEDGER_FOOTER.length + 80;
  for (const line of body) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const note = `[assumption ledger truncated: ${body.length - kept.length} of ${body.length} items omitted]`;
  return [LEDGER_HEADER, ...kept, note, LEDGER_FOOTER].join("\n").slice(0, Math.max(maxChars, 0));
};
