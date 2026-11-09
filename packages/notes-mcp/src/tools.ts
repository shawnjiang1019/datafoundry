import {
  checkAnswer,
  checkSqlAgainstNotes,
  groundEvidence,
  isRejectedJoin,
  questionForGrounding,
  renderAnswerFrame,
  renderGroundingForAgent,
  type AnalysisValidationFinding,
  type AnswerFrameProposer
} from "@datafoundry/agent-runtime/grounding";

import { MAX_ROWS, ReadonlySqlError, type NotesDatasource } from "./datasource.js";
import { NotesStore, type NotesEntry } from "./notes-store.js";

/** Challenges per question before check_answer always says ok, as in DataFoundry's double-check. */
export const MAX_CHALLENGES = 2;

/**
 * Without a model, the model's part of the readings is empty and only the readings the data itself
 * defines are built (verified links, exclusion flags). Those, and the measures the data states (a named
 * score column, a stated share), are what the double-check uses. Passing a proposer, even this empty one,
 * is also what turns the measures on.
 */
const NO_MODEL: AnswerFrameProposer = async () => JSON.stringify({ decisions: [] });

export type NotesServiceOptions = {
  /** Data sources by the name agents pass as `datasource`. */
  datasources: Record<string, NotesDatasource>;
  /** A model that proposes further readings of the question; optional. */
  proposeFrame?: AnswerFrameProposer;
  maxChallenges?: number;
  store?: NotesStore;
};

export type Problem = { code: string; message: string; severity: "error" | "warning" };

/** A caller mistake (an unknown data source or notes id), reported to the agent as a tool error. */
export class NotesToolError extends Error {}

export type GroundResult = {
  notes_id: string;
  verified_joins?: Record<string, unknown>;
  readings?: Record<string, unknown>;
  warnings: string[];
};

/**
 * A run_sql reply is cut to about this many characters of rows. Agents read the reply in their
 * context window: a 1,000-row schema listing (75,000 characters) overflowed Claude Code's tool
 * output limit on 2026-11-03, and a smaller agent would choke sooner.
 */
export const MAX_RESULT_CHARS = 20_000;
/** Longer text cells are shortened, so one wide column cannot fill the reply on its own. */
export const MAX_CELL_CHARS = 300;

export type RunSqlResult =
  | {
      status: "ok"; columns: string[]; rows: unknown[][]; row_count: number; problems: Problem[];
      /** Set when the reply holds fewer rows than the query returned. */
      truncated?: { rows_shown: number; note: string };
    }
  | { status: "blocked"; problems: Problem[] }
  | { status: "error"; message: string };

export type CheckAnswerResult =
  | { status: "ok"; note?: string }
  | { status: "challenge"; code: string; message: string; evidence: Record<string, unknown>; challenges_left: number };

/**
 * The four notes tools as plain functions; server.ts exposes them over MCP. Each reuses the
 * DataFoundry code for the same step, so an agent gets the notes a DataFoundry run would get.
 *
 * Only a caller mistake is an error. A failure while grounding or checking returns empty notes or
 * ok: the notes may help an agent, never stop it.
 */
