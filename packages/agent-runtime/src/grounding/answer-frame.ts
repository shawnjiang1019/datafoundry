import { Agent } from "@mastra/core/agent";
import { DISABLE_THINKING_HEADER, type ModelProvider } from "@datafoundry/providers";

import { AGENT_RUNTIME_LIMITS } from "../config/agent-runtime-limits.js";
import type { GroundingSchema, GroundingSqlProbe, SemanticFact } from "./types.js";
import { quoteIdent } from "./vocabulary.js";

const MAX_DECISIONS = 4;
const MAX_OPTIONS = 3;
const MAX_SHOWN_DECISIONS = 3;
const PROPOSAL_ATTEMPTS = 2;
/** Readings whose counts all lie within this share of the largest are not a real choice. */
const MIN_COUNT_GAP = 0.02;
const ASPECT_PRIORITY: Record<FrameAspect, number> = { population: 0, denominator: 1, unit: 2 };

export type FrameAspect = "unit" | "population" | "denominator";

export type FrameOption = {
  label: string;
  table: string;
  sqlWhere: string | null;
  keyColumns: string[];
  /** Filled by the data check. */
  rows?: number;
  units?: number;
  status?: "checked" | "empty" | "invalid";
  error?: string;
  /** Words of the question this reading leaves unapplied, as the proposer reports them. */
  unappliedWords?: string[];
};

export type FrameDecision = {
  aspect: FrameAspect;
  questionPhrase: string;
  options: FrameOption[];
};

export type AnswerFrame = { decisions: FrameDecision[]; warnings: string[] };

/** One model call; returns the raw text of a JSON object. */
export type AnswerFrameProposer = (prompt: string) => Promise<string>;

/**
 * Readings of the question, checked against the data, offered as options.
 *
 * Offline on KramaBench the model stated the right unit or population for some tasks
 * (biomedical-easy-2: excluded cases out, which gives the expected 68.5) and confidently
 * reversed the benchmark's convention on others (legal-easy-19: it called the expected
 * denominator a trap). So the model never chooses here: it lists every defensible reading,
 * each one is counted in the data, and the agent decides with the counts in front of it.
 */
export const buildAnswerFrame = async (input: {
  question: string;
  schema: GroundingSchema;
  facts: SemanticFact[];
  /** Join conditions already checked against the data, as "a.x -> b.y: <condition>". */
  verifiedJoins?: string[];
  probe: GroundingSqlProbe;
  propose: AnswerFrameProposer;
}): Promise<AnswerFrame> => {
  let decisions: FrameDecision[] | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < PROPOSAL_ATTEMPTS && !decisions; attempt += 1) {
    try {
      decisions = parseDecisions(await input.propose(
        answerFramePrompt(input.question, input.schema, input.facts, input.verifiedJoins)
      ));
    } catch (error) {
      lastError = error;
    }
  }
  if (!decisions) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    return { decisions: [], warnings: [`ANSWER_FRAME_PROPOSAL_FAILED:${reason}`] };
  }
  const tables = new Set(input.schema.tables.map((table) => table.name));
  for (const decision of decisions) {
    for (const option of decision.options) {
      Object.assign(option, await checkOption(option, tables, input.probe));
    }
  }
  return { decisions, warnings: decisions.length === 0 ? ["ANSWER_FRAME_NO_DECISIONS"] : [] };
};

/** A tool-free helper on the run's own model, like the analysis contract grounder. */
export const createModelAnswerFrameProposer = (
  provider: Exclude<ModelProvider, { kind: "mock" }>
): AnswerFrameProposer => {
  const agent = new Agent({
    id: "answer-frame-proposer",
    name: "Answer Frame Proposer",
    instructions: "List readings of a data question as JSON. Never answer the question.",
    model: provider.model as never
  });
  return async (prompt) => (await agent.generate(prompt, {
    maxSteps: AGENT_RUNTIME_LIMITS.modelHelperMaxSteps,
    modelSettings: {
      maxOutputTokens: AGENT_RUNTIME_LIMITS.contractGrounderMaxOutputTokens,
      temperature: 0,
      // Structured output, like the contract: with reasoning on, this call left runs silent for ~10 minutes
      // and pushed environment-hard-10 past the 30-minute run limit (2026-10-12).
      headers: { [DISABLE_THINKING_HEADER]: "1" }
    }
  })).text;
};

