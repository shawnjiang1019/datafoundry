import { AGENT_RUNTIME_LIMITS } from "../config/agent-runtime-limits.js";
import type { SemanticRequest, SemanticResolution } from "../semantic/types.js";
import type { AnalysisRequirement } from "./analysis-requirements.js";
import { createDataAnalysisHooks } from "./data-analysis-hooks.js";
import {
  createDataAnalysisProtocol,
  reduceDataAnalysisAction,
  type DataAnalysisState
} from "./protocols/data-analysis.js";
import {
  createGeneralTaskProtocol,
  reduceGeneralTaskAction,
  type GeneralTaskState
} from "./protocols/general-task.js";
import type { AgentProtocolDefinition } from "./types.js";

type ExistingTool = { execute?: (...args: unknown[]) => unknown | Promise<unknown> };

/** Run-scoped facts a protocol's hooks and runtime actions may read. */
export type ProtocolHookContext = {
  runId: string;
  intentText: string;
  tools: Record<string, ExistingTool>;
  semanticProvider?: { resolve(request: SemanticRequest): Promise<SemanticResolution> };
  semanticRequest?: Omit<SemanticRequest, "query">;
  /** Current domain state of the active segment (read at call time). */
  getDomain(): unknown;
};

export type ProtocolActionHooks = {
  automaticActions?(input: {
    actionName: string;
    domain: unknown;
    input: unknown;
    rawResult: unknown;
  }): Array<{ actionName: string; input: unknown }>;
  preparatoryActions?(input: { actionName: string; input: unknown }): Array<{ actionName: string; input: unknown }>;
  afterPreparatoryActions?(input: { actionName: string; domain: unknown; input: unknown; phase: string }): void;
  /** Returns the observation unchanged when the action is not one it projects. */
  projectFinalObservation?(input: {
    actionName: string;
    domain: unknown;
    observation: unknown;
    rawResult: unknown;
  }): unknown;
  /** Returns undefined when the action has no protocol-specific event payload. */
  projectProtocolEventResult?(input: { actionName: string; rawResult: unknown }): unknown;
};

/** A protocol-owned action executed by the runtime (or bound to an agent tool). */
export type ProtocolRuntimeActionDefinition = {
  name: string;
  exposure: "agent" | "runtime";
  execute(actionInput: unknown, context: { abortSignal?: AbortSignal }): Promise<unknown>;
};

/**
 * Everything the run boundary needs to know about one protocol, so routing, reduction,
 * hooks, and budgets dispatch through a registry instead of hard-coded protocol ids.
 */
export type ProtocolExtension = {
  protocolId: string;
  protocolVersion: string;
  createDefinition(actionNames: string[], requirements: AnalysisRequirement[]): AgentProtocolDefinition<any>;
  reduce(state: unknown, actionName: string, result: unknown): unknown;
  /** Whether routing to this protocol extracts user analysis requirements first. */
  extractsRequirements: boolean;
  maxProtocolActions: number;
  /** Never offered to the model protocol classifier; reachable only by explicit
   * selection, restore, or a configured substitution. */
  classifierExcluded?: boolean;
  createHooks?(context: ProtocolHookContext): ProtocolActionHooks;
  runtimeActions?(context: ProtocolHookContext): ProtocolRuntimeActionDefinition[];
};

export const generalTaskExtension: ProtocolExtension = {
  protocolId: "general-task",
  protocolVersion: "1",
  createDefinition: (actionNames) => createGeneralTaskProtocol(actionNames),
  reduce: (state, actionName, result) => reduceGeneralTaskAction(state as GeneralTaskState, actionName, result),
  extractsRequirements: false,
  maxProtocolActions: AGENT_RUNTIME_LIMITS.generalTaskMaxProtocolActions
};

export const dataAnalysisExtension: ProtocolExtension = {
  protocolId: "data-analysis",
  protocolVersion: "1",
  createDefinition: (actionNames, requirements) => createDataAnalysisProtocol(actionNames, requirements),
  reduce: (state, actionName, result) => reduceDataAnalysisAction(state as DataAnalysisState, actionName, result),
  extractsRequirements: true,
  maxProtocolActions: AGENT_RUNTIME_LIMITS.dataAnalysisMaxProtocolActions,
  createHooks: createDataAnalysisHooks
};

export class ProtocolExtensionRegistry {
  private readonly extensions = new Map<string, ProtocolExtension>();

  constructor(extensions: ProtocolExtension[]) {
    for (const extension of extensions) {
      if (this.extensions.has(extension.protocolId)) {
        throw new Error(`PROTOCOL_EXTENSION_DUPLICATE:${extension.protocolId}`);
      }
      this.extensions.set(extension.protocolId, extension);
    }
  }

  list(): ProtocolExtension[] {
    return [...this.extensions.values()];
  }

  find(protocolId: string): ProtocolExtension | undefined {
    return this.extensions.get(protocolId);
  }

  get(protocolId: string): ProtocolExtension {
    const extension = this.extensions.get(protocolId);
    if (!extension) {
      throw new Error(`PROTOCOL_EXTENSION_NOT_FOUND:${protocolId}`);
    }
    return extension;
  }
}
