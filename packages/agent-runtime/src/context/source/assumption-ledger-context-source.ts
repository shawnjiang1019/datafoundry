import { createContextItem, type ContextItem } from "../inventory/context-item.js";
import { createContextSourceMetadata } from "../inventory/context-source-metadata.js";
import type { RuntimeContextSource, RuntimeContextSourceInput } from "./runtime-context-source.js";

const DEFAULT_MAX_LEDGER_CHARS = 6000;
const CONFIRMED_CLAUSE_CHARS = 80;
const STATUS_ORDER = ["refuted", "partial", "text_only", "assumed"] as const;
const LEDGER_HEADER = "Assumption ledger (checked against the data before you started):";
const LEDGER_FOOTER =
  "Before committing an answer, state how your analysis handles every refuted, partial, assumed or text_only item.";

/** D-Trail classifier receipt (assumptions + evaluated claim trees), checked before the run. */
export type AssumptionReceipt = {
  task_id?: string;
  assumptions?: unknown[];
  trees?: unknown[];
  summary?: Record<string, unknown>;
  probes?: number;
  [key: string]: unknown;
};

export type AssumptionLedgerContextSourceOptions = {
  receipt: AssumptionReceipt;
  maxChars?: number;
};

type LedgerEntry = {
  status: string;
  clause: string;
  checks: string[];
  residual: string;
};

export class AssumptionLedgerContextSource implements RuntimeContextSource {
  readonly sourceType = "assumption-ledger";

  constructor(private readonly options: AssumptionLedgerContextSourceOptions) {}

  collect(input: RuntimeContextSourceInput): ContextItem[] {
    if (ledgerEntries(this.options.receipt).length === 0) {
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

/** Render the ledger: open items first (refuted, partial, text_only, assumed), confirmed collapsed. */
export const createAssumptionLedgerText = (
  receipt: AssumptionReceipt,
  maxChars = DEFAULT_MAX_LEDGER_CHARS
): string => {
  const entries = ledgerEntries(receipt);
  const body: string[] = [];
  for (const status of STATUS_ORDER) {
    for (const entry of entries.filter((item) => item.status === status)) {
      const checks = entry.checks.length > 0 ? ` — ${entry.checks.join("; ")}` : "";
      const open = entry.residual ? `; open: ${entry.residual}` : "";
      body.push(`- [${status}] ${entry.clause}${checks}${open}`);
    }
  }
  const confirmed = entries.filter((entry) => entry.status === "confirmed");
  if (confirmed.length > 0) {
    const noun = confirmed.length === 1 ? "assumption holds" : "assumptions hold";
    const clauses = confirmed.map((entry) => clip(entry.clause, CONFIRMED_CLAUSE_CHARS)).join("; ");
    body.push(`- [confirmed] ${confirmed.length} ${noun}: ${clauses}`);
  }
  return fitLines(body, maxChars);
};

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

const ledgerEntries = (receipt: AssumptionReceipt): LedgerEntry[] => {
  const assumptions = Array.isArray(receipt.assumptions) ? receipt.assumptions : [];
  const trees = Array.isArray(receipt.trees) ? receipt.trees : [];
  // d-trail evaluates one tree per assumption, in order.
  return trees.flatMap((tree, index): LedgerEntry[] => {
    if (!isRecord(tree) || typeof tree.status !== "string") {
      return [];
    }
    const assumption = isRecord(assumptions[index]) ? assumptions[index] : {};
    const atoms = claimAtoms(tree.claim);
    const clause = text(assumption.clause)
      || atoms.map((atom) => text(atom.prose)).find(Boolean)
      || "(unnamed assumption)";
    return [{
      status: tree.status,
      clause: oneLine(clause),
      checks: atoms.map(renderAtom).filter(Boolean),
      residual: oneLine(text(tree.residual) || text(assumption.residual))
    }];
  });
};

const claimAtoms = (claim: unknown): Record<string, unknown>[] => {
  if (!isRecord(claim)) {
    return [];
  }
  if (isRecord(claim.atom)) {
    return [claim.atom];
  }
  return [...claimAtoms(claim.left), ...claimAtoms(claim.right)];
};

/** kind(table.column='value'[, slot=value][ where col='value']) */
const renderAtom = (atom: Record<string, unknown>): string => {
  const expects = isRecord(atom.expects) ? atom.expects : {};
  const table = text(expects.table);
  const column = text(expects.column);
  let subject = table && column ? `${table}.${column}` : column || table;
  if (expects.value !== undefined && expects.value !== null) {
    subject += `=${literal(expects.value)}`;
  }
  const slots = Object.entries(expects)
    .filter(([key, value]) => !["table", "column", "value", "where"].includes(key) && isScalar(value))
    .map(([key, value]) => `${key}=${String(value)}`);
  const where = isRecord(expects.where) && text(expects.where.column)
    ? ` where ${text(expects.where.column)}=${literal(expects.where.value)}`
    : "";
  const args = [subject, ...slots].filter(Boolean).join(", ") + where;
  return args ? `${text(atom.kind) || "check"}(${args})` : "";
};

const literal = (value: unknown): string => (typeof value === "string" ? `'${value}'` : String(value));

const isScalar = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) || typeof value === "number" || typeof value === "boolean";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const oneLine = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();

const clip = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