export const answerFramePrompt = (
  question: string,
  schema: GroundingSchema,
  facts: SemanticFact[],
  verifiedJoins: string[] = []
): string => [
  "You are preparing an analysis, not doing it. Do not answer the question.",
  "List the decisions that change the answer:",
  "- unit: what one counted or averaged thing is (one row of a table may not be one unit);",
  "- population: which units are included;",
  "- denominator: the base of any ratio, proportion, average or comparison.",
  "For each decision give every reading of the question's wording that a careful analyst could defend",
  `with this data (at most ${MAX_OPTIONS}). Do not pick one and do not say which is right.`,
  "A reading must apply every qualifier the question states (for example \"used for ...\", \"with ...\",",
  "\"in the X dataset\"); in unapplied_words list the question's words a reading leaves out (empty when none).",
  "Do not list ways to define or measure a variable (thresholds, cut-offs, scores) or choices of analysis method:",
  "those belong to the analysis. List only which rows are included and what one counted thing is.",
  "When a column's values define a term of the question (for example a capital column with 'primary'),",
  "use that definition and do not offer a broader or looser version of the term as another reading.",
  "Express each reading as a DuckDB WHERE condition over one table (null when it is the whole table);",
  "it may use IN (SELECT ...) or EXISTS over other tables. key_columns identify one unit in that table.",
  "Use only the tables and columns listed below and double-quote every identifier.",
  "Return only JSON: {\"decisions\": [{\"aspect\": \"unit|population|denominator\", \"question_phrase\": str,",
  "\"options\": [{\"label\": str, \"table\": str, \"sql_where\": str or null, \"key_columns\": [str],",
  "\"unapplied_words\": [str]}]}]}",
  "",
  `QUESTION: ${question}`,
  "",
  "TABLES:",
  ...schema.tables.map((table) => `${quoteIdent(table.name)}: `
    + table.columns.slice(0, 60).map((column) => `${quoteIdent(column.name)} ${column.type}`).join(", ")
    + (table.columns.length > 60 ? `, ... ${table.columns.length - 60} more columns` : "")),
  ...(facts.length > 0
    ? ["", "COLUMN DESCRIPTIONS (from the lake's data dictionary):",
       ...facts.map((fact) => `${quoteIdent(fact.subject.table)}.${quoteIdent(fact.subject.column)}: ${fact.text}`)]
    : []),
  ...(verifiedJoins.length > 0
    ? ["", "VERIFIED JOINS (checked against the data). When a reading links two tables, express it with one of",
       "these exact conditions inside IN (SELECT ...) or EXISTS; do not use other columns as join keys:",
       ...verifiedJoins.map((join) => `- ${join}`)]
    : [])
].join("\n");

/**
 * The agent-facing view. A decision is shown when the data makes it a real choice: at least two
 * readings select rows, in different counts. A reading that selects nothing is listed inside a
 * shown decision, but no longer makes one shown: environment-easy-4 (2026-10-12) got a decision
 * whose readings nearly all matched 0 rows (the proposer's date filters missed the data), and it
 * steered the agent to the wrong table. At most three are shown: population, then denominator,
 * then unit, which offline was the noisiest on pre-aggregated tables.
 */
