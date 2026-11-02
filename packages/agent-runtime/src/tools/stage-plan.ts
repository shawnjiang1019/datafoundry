import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const CONCLUDE_STAGE_TOOL_NAME = "conclude_stage";

/** Where D-Trail's annotation service runs (DF_STAGE_PLAN_URL, optional DF_STAGE_PLAN_TOKEN). */
export type StagePlanConfig = { url: string; token?: string };

type OutputContract = { type: string; description?: string; max_chars: number };

export type StagePlanStage = {
  stage_id: string;
  method: string;
  goal: string;
  inputs: [string, string][];
  outputs: string[];
  context: { tables?: string[] };
  output_contracts: Record<string, OutputContract>;
};

export type StagePlan = { pinned: string[]; stages: StagePlanStage[] };

type Fetch = typeof fetch;

export const stagePlanConfigFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env
): StagePlanConfig | undefined => {
  const url = env.DF_STAGE_PLAN_URL?.trim();
  if (!url) {
    return undefined;
  }
  const token = env.DF_STAGE_PLAN_TOKEN?.trim();
  return { url: url.replace(/\/+$/, ""), ...(token ? { token } : {}) };
};

const post = async (
  config: StagePlanConfig, path: string, body: unknown, fetchImpl: Fetch
): Promise<Record<string, unknown>> => {
  const response = await fetchImpl(`${config.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return (await response.json()) as Record<string, unknown>;
};

/** Ask D-Trail to split the question into stages; undefined when it cannot (the run goes on unplanned). */
export const fetchStagePlan = async (
  config: StagePlanConfig,
  environmentId: string,
  sessionId: string,
  question: string,
  fetchImpl: Fetch = fetch
): Promise<StagePlan | undefined> => {
  try {
    const result = await post(config, `/annotation/${encodeURIComponent(environmentId)}/plan`,
      { session_id: sessionId, question }, fetchImpl);
    const plan = result.plan as StagePlan | undefined;
    return plan && Array.isArray(plan.stages) ? plan : undefined;
  } catch {
    return undefined;
  }
};

/** The plan as an instruction: the stages, what each reads and must report, and the pinned facts. */
export const renderStagePlan = (plan: StagePlan): string => {
  const lines = [
    "Work through this plan in order. When you finish a stage, call conclude_stage with its stage_id and "
      + "its outputs, each of the declared type and size; if it is rejected, fix the outputs and call again. "
      + "Give your final answer only after the last stage is accepted, and make it the last stage's answer."
  ];
  if (plan.pinned.length > 0) {
    lines.push(`Keep throughout: ${plan.pinned.join("; ")}.`);
  }
  for (const stage of plan.stages) {
    const reads = stage.inputs.map(([from, port]) => `${from}.${port}`).join(", ");
    const outputs = Object.entries(stage.output_contracts)
      .map(([port, c]) => `${port} (${c.type}, at most ${c.max_chars} chars)${c.description ? `: ${c.description}` : ""}`)
      .join("; ");
    lines.push(`Stage ${stage.stage_id} (${stage.method}): ${stage.goal}`
      + (stage.context.tables?.length ? ` Tables: ${stage.context.tables.join(", ")}.` : "")
      + (reads ? ` Reads: ${reads}.` : "")
      + ` Report: ${outputs}.`);
  }
  return lines.join("\n");
};

/** conclude_stage: report a finished stage's outputs to D-Trail, which checks them against the plan. */
export const createConcludeStageTool = (
  config: StagePlanConfig,
  environmentId: string,
  sessionId: string,
  fetchImpl: Fetch = fetch
) =>
  createTool({
    id: CONCLUDE_STAGE_TOOL_NAME,
    description: "Report a finished plan stage's outputs. They are checked against the stage's declared "
      + "types and sizes; `accepted: false` lists what to fix. `ready` names the stages that can start next.",
    inputSchema: z.object({
      stage_id: z.string().min(1),
      outputs: z.record(z.string(), z.unknown())
    }),
    execute: async (toolInput) => {
      try {
        return await post(config, `/annotation/${encodeURIComponent(environmentId)}/conclude`,
          { session_id: sessionId, stage_id: toolInput.stage_id, outputs: toolInput.outputs }, fetchImpl);
      } catch (error) {
        return { error: { failure_class: "unreachable", message: String(error) } };
      }
    }
  });
