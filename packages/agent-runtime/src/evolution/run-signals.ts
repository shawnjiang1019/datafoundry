/**
 * What happened inside a run that its final state does not show: a completion check sent the agent
 * back, with which answer and why. The checks record here; runtime evolution reads and clears it
 * when the run ends. Process-local and bounded, since it only has to live for one run.
 */

export type RunSignal = {
  /** Which check: answer-form, decision-outcomes, answer-check, answer-committed. */
  source: string;
  /** The FINAL_ANSWER value at the time, when there was one. */
  answer?: string;
  /** The check's reason, shortened. */
  detail: string;
};

const MAX_SIGNALS_PER_RUN = 20;
const MAX_RUNS = 200;
const MAX_DETAIL_CHARS = 300;

const signals = new Map<string, RunSignal[]>();

export const recordRunSignal = (runId: string | undefined, signal: RunSignal): void => {
  if (!runId) return;
  const list = signals.get(runId) ?? [];
  if (list.length >= MAX_SIGNALS_PER_RUN) return;
  list.push({ ...signal, detail: signal.detail.slice(0, MAX_DETAIL_CHARS) });
  signals.set(runId, list);
  // Runs that never end (crashed before evolution read them) must not grow the map forever.
  if (signals.size > MAX_RUNS) {
    const oldest = signals.keys().next().value;
    if (oldest !== undefined) signals.delete(oldest);
  }
};

/** The run's signals, removed from the store. */
export const takeRunSignals = (runId: string): RunSignal[] => {
  const list = signals.get(runId) ?? [];
  signals.delete(runId);
  return list;
};