export const renderAnswerFrame = (
  frame: AnswerFrame | undefined,
  options: { binding?: boolean } = {}
): Record<string, unknown> | undefined => {
  const shown = shownFrameDecisions(frame, options.binding === true);
  if (shown.length === 0) {
    return undefined;
  }
  return {
    instruction: [
      "Readings of the question checked against the data before any SQL ran.",
      "They are options, not answers: none of them is endorsed.",
      "Decide each one from the question's exact wording, and state the choice you made in the final answer.",
      ...(options.binding
        ? [
            "Binding: options are listed in no particular order. For every decision, pass the reading you chose in",
            "frame_choices on run_sql_readonly as \"<id>: <why, quoting the question's words>\" (for example",
            "\"F1.2: the question says total acres burned per area\"). The SQL that answers the question must apply that reading's WHERE,",
            "and for a unit with fewer distinct units than rows, compute the answer once per unit (SELECT DISTINCT or GROUP BY its key).",
            "A reading marked leaves_out ignores those words of the question; choose it only if the question means them loosely.",
            "One also marked not_choosable selects very different rows from the readings that apply them and cannot be chosen."
          ]
        : [])
    ].join(" "),
    decisions: shown.map(({ id, decision }) => ({
      ...(options.binding ? { id } : {}),
      aspect: decision.aspect,
      question_phrase: decision.questionPhrase,
      options: decision.options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => option.status !== "invalid")
        .map(({ option, index }) => ({
          ...(options.binding ? { id: `${id}.${index + 1}` } : {}),
          reading: option.label,
          selects: `${quoteIdent(option.table)}${option.sqlWhere ? ` WHERE ${option.sqlWhere}` : ""}`,
          rows: option.rows,
          ...(option.units !== undefined && option.units !== option.rows
            ? { distinct_units: option.units, note: `${option.rows} rows are ${option.units} distinct units` }
            : {}),
          ...(option.status === "empty" ? { note: "matches no rows as written" } : {}),
          ...(unfaithfulWords(decision, option)
            ? { leaves_out: unfaithfulWords(decision, option),
                ...(options.binding && blockedUnfaithfulWords(decision, option) ? { not_choosable: true } : {}) }
            : {})
        }))
    }))
  };
};

/**
 * The decisions shown to the agent, in display order, with stable ids (F1, F2, ...). Option
 * ids are F<decision>.<position in the decision's options>, so they survive the filtering of
 * invalid options and can be resolved again from the stored frame.
 */
export const shownFrameDecisions = (
  frame: AnswerFrame | undefined,
  shuffle = false
): Array<{ id: string; decision: FrameDecision }> => {
  return (frame?.decisions ?? [])
    .filter((decision) => {
      const checked = decision.options.filter((option) => option.status === "checked");
      return checked.length >= 2 && (countGap(checked.map((option) => option.rows)) >= MIN_COUNT_GAP
        || countGap(checked.map((option) => option.units)) >= MIN_COUNT_GAP) && strongEvidence(decision);
    })
    .sort((a, b) => ASPECT_PRIORITY[a.aspect] - ASPECT_PRIORITY[b.aspect])
    .slice(0, MAX_SHOWN_DECISIONS)
    .map((decision, index) => ({ id: `F${index + 1}`, decision: shuffle ? shuffledOptions(decision) : decision }));
};

