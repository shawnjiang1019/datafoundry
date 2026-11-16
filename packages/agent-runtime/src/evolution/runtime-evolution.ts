import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  currentLessons,
  emptyEvolutionState,
  forbiddenTerms,
  lessonRejection,
  type EvolutionState,
  type Lesson,
  type LessonVersion
} from "./lessons.js";
import type { TrajectorySummary } from "./trajectory.js";

/**
 * Runtime evolution: after every `every` finished runs, the agent's recent trajectories are read
 * and turned into at most two new working rules, which go into the instructions of every later
 * run. State is one JSON file per user, written atomically, so a restart keeps both the lessons and
 * the runs not yet learned from. Off unless DF_RUNTIME_EVOLUTION=1.
 */

/** One model call: a prompt in, the model's text out. */
export type LessonModel = (prompt: string) => Promise<string>;

export type RuntimeEvolutionOptions = {
  dir: string;
  every?: number;
  maxLessons?: number;
  log?: (message: string) => void;
};

export const RUNTIME_EVOLUTION_VARIABLE = "DF_RUNTIME_EVOLUTION";

/** The settings named by DF_RUNTIME_EVOLUTION, DF_EVOLUTION_DIR and DF_EVOLUTION_EVERY, or undefined when off. */
export const runtimeEvolutionFromEnvironment = (
  env: Record<string, string | undefined>,
  defaultDir: string
): RuntimeEvolutionOptions | undefined => {
  if (env[RUNTIME_EVOLUTION_VARIABLE] !== "1") return undefined;
  const every = Number(env.DF_EVOLUTION_EVERY);
  return {
    dir: env.DF_EVOLUTION_DIR ?? defaultDir,
    ...(Number.isInteger(every) && every > 0 ? { every } : {})
  };
};

const DEFAULT_EVERY = 3;
const DEFAULT_MAX_LESSONS = 10;
const MAX_NEW_LESSONS = 2;
const MAX_REPLY_CHARS = 4000;

export class RuntimeEvolution {
  private readonly every: number;
  private readonly maxLessons: number;
  private readonly log: (message: string) => void;
  /** One chain per user, so two runs ending together do not overwrite each other's update. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: RuntimeEvolutionOptions) {
    this.every = options.every ?? DEFAULT_EVERY;
    this.maxLessons = options.maxLessons ?? DEFAULT_MAX_LESSONS;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** The lessons a new run starts with. */
  current(userId: string): { version: number; lessons: Lesson[] } {
    return currentLessons(this.read(userId));
  }

  /**
   * Add a finished run; on every `every`-th run, learn from the pending runs. Returns the lesson
   * version later runs will use. A failed model call keeps the runs pending for the next attempt.
   */
  afterRun(input: { userId: string; summary: TrajectorySummary; model: LessonModel }): Promise<{ version: number; evolved: boolean }> {
    const previous = this.queues.get(input.userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.learn(input));
    this.queues.set(input.userId, next);
    return next;
  }

  private async learn(input: { userId: string; summary: TrajectorySummary; model: LessonModel }): Promise<{ version: number; evolved: boolean }> {
    const state = this.read(input.userId);
    // A follow-up turn on the same question (same session) continues that question's trajectory: it
    // replaces the earlier summary, keeping its signals and flags, and does not count as a new run.
    const sameQuestion = input.summary.sessionId === undefined
      ? -1
      : state.pending.findIndex((summary) => summary.sessionId === input.summary.sessionId);
    if (sameQuestion >= 0) {
      const earlier = state.pending[sameQuestion]!;
      state.pending[sameQuestion] = {
        ...input.summary,
        question: earlier.question,
        signals: [...earlier.signals, ...input.summary.signals],
        flags: [...new Set([...earlier.flags, ...input.summary.flags])]
      };
      this.write(input.userId, state);
      this.log(`[evolution] run ${input.summary.runId} continues ${earlier.runId} (same session), still ${state.pending.length}/${this.every}`);
      return { version: currentLessons(state).version, evolved: false };
    }
    state.pending.push(input.summary);
    if (state.pending.length < this.every) {
      this.write(input.userId, state);
      this.log(`[evolution] run ${input.summary.runId} pending (${state.pending.length}/${this.every})`);
      return { version: currentLessons(state).version, evolved: false };
    }
    const batch = state.pending;
    const { version, lessons } = currentLessons(state);
    let reply: string;
    try {
      reply = await input.model(buildLessonPrompt(batch, lessons));
    } catch (error) {
      this.write(input.userId, state);
      this.log(`[evolution] lesson model failed, ${batch.length} runs kept pending: ${error instanceof Error ? error.message : String(error)}`);
      return { version, evolved: false };
    }
    const proposals = parseLessonReply(reply).slice(0, MAX_NEW_LESSONS);
    const forbidden = forbiddenTerms(batch);
    const kept: Lesson[] = [];
    const rejected: LessonVersion["rejected"] = [];
    const nextVersion = version + 1;
    for (const proposal of proposals) {
      const reason = lessonRejection(proposal.text, { existing: [...lessons, ...kept], forbidden });
      if (reason) {
        rejected.push({ text: proposal.text, reason });
        continue;
      }
      const runIds = new Set(batch.map((summary) => summary.runId));
      kept.push({
        id: `L${nextLessonNumber(state) + kept.length}`,
        text: proposal.text.trim(),
        why: proposal.why.trim(),
        fromRuns: proposal.fromRuns.filter((runId) => runIds.has(runId)),
        addedInVersion: nextVersion
      });
    }
    // Newest lessons win when the list is full: they come from the agent's latest behavior.
    const merged = [...lessons, ...kept].slice(-this.maxLessons);
    state.versions.push({
      version: nextVersion,
      createdAt: new Date().toISOString(),
      fromRuns: batch.map((summary) => summary.runId),
      added: kept.map((lesson) => lesson.id),
      rejected,
      lessons: merged,
      batch,
      reply: reply.slice(0, MAX_REPLY_CHARS)
    });
    state.pending = [];
    this.write(input.userId, state);
    this.log(`[evolution] version ${nextVersion} from ${batch.length} runs: added ${kept.map((lesson) => lesson.id).join(", ") || "none"}`
      + `${rejected.length > 0 ? `; rejected ${rejected.length} (${rejected.map((item) => item.reason).join("; ")})` : ""}`
      + `${proposals.length === 0 ? `; the lesson writer proposed none (${parseLessonReply(reply).length === 0 && !/"lessons"/u.test(reply) ? "reply not readable" : "empty list"})` : ""}`);
    return { version: nextVersion, evolved: true };
  }