export const createNotesTools = (options: NotesServiceOptions) => {
  const store = options.store ?? new NotesStore();
  const maxChallenges = options.maxChallenges ?? MAX_CHALLENGES;

  const datasourceNamed = (name: string): NotesDatasource => {
    const datasource = options.datasources[name];
    if (!datasource) {
      throw new NotesToolError(`Unknown datasource "${name}". Known: ${Object.keys(options.datasources).join(", ") || "none"}.`);
    }
    return datasource;
  };

  const notesFor = (id: string): NotesEntry => {
    const entry = store.get(id);
    if (!entry) throw new NotesToolError(`Unknown or expired notes_id "${id}". Call ground first.`);
    return entry;
  };

  return {
    /** Facts about the data for one question, each checked in the data. */
    async ground(input: { question: string; datasource: string; show_readings?: boolean | undefined }): Promise<GroundResult> {
      const datasource = datasourceNamed(input.datasource);
      const question = questionForGrounding(input.question);
      const grounding = await groundEvidence(question, {
        inspectSchema: () => datasource.inspectSchema(),
        probe: (sql) => datasource.query(sql, MAX_ROWS),
        lakeCacheKey: datasource.id,
        proposeFrame: options.proposeFrame ?? NO_MODEL
      });
      const entry = store.create({ datasource: input.datasource, question, grounding });
      const joins = renderGroundingForAgent(grounding);
      const readings = input.show_readings ? renderAnswerFrame(grounding.frame) : undefined;
      return {
        notes_id: entry.id,
        ...(joins ? { verified_joins: joins } : {}),
        ...(readings ? { readings } : {}),
        warnings: grounding.warnings
      };
    },

    /**
     * Runs one read-only query. With notes, it is checked first: a join the data proved wrong is
     * blocked, anything else runs with its problems attached, and the query is remembered for
     * check_answer.
     */
    async runSql(input: { sql: string; notes_id?: string | undefined; datasource?: string | undefined }): Promise<RunSqlResult> {
      const entry = input.notes_id ? notesFor(input.notes_id) : undefined;
      const name = entry?.datasource ?? input.datasource;
      if (!name) throw new NotesToolError("Pass notes_id (from ground) or datasource.");
      const datasource = datasourceNamed(name);
      const problems = entry ? safeSqlFindings(input.sql, entry) : [];
      const blocking = problems.filter((problem) => isRejectedJoin(problem));
      if (blocking.length > 0) return { status: "blocked", problems: blocking.map(asProblem) };
      try {
        const result = await datasource.query(input.sql, MAX_ROWS);
        if (entry) entry.lastSql = input.sql;
        const rows = fitRows(result.rows);
        return {
          status: "ok", columns: result.columns, rows, row_count: result.rows.length, problems: problems.map(asProblem),
          ...(rows.length < result.rows.length ? { truncated: {
            rows_shown: rows.length,
            note: `Showing ${rows.length} of ${result.rows.length}${result.rows.length >= MAX_ROWS ? "+" : ""} rows to keep the `
              + "reply small. Filter, aggregate or select fewer columns to see the rest."
          } } : {})
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: "error", message: error instanceof ReadonlySqlError ? `Read-only: ${message}` : message };
      }
    },

    /** The same checks as run_sql, without running the query. Advice only. */
    async checkSql(input: { notes_id: string; sql: string }): Promise<{ problems: Problem[] }> {
      return { problems: safeSqlFindings(input.sql, notesFor(input.notes_id)).map(asProblem) };
    },

    /**
     * The double-check: compares the query the answer came from with readings checked in the data.
     * It reads the SQL, not the answer value, and never knows the correct answer.
     */
    async checkAnswer(input: { notes_id: string; answer?: string | undefined; final_sql?: string | undefined }): Promise<CheckAnswerResult> {
      const entry = store.get(input.notes_id);
      if (!entry) return { status: "ok", note: "No notes for this id; nothing to check." };
      const sql = input.final_sql ?? entry.lastSql;
      if (!sql) return { status: "ok", note: "No SQL to check: pass final_sql, or run queries through run_sql." };
      if (entry.challenges >= maxChallenges) return { status: "ok", note: "Challenge limit reached; the agent's answer stands." };
      try {
        const challenge = checkAnswer({ question: entry.grounding.question ?? entry.question, sql, grounding: entry.grounding });
        if (!challenge) return { status: "ok" };
        entry.challenges += 1;
        return { status: "challenge", ...challenge, challenges_left: maxChallenges - entry.challenges };
      } catch {
        return { status: "ok", note: "The check failed; the answer stands." };
      }
    }
  };
};

export type NotesTools = ReturnType<typeof createNotesTools>;

/** The leading rows that fit in MAX_RESULT_CHARS, with long text cells shortened. */
const fitRows = (rows: unknown[][]): unknown[][] => {
  const kept: unknown[][] = [];
  let size = 0;
  for (const row of rows) {
    const shortened = row.map((cell) => typeof cell === "string" && cell.length > MAX_CELL_CHARS
      ? `${cell.slice(0, MAX_CELL_CHARS)}…` : cell);
    size += JSON.stringify(shortened).length;
    if (size > MAX_RESULT_CHARS && kept.length > 0) break;
    kept.push(shortened);
  }
  return kept;
};

const safeSqlFindings = (sql: string, entry: NotesEntry): AnalysisValidationFinding[] => {
  try {
    return checkSqlAgainstNotes(sql, entry.grounding);
  } catch {
    return [];
  }
};

const asProblem = (finding: AnalysisValidationFinding): Problem => ({
  code: finding.code,
  message: finding.message,
  severity: finding.severity
});