/** Rows to distinct units below this ratio mean one row is not one unit. */
const MAX_UNIT_RATIO = 0.9;
const LINKED_READING = /\b(?:EXISTS|IN)\s*\(\s*SELECT\b/iu;
const FLAG_COLUMN = /(?:exclu|includ|eligib|flag|valid)/iu;

/**
 * Whether the data gives a strong reason to show this decision. Readings that merely differ invite the
 * agent to pick a plausible wrong one when it would have been right alone (archeology-easy-11, 2026-10-16:
 * "any capital designation", no link, flag or duplicate behind it). The decisions that fixed answers all
 * had one of these: a population defined through another table (wildfire-hard-17's stations used by fire
 * records), an exclusion or inclusion flag (biomedical-easy-2's excluded cases), a unit whose rows repeat
 * (counting rows would double count), or a reading that ignores the question's words and changes the rows
 * a lot. Simulated on the October 16 frames, this kept every decision behind those wins and hid the
 * archeology-easy-11 decision.
 */
const strongEvidence = (decision: FrameDecision): boolean => {
  const live = decision.options.filter((option) => option.status === "checked");
  const where = (option: FrameOption) => option.sqlWhere ?? "";
  return live.some((option) => LINKED_READING.test(where(option)))
    || live.some((option) => FLAG_COLUMN.test(where(option)))
    || (decision.aspect === "unit" && live.some((option) =>
      option.rows !== undefined && option.rows > 0 && option.units !== undefined && option.units < option.rows * MAX_UNIT_RATIO))
    || live.some((option) => blockedUnfaithfulWords(decision, option) !== undefined);
};

/**
 * The spread of the readings' counts as a share of the largest. archeology-easy-11 (2026-10-12) showed
 * "any capital designation" (227 countries) beside "national capitals" (226): a 0.4% difference the
 * agent took as a real choice, and lost. The decisions that helped differed by 7% to 38%.
 */
const countGap = (counts: Array<number | undefined>): number => {
  const known = counts.filter((count): count is number => typeof count === "number");
  const largest = Math.max(...known);
  return known.length >= 2 && largest > 0 ? (largest - Math.min(...known)) / largest : 0;
};

/**
 * Under binding the agent took the proposer's first option in 74% of 77 choices (2026-10-12), so a
 * wrong first reading was enforced (wildfire-hard-7, hard-5). The options are shown in an order seeded
 * from the decision's own text: stable within a run, so ids resolve the same way, but not the
 * proposer's ranking.
 */
const shuffledOptions = (decision: FrameDecision): FrameDecision => {
  let seed = 2166136261;
  for (const char of `${decision.questionPhrase}|${decision.options.map((option) => option.label).join("|")}`) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  const order = decision.options.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    // Use the high bits: a power-of-two LCG's low bits cycle with short periods.
    const swap = Math.floor((seed / 2 ** 32) * (index + 1));
    [order[index], order[swap]] = [order[swap] as number, order[index] as number];
  }
  return { ...decision, options: order.map((index) => decision.options[index] as FrameOption) };
};

/** Resolve an option id such as "F1.2" against the shown decisions. */
export const resolveFrameChoice = (
  frame: AnswerFrame | undefined,
  choiceId: string
): { decisionId: string; decision: FrameDecision; option: FrameOption } | undefined => {
  const matched = /^(F\d+)\.(\d+)\b/u.exec(choiceId.trim());
  if (!matched) return undefined;
  const shown = shownFrameDecisions(frame, true).find(({ id }) => id === matched[1]);
  const option = shown?.decision.options[Number(matched[2]) - 1];
  return shown && option && option.status !== "invalid"
    ? { decisionId: shown.id, decision: shown.decision, option }
    : undefined;
};

