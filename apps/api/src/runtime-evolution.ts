import { join } from "node:path";
import {
  createMastraLessonModel,
  RuntimeEvolution,
  runtimeEvolutionFromEnvironment,
  precheckFeedback,
  summarizeTrajectory,
  takeRunSignals,
  type PrecheckFeedback,
  type ProtocolRunState
} from "@datafoundry/agent-runtime";

/**
 * The API's one RuntimeEvolution (DF_RUNTIME_EVOLUTION=1), shared by every run so all of a user's
 * runs learn into the same lesson file. Undefined when evolution is off.
 */
let instance: RuntimeEvolution | null | undefined;

export const runtimeEvolution = (): RuntimeEvolution | undefined => {
  if (instance === undefined) {
    const options = runtimeEvolutionFromEnvironment(
      process.env,
      join(process.env.STORAGE_ROOT_DIR ?? "storage", "evolution")
    );
    instance = options ? new RuntimeEvolution(options) : null;
    if (options) {
      console.warn(`[evolution] on: learning every ${options.every ?? 3} runs into ${options.dir}`);
    }
  }
  return instance ?? undefined;
};

/** Long enough for one lesson-writer call; a slow model must not hold a finished run for long. */
const LEARN_TIMEOUT_MS = 180_000;

/**
 * Learn from a finished run before it is reported complete, so the next question already starts
 * with the new lessons: DataFoundry's own lessons (DF_RUNTIME_EVOLUTION=1) and feedback for the
 * D-TRAIL pre-check that the run used (DF_DTRAIL_FEEDBACK=1). The two are independent, so each
 * learner can be switched on alone. Never fails the run: errors are logged and the run completes.
 */
export const learnFromFinishedRun = async (input: {
  evolution: RuntimeEvolution | undefined;
  userId: string;
  runId: string;
  sessionId: string;
  question: string;
  state: () => ProtocolRunState | undefined;
  finalText: string;
  model: unknown;
  /** The D-TRAIL run whose receipt this run was given, if any. */
  precheckTaskId?: string | undefined;
}): Promise<void> => {
  const signals = takeRunSignals(input.runId);
  const feedbackOn = process.env.DF_DTRAIL_FEEDBACK === "1" && Boolean(input.precheckTaskId);
  if (!input.evolution && !feedbackOn) return;
  let state: ProtocolRunState | undefined;
  try {
    state = input.state();
  } catch {
    state = undefined;
  }
  const evolution = input.evolution;
  await Promise.all([
    evolution ? withTimeout((async () => {
      const summary = summarizeTrajectory({
        runId: input.runId,
        sessionId: input.sessionId,
        question: input.question,
        state,
        finalText: input.finalText,
        signals
      });
      await evolution.afterRun({ userId: input.userId, summary, model: createMastraLessonModel(input.model) });
    })(), "evolution", input.runId) : undefined,
    feedbackOn ? withTimeout(postPrecheckFeedback(input.precheckTaskId as string,
      precheckFeedback({ question: input.question, state, finalText: input.finalText, signals })), "d-trail feedback", input.runId) : undefined
  ]);
};

/** Send the run's feedback to the D-TRAIL run that made its receipt (DTRAIL_API_URL, DTRAIL_TOKEN). */
const postPrecheckFeedback = async (taskId: string, feedback: PrecheckFeedback): Promise<void> => {
  const base = (process.env.DTRAIL_API_URL ?? "http://127.0.0.1:8061").replace(/\/+$/u, "");
  const response = await fetch(`${base}/runs/${encodeURIComponent(taskId)}/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.DTRAIL_TOKEN ? { authorization: `Bearer ${process.env.DTRAIL_TOKEN}` } : {})
    },
    body: JSON.stringify(feedback),
    signal: AbortSignal.timeout(LEARN_TIMEOUT_MS)
  });
  const body = await response.text();
  console.warn(`[evolution] d-trail feedback for ${taskId}: HTTP ${response.status} ${body.slice(0, 200)}`);
};

/** Run one learning step, bounded in time; log and swallow any failure. */
const withTimeout = async (work: Promise<void>, label: string, runId: string): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("TIMEOUT")), LEARN_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    console.warn(`[evolution] ${label} for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
};

/** The assistant text to read the answer from: the latest message with a FINAL_ANSWER line, else the latest. */
export const finalAssistantText = (texts: Map<string, string>, lastMessageId: string | undefined): string => {
  const ordered = [...texts.values()];
  const withAnswer = [...ordered].reverse().find((text) => /FINAL_ANSWER\s*[:：]/u.test(text));
  return withAnswer ?? (lastMessageId ? texts.get(lastMessageId) : undefined) ?? ordered.at(-1) ?? "";
};

/** The D-TRAIL run id in a run's assumption receipt, if it has one. */
export const precheckTaskIdOf = (receipt: unknown): string | undefined => {
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const taskId = (receipt as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
};
