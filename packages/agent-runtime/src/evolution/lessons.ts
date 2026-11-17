import type { TrajectorySummary } from "./trajectory.js";

/**
 * Lessons: general working rules the agent learned from its own earlier runs, kept in numbered
 * versions so every run can say which version it used and every lesson which runs it came from.
 */
export type Lesson = {
  id: string;
  text: string;
  why: string;
  fromRuns: string[];
  addedInVersion: number;
};

export type LessonVersion = {
  version: number;
  createdAt: string;
  /** The runs this version learned from. */
  fromRuns: string[];
  added: string[];
  rejected: Array<{ text: string; reason: string }>;
  lessons: Lesson[];
  /** What this version learned from, kept so the timeline can be read and an empty version explained. */
  batch?: TrajectorySummary[];
  /** The lesson writer's reply, shortened. */
  reply?: string;
};

export type EvolutionState = {
  versions: LessonVersion[];
  /** Finished runs not yet learned from. */
  pending: TrajectorySummary[];
};

export const emptyEvolutionState = (): EvolutionState => ({ versions: [], pending: [] });

export const currentLessons = (state: EvolutionState): { version: number; lessons: Lesson[] } => {
  const latest = state.versions.at(-1);
  return latest ? { version: latest.version, lessons: latest.lessons } : { version: 0, lessons: [] };
};

/** Tool and protocol names a lesson may use: they are how the agent works, not facts about data. */
const ALLOWED_IDENTIFIERS = new Set([
  "final_answer", "analysis_requirements_commit", "analysis_decision_record", "option_results",
  "run_sql_readonly", "preview_table", "inspect_schema", "frame_choices", "evidence_refs", "datalink_explore"
]);

const MAX_WORDS = 70;
const DUPLICATE_OVERLAP = 0.6;

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().replaceAll(/[^\p{L}\p{N}_ ]+/gu, " ").split(/\s+/u).filter((word) => word.length > 2));

const overlap = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
};

/** Capitalized words that open questions and instructions, not names. */
const QUESTION_WORDS = new Set([
  "what", "which", "when", "where", "how", "does", "were", "there", "this", "that", "these", "those", "between",
  "from", "answer", "only", "consider", "impute", "among", "estimate", "assume", "return", "give", "round",
  "report", "please", "find", "compute", "calculate", "list", "name", "true", "false", "with", "without",
  "each", "every", "after", "before", "during", "using", "based", "given", "note", "also", "then"
]);

/**
 * Names and values a lesson must not carry. Values (the runs' answers and committed values) match
 * in any case. Names are the capitalized words of the questions (a sentence may open with one) and
 * match only when the lesson writes them capitalized too: a name keeps its capital, while the same
 * word in lower case is ordinary ("final", "retrieved", "beach" were refused before, trial 2).
 */
export type ForbiddenTerms = { values: string[]; names: string[] };

export const forbiddenTerms = (summaries: TrajectorySummary[]): ForbiddenTerms => {
  const values = new Set<string>();
  const names = new Set<string>();
  for (const summary of summaries) {
    for (const value of [summary.finalAnswer, ...summary.committedValues]) {
      if (value && value.trim().length >= 3) values.add(value.trim().toLowerCase());
    }
    for (const match of summary.question.matchAll(/\b(\p{Lu}[\p{L}'-]{3,})/gu)) {
      const word = match[1];
      if (word && !QUESTION_WORDS.has(word.toLowerCase())) names.add(capitalized(word));
    }
  }
  return { values: [...values], names: [...names] };
};

/** "WOLLASTON" and "Wollaston" are the same name. */
const capitalized = (word: string): string => word.charAt(0) + word.slice(1).toLowerCase();

/** Why a proposed lesson is refused, or undefined when it may be kept. */
export const lessonRejection = (
  text: string,
  context: { existing: Lesson[]; forbidden: ForbiddenTerms }
): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.split(/\s+/u).length > MAX_WORDS) return "longer than 70 words";
  if (/\d+\.\d+|\d{2,}/u.test(trimmed)) return "contains a number";
  if (/`[^`]+`|"[^"]{2,}"|'[^']{3,}'|“[^”]+”/u.test(trimmed)) return "quotes a specific name or value";
  const identifier = [...trimmed.matchAll(/\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b/gu)]
    .map((match) => match[0].toLowerCase())
    .find((name) => !ALLOWED_IDENTIFIERS.has(name));
  if (identifier) return `names an identifier (${identifier})`;
  const file = /\b[\p{L}\p{N}_-]+\.(?:csv|tsv|jsonl?|parquet|xlsx?|txt|sql|duckdb|db)\b/iu.exec(trimmed);
  if (file) return `names a file (${file[0]})`;
  const lowered = trimmed.toLowerCase();
  const bounded = (term: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, "u");
  const value = context.forbidden.values.find((candidate) => bounded(candidate).test(lowered));
  if (value) return `repeats a value from the runs (${value})`;
  const lessonWords = new Set([...trimmed.matchAll(/\b\p{Lu}[\p{L}'-]{3,}/gu)].map((match) => capitalized(match[0])));
  const name = context.forbidden.names.find((candidate) => lessonWords.has(candidate));
  if (name) return `repeats a name from the runs (${name})`;
  const mine = words(trimmed);
  const duplicate = context.existing.find((lesson) => overlap(mine, words(lesson.text)) >= DUPLICATE_OVERLAP);
  if (duplicate) return `repeats lesson ${duplicate.id}`;
  return undefined;
};

const escape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The lessons as a section of the agent's instructions. */
export const renderLessons = (version: number, lessons: Lesson[]): string | undefined => {
  if (lessons.length === 0) return undefined;
  return [
    `Lessons learned from your earlier runs (lesson version ${version}). They are rules about how to work, `
      + "learned from problems in those runs, not facts about this data; apply each one where it fits this question:",
    ...lessons.map((lesson) => `- ${lesson.id}: ${lesson.text}`)
  ].join("\n");
};