const checkOption = async (
  option: FrameOption,
  tables: Set<string>,
  probe: GroundingSqlProbe
): Promise<Pick<FrameOption, "rows" | "units" | "status" | "error">> => {
  if (!tables.has(option.table)) {
    return { status: "invalid", error: `unknown table ${option.table}` };
  }
  const units = option.keyColumns.length > 0
    ? `COUNT(DISTINCT (${option.keyColumns.map(quoteIdent).join(", ")}))`
    : "COUNT(*)";
  try {
    const result = await probe(
      `SELECT COUNT(*) AS n_rows, ${units} AS n_units FROM ${quoteIdent(option.table)}`
      + (option.sqlWhere ? ` WHERE ${option.sqlWhere}` : "")
    );
    const [rows, unitCount] = (result.rows[0] ?? []).map((value) => Number(value ?? 0));
    return { rows: rows ?? 0, units: unitCount ?? 0, status: (rows ?? 0) === 0 ? "empty" : "checked" };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
};

const parseDecisions = (text: string): FrameDecision[] => {
  const raw = recordValue(JSON.parse(firstJsonObject(text)) as unknown, "decisions");
  if (!Array.isArray(raw)) {
    throw new Error("decisions missing");
  }
  return raw.slice(0, MAX_DECISIONS).flatMap((decision): FrameDecision[] => {
    const aspect = recordString(decision, "aspect");
    const options = recordValue(decision, "options");
    if (!aspect || !["unit", "population", "denominator"].includes(aspect) || !Array.isArray(options)) {
      return [];
    }
    const parsed = options.slice(0, MAX_OPTIONS).flatMap((option): FrameOption[] => {
        const table = unquote(recordString(option, "table") ?? "");
        if (!table) return [];
        const keyColumns = recordValue(option, "key_columns");
        return [{
          label: recordString(option, "label") ?? "",
          table,
          sqlWhere: recordString(option, "sql_where") ?? null,
          keyColumns: Array.isArray(keyColumns)
            ? keyColumns.filter((column): column is string => typeof column === "string" && column.length > 0).map(unquote)
            : [],
          unappliedWords: stringList(recordValue(option, "unapplied_words"))
        }];
    });
    return [{
      aspect: aspect as FrameAspect,
      questionPhrase: recordString(decision, "question_phrase") ?? "",
      options: parsed
    }];
  });
};

/**
 * The words of the question a reading leaves out, when another reading of the same decision applies
 * them all; undefined when the reading may be chosen. wildfire-hard-17, 2026-10-12: "all stations,
 * whether or not any fire used them" was offered for "stations used for fire site monitoring", and the
 * agent chose it in 2 of 5 bound runs. It is marked, not blocked: environment-easy-1's expected answer
 * reads "during the 2013 bathing season" as all of 2013, and blocking forced June-August (4.829, not 4.796).
 */
export const unfaithfulWords = (decision: FrameDecision, option: FrameOption): string[] | undefined => {
  const words = option.unappliedWords ?? [];
  const faithfulSibling = decision.options.some((candidate) =>
    candidate !== option && candidate.status !== "invalid" && (candidate.unappliedWords ?? []).length === 0);
  return words.length > 0 && faithfulSibling ? words : undefined;
};

/** A reading that leaves out the question's words this far from every faithful reading cannot be chosen. */
const MAX_UNFAITHFUL_GAP = 0.25;

/**
 * The words left out, when the reading also selects very different rows from every reading that applies
 * them: the question's words then clearly matter, and the reading cannot be chosen under binding. A small
 * difference stays a label, since the question may mean the words loosely. wildfire-hard-17, 2026-10-16:
 * "all stations, ignoring the fire-monitoring restriction" (2,965) against the faithful 759, a 74% gap, was
 * chosen when only labeled; environment-easy-1's "bathing season" changed the rows by 5% and its expected
 * answer reads it loosely.
 */
export const blockedUnfaithfulWords = (decision: FrameDecision, option: FrameOption): string[] | undefined => {
  const words = unfaithfulWords(decision, option);
  if (!words) return undefined;
  const size = (candidate: FrameOption): number | undefined => candidate.units ?? candidate.rows;
  const own = size(option);
  // Counts are comparable only within one table: environment-hard-20 (2026-10-16) compared a 9-row beach list
  // with 1,132 sample rows and refused the reading that had won the task.
  const faithful = decision.options.filter((candidate) => candidate !== option && candidate.status === "checked"
    && candidate.table === option.table
    && (candidate.unappliedWords ?? []).length === 0 && size(candidate) !== undefined);
  if (own === undefined || faithful.length === 0) return undefined;
  const nearest = Math.min(...faithful.map((candidate) => {
    const other = size(candidate) as number;
    return Math.abs(own - other) / Math.max(own, other, 1);
  }));
  return nearest >= MAX_UNFAITHFUL_GAP ? words : undefined;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

/**
 * The first balanced JSON object in the text. Without a JSON response mode the model may
 * wrap the object in a code fence or follow it with prose (glm-5.3 did in a live run).
 */
const firstJsonObject = (text: string): string => {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("no JSON object in the proposal");
  }
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}" && (depth -= 1) === 0) {
      return text.slice(start, index + 1);
    }
  }
  throw new Error("unterminated JSON object in the proposal");
};

const unquote = (identifier: string): string => identifier.trim().replace(/^"(.*)"$/u, "$1").replace(/""/gu, '"');

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const recordString = (value: unknown, key: string): string | undefined => {
  const field = recordValue(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
};