  private path(userId: string): string {
    return join(this.options.dir, safeSegment(userId), "evolution.json");
  }

  private read(userId: string): EvolutionState {
    try {
      const parsed = JSON.parse(readFileSync(this.path(userId), "utf8")) as Partial<EvolutionState>;
      return { versions: parsed.versions ?? [], pending: parsed.pending ?? [] };
    } catch {
      return emptyEvolutionState();
    }
  }

  private write(userId: string, state: EvolutionState): void {
    const path = this.path(userId);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, path);
  }
}

const nextLessonNumber = (state: EvolutionState): number =>
  1 + state.versions.reduce((count, version) => count + version.added.length, 0);

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_-]/gu, "_") || "default";

export const LESSON_WRITER_INSTRUCTIONS = [
  "You improve a data-analysis agent between questions. You read short summaries of its latest runs and write",
  "working rules that will be added to its instructions for every later question, on any dataset.",
  "Rules for a lesson:",
  "- It is about how to work: reading the question, choosing between readings, checking, committing, answering.",
  "- Write one only for a problem a summary shows: a flag, a check that sent the agent back, a decision that",
  "  changed the answer, or actions that failed again and again. If the runs show no problem, write none.",
  "- Never name a table, column, value, place, dataset or subject area, and never include a number.",
  "- One or two sentences, imperative, at most 50 words. Do not repeat an existing lesson.",
  "Return JSON only, no other text:",
  "{\"lessons\": [{\"text\": \"...\", \"why\": \"the problem it addresses, one sentence\", \"from_runs\": [\"<run id>\"]}]}",
  "Return {\"lessons\": []} when there is nothing to learn. At most two lessons."
].join("\n");

export const buildLessonPrompt = (summaries: TrajectorySummary[], existing: Lesson[]): string => [
  "Existing lessons:",
  existing.length > 0 ? existing.map((lesson) => `- ${lesson.id}: ${lesson.text}`).join("\n") : "(none)",
  "",
  "Latest runs:",
  JSON.stringify(summaries.map((summary) => ({
    run_id: summary.runId,
    question: summary.question,
    final_answer: summary.finalAnswer ?? null,
    flags: summary.flags,
    checks_that_sent_it_back: summary.signals.map((signal) => ({ check: signal.source, answer_then: signal.answer ?? null, reason: signal.detail })),
    decisions: summary.decisions,
    queries: summary.queries,
    failed_actions: summary.failedActions
  })), null, 2)
].join("\n");

/** The proposals in the model's reply; anything that is not the expected JSON gives none. */
export const parseLessonReply = (reply: string): Array<{ text: string; why: string; fromRuns: string[] }> => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { lessons?: unknown };
    if (!Array.isArray(parsed.lessons)) return [];
    return parsed.lessons.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text : "";
      if (!text.trim()) return [];
      return [{
        text,
        why: typeof record.why === "string" ? record.why : "",
        fromRuns: Array.isArray(record.from_runs) ? record.from_runs.filter((run): run is string => typeof run === "string") : []
      }];
    });
  } catch {
    return [];
  }
};
