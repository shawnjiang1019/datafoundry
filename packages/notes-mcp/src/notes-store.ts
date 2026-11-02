import { randomUUID } from "node:crypto";

import type { EvidenceGroundingContext } from "@datafoundry/agent-runtime/grounding";

/** Notes are kept this long after ground, enough for one agent run on one question. */
export const NOTES_TTL_MS = 60 * 60 * 1000;

export type NotesEntry = {
  id: string;
  datasource: string;
  question: string;
  grounding: EvidenceGroundingContext;
  /** The last query that ran through run_sql under these notes: the one check_answer reads by default. */
  lastSql?: string;
  /** Challenges check_answer has returned for this question; capped so the agent keeps the last word. */
  challenges: number;
  createdAt: number;
};

/** In-memory notes, one entry per ground call, dropped after NOTES_TTL_MS. */
export class NotesStore {
  private readonly entries = new Map<string, NotesEntry>();

  constructor(private readonly ttlMs = NOTES_TTL_MS, private readonly now: () => number = Date.now) {}

  create(input: Pick<NotesEntry, "datasource" | "question" | "grounding">): NotesEntry {
    this.sweep();
    const entry: NotesEntry = { ...input, id: `n-${randomUUID().slice(0, 8)}`, challenges: 0, createdAt: this.now() };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): NotesEntry | undefined {
    const entry = this.entries.get(id);
    if (entry && this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(id);
    }
  }
}
