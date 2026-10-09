import { Agent } from "@mastra/core/agent";
import type { ModelProvider } from "@datafoundry/providers";

import { AGENT_RUNTIME_LIMITS } from "../config/agent-runtime-limits.js";
import type { GroundingSchema, GroundingSqlProbe, SemanticFact } from "./types.js";
import { quoteIdent } from "./vocabulary.js";

const MAX_DECISIONS = 4;
const MAX_OPTIONS = 3;
const MAX_SHOWN_DECISIONS = 3;
const PROPOSAL_ATTEMPTS = 2;
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
    modelSettings: { maxOutputTokens: AGENT_RUNTIME_LIMITS.contractGrounderMaxOutputTokens, temperature: 0 }
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
  "Express each reading as a DuckDB WHERE condition over one table (null when it is the whole table);",
  "it may use IN (SELECT ...) or EXISTS over other tables. key_columns identify one unit in that table.",
  "Use only the tables and columns listed below and double-quote every identifier.",
  "Return only JSON: {\"decisions\": [{\"aspect\": \"unit|population|denominator\", \"question_phrase\": str,",
  "\"options\": [{\"label\": str, \"table\": str, \"sql_where\": str or null, \"key_columns\": [str]}]}]}",
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
 * The agent-facing view. A decision is shown when the data makes it a real choice (two
 * readings select different counts) or when a reading selects nothing as written; a
 * decision whose readings all agree adds nothing and is left out. At most three are shown:
 * readings that select nothing first (the data contradicts them), then population, then
 * denominator, then unit, which offline was the noisiest on pre-aggregated tables.
 */
export const renderAnswerFrame = (
  frame: AnswerFrame | undefined,
  options: { binding?: boolean } = {}
): Record<string, unknown> | undefined => {
  const shown = shownFrameDecisions(frame);
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
            "Binding: pass the id of the reading you chose for every decision in frame_choices on run_sql_readonly",
            "(for example [\"F1.2\", \"F2.1\"]). The SQL that answers the question must then apply that reading's WHERE,",
            "and for a unit with fewer distinct units than rows, compute the answer once per unit (SELECT DISTINCT or GROUP BY its key)."
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
          ...(option.status === "empty" ? { note: "matches no rows as written" } : {})
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
  frame: AnswerFrame | undefined
): Array<{ id: string; decision: FrameDecision }> => {
  const hasEmpty = (decision: FrameDecision) => decision.options.some((option) => option.status === "empty");
  return (frame?.decisions ?? [])
    .filter((decision) => {
      const checked = decision.options.filter((option) => option.status === "checked");
      const distinctCounts = new Set(checked.map((option) => `${option.rows}:${option.units}`));
      return distinctCounts.size > 1 || hasEmpty(decision);
    })
    .sort((a, b) => Number(hasEmpty(b)) - Number(hasEmpty(a)) || ASPECT_PRIORITY[a.aspect] - ASPECT_PRIORITY[b.aspect])
    .slice(0, MAX_SHOWN_DECISIONS)
    .map((decision, index) => ({ id: `F${index + 1}`, decision }));
};

/** Resolve an option id such as "F1.2" against the shown decisions. */
export const resolveFrameChoice = (
  frame: AnswerFrame | undefined,
  choiceId: string
): { decisionId: string; decision: FrameDecision; option: FrameOption } | undefined => {
  const matched = /^(F\d+)\.(\d+)$/u.exec(choiceId.trim());
  if (!matched) return undefined;
  const shown = shownFrameDecisions(frame).find(({ id }) => id === matched[1]);
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
    return [{
      aspect: aspect as FrameAspect,
      questionPhrase: recordString(decision, "question_phrase") ?? "",
      options: options.slice(0, MAX_OPTIONS).flatMap((option): FrameOption[] => {
        const table = unquote(recordString(option, "table") ?? "");
        if (!table) return [];
        const keyColumns = recordValue(option, "key_columns");
        return [{
          label: recordString(option, "label") ?? "",
          table,
          sqlWhere: recordString(option, "sql_where") ?? null,
          keyColumns: Array.isArray(keyColumns)
            ? keyColumns.filter((column): column is string => typeof column === "string" && column.length > 0).map(unquote)
            : []
        }];
      })
    }];
  });
};

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
