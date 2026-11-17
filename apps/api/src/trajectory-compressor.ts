import type { CompressedTrajectory } from "@datafoundry/agent-runtime";

/**
 * Client for the trajectory compressor service (text_compresor, `python3 -m dtrail serve`), which runs
 * next to D-TRAIL and DataLink. It reads a finished run from this API's metadata SQLite (read-only)
 * and returns the compressed packet and a failure digest. On when DF_TRAJECTORY_COMPRESSION=1; the
 * service is at COMPRESSOR_URL (default http://127.0.0.1:8071), with COMPRESSOR_TOKEN if it needs one
 * and COMPRESSOR_BUDGET tokens per packet (default: the service's own, 12000).
 */
export const trajectoryCompressionOn = (): boolean => process.env.DF_TRAJECTORY_COMPRESSION === "1";

const TIMEOUT_MS = 60_000;

/** The run compressed, or undefined when compression is off or the service fails (logged, never thrown). */
export const compressRun = async (runId: string): Promise<CompressedTrajectory | undefined> => {
  if (!trajectoryCompressionOn()) return undefined;
  const base = (process.env.COMPRESSOR_URL ?? "http://127.0.0.1:8071").replace(/\/+$/u, "");
  const budget = Number(process.env.COMPRESSOR_BUDGET);
  try {
    const response = await fetch(`${base}/compress`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.COMPRESSOR_TOKEN ? { authorization: `Bearer ${process.env.COMPRESSOR_TOKEN}` } : {})
      },
      body: JSON.stringify({ run_id: runId, ...(Number.isInteger(budget) && budget > 0 ? { budget } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      console.warn(`[compression] run ${runId}: HTTP ${response.status} ${String(body.error ?? "").slice(0, 200)}`);
      return undefined;
    }
    const compressed = parseCompressed(runId, body);
    console.warn(`[compression] run ${runId}: ${compressed.tokens} of ${compressed.sourceTokens} tokens`
      + `${compressed.budgetSatisfied ? "" : " (over budget)"}, ${compressed.failures.length} failure kind(s), ${compressed.unrepaired} never repaired`);
    return compressed;
  } catch (error) {
    console.warn(`[compression] run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

/** The service's JSON reply as a CompressedTrajectory. */
export const parseCompressed = (runId: string, body: Record<string, unknown>): CompressedTrajectory => {
  const digest = (typeof body.digest === "object" && body.digest !== null ? body.digest : {}) as Record<string, unknown>;
  const failures = Array.isArray(digest.failures) ? digest.failures : [];
  return {
    runId,
    text: typeof body.text === "string" ? body.text : "",
    tokens: Number(body.tokens) || 0,
    sourceTokens: Number(body.source_tokens) || 0,
    budgetSatisfied: body.budget_satisfied !== false,
    archive: typeof body.archive === "string" ? body.archive : "",
    failures: failures.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      return [{
        action: String(record.action ?? "unknown"),
        code: String(record.code ?? "FAILED"),
        count: Number(record.count) || 1,
        ...(typeof record.message === "string" && record.message ? { message: record.message } : {}),
        repaired: record.repaired === true
      }];
    }),
    unrepaired: Number(digest.unrepaired) || 0,
    repeated: Number(digest.repeated) || 0
  };
};
