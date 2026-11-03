import { z } from "zod";

import {
  ActionRouter,
  type ActionContextProjection,
  type ActionRouterOptions
} from "../capabilities/action-router.js";
import { CapabilityRegistry } from "../capabilities/capability-registry.js";
import { createToolCapabilityPlugin } from "../capabilities/tool-capability-plugin.js";
import type { CapabilityPlugin } from "../capabilities/types.js";
import type { AnalysisRequirementExtractor } from "./model-analysis-requirement-extractor.js";
import type {
  AnalysisContractGrounder,
  AnalysisContractGroundingInput
} from "./model-analysis-contract-grounder.js";
import type { AnalysisRequirement } from "./analysis-requirements.js";
import {
  analysisContractGroundingEventResult,
  semanticResolutionEventResult
} from "./data-analysis-hooks.js";
import { InMemoryProtocolStateStore } from "./in-memory-protocol-state-store.js";
import { STRICT_ANALYSIS_PROTOCOL_IDS } from "./protocol-handoff.js";
import { ProtocolHandoffCoordinator } from "./protocol-handoff-coordinator.js";
import {
  dataAnalysisExtension,
  generalTaskExtension,
  ProtocolExtensionRegistry,
  type ProtocolActionHooks,
  type ProtocolExtension,
  type ProtocolHookContext,
  type ProtocolRuntimeActionDefinition
} from "./protocol-extensions.js";
import { ProtocolRegistry } from "./protocol-registry.js";
import {
  ProtocolRouter,
  type ProtocolClassifier,
  type ProtocolIdentity,
  type ProtocolRouteResult
} from "./protocol-router.js";
import { ProtocolRuntime, type ProtocolRuntimeOptions } from "./protocol-runtime.js";
import type { DataAnalysisState } from "./protocols/data-analysis.js";
import type { GeneralTaskState } from "./protocols/general-task.js";
import type {
  AgentProtocolDefinition,
  ContextPackageRef,
  ProtocolGuardResult,
  ProtocolStateStore
} from "./types.js";
import type { SemanticRequest, SemanticResolution } from "../semantic/types.js";
import {
  resolveToolPlanAvailability,
  type ToolPlanEntry
} from "../tools/tool-plan.js";

type ExistingTool = { execute?: (...args: unknown[]) => unknown | Promise<unknown> };
type RunProtocolDomainState = GeneralTaskState | DataAnalysisState;

export type CreateRunProtocolBoundaryInput = {
  runId: string;
  sessionId?: string;
  userInput: string;
  authorizedProtocolIds: string[];
  initialContextPackageRef: ContextPackageRef;
  tools: Record<string, ExistingTool>;
  /** Complete static agent schema, used to project post-handoff availability. */
  toolPlanEntries?: ToolPlanEntry[];
  explicitProtocol?: ProtocolIdentity;
  classifier?: ProtocolClassifier;
  projectContext: ActionRouterOptions["projectContext"];
  serverPolicy?: ActionRouterOptions["serverPolicy"];
  resourceAuthorization?: ActionRouterOptions["resourceAuthorization"];
  runtimeOptions?: ProtocolRuntimeOptions;
  stateStore?: ProtocolStateStore;
  semanticProvider?: { resolve(request: SemanticRequest): Promise<SemanticResolution> };
  semanticRequest?: Omit<SemanticRequest, "query">;
  requirementExtractor?: AnalysisRequirementExtractor;
  analysisContractGrounder?: AnalysisContractGrounder;
  /** Authoritative session intent (persisted per session, resolved through branch
   * lineage by the caller). Weak continuation follow-ups such as "再次尝试" inherit
   * its protocol deterministically, and its intentText replaces the follow-up
   * wording wherever the run needs the actual task description. */
  sessionIntent?: SessionIntent;
  /** Budgeted background block (see buildHelperContext) forwarded to the protocol
   * classifier as reference material for ambiguous follow-ups. */
  classifierContext?: string;
  /** Additional protocols beyond general-task and data-analysis (e.g. data-analysis-planned). */
  extensions?: ProtocolExtension[];
  /** Route-level substitutions (source protocol id → replacement) applied to
   * non-explicit, non-restored routes and to handoff targets. */
  protocolSubstitutions?: Record<string, ProtocolIdentity>;
};

export type SessionIntent = {
  intentId: string;
  revisionId: string;
  protocolId: string;
  protocolVersion: string;
  intentText: string;
};

export type RunProtocolBoundary = {
  actionRouter: ActionRouter<RunProtocolDomainState>;
  capabilityRegistry: CapabilityRegistry;
  protocolRuntime: ProtocolRuntime<RunProtocolDomainState>;
  handoffCoordinator: ProtocolHandoffCoordinator;
  route: ProtocolRouteResult;
  segmentId: string;
  acknowledgeEvent(event: import("./types.js").ProtocolEvent): void;
  dispose(): Promise<void>;
};

/** Resolve a formal protocol and bind every selected tool to its governed action boundary. */
export const createRunProtocolBoundary = async (
  input: CreateRunProtocolBoundaryInput
): Promise<RunProtocolBoundary> => {
  const actionNames = Object.keys(input.tools);
  const stateStore = input.stateStore ?? new InMemoryProtocolStateStore();
  const persistedState = stateStore.find<RunProtocolDomainState>(input.runId);
  if (persistedState && !input.authorizedProtocolIds.includes(persistedState.protocolId)) {
    throw new Error(`PROTOCOL_NOT_AUTHORIZED:${persistedState.protocolId}@${persistedState.protocolVersion}`);
  }
  if (
    persistedState
    && input.explicitProtocol
    && (input.explicitProtocol.protocolId !== persistedState.protocolId
      || input.explicitProtocol.protocolVersion !== persistedState.protocolVersion)
  ) {
    throw new Error("PROTOCOL_RESUME_SELECTION_MISMATCH");
  }
  // Routing needs only protocol identities, so definitions register requirement-free
  // and the data-analysis definition is rebuilt once extraction has run. Extraction
  // itself happens after routing: whether to extract is the route's decision, not a
  // keyword guess about one sentence.
  const extensions = new ProtocolExtensionRegistry([
    generalTaskExtension,
    dataAnalysisExtension,
    ...(input.extensions ?? [])
  ]);
  const requirementExtensions = extensions.list().filter((extension) => extension.extractsRequirements);
  const authorizedExtensions = extensions.list()
    .filter((extension) => input.authorizedProtocolIds.includes(extension.protocolId));
  const protocolRegistry = new ProtocolRegistry();
  for (const extension of extensions.list()) {
    protocolRegistry.register(extension.createDefinition(actionNames, []));
  }
  const router = new ProtocolRouter(protocolRegistry, {
    ...(input.classifier ? { classifier: input.classifier } : {}),
    classifierExcludedProtocolIds: extensions.list()
      .filter((extension) => extension.classifierExcluded)
      .map((extension) => extension.protocolId)
  });
  const substitute = (identity: ProtocolIdentity): ProtocolIdentity => {
    const replacement = input.protocolSubstitutions?.[identity.protocolId];
    return replacement && input.authorizedProtocolIds.includes(replacement.protocolId) ? replacement : identity;
  };
  let route: ProtocolRouteResult;
  try {
    route = await router.route({
      authorizedProtocolIds: input.authorizedProtocolIds,
      ...(!persistedState && input.explicitProtocol
        ? {
            explicit: {
              ...input.explicitProtocol,
              taskRelation: input.sessionIntent && weakContinuationIntent(input.userInput) ? "continue" : "replace"
            }
          }
        : {}),
      deterministicCandidates: persistedState
        ? [{
            protocolId: persistedState.protocolId,
            protocolVersion: persistedState.protocolVersion,
            priority: 1000,
            reasonCode: "PROTOCOL_SEGMENT_RESTORED",
            taskRelation: "continue" as const
          }]
        : [
            // Session-intent inheritance outranks the keyword accelerator: a recorded
            // intent is a fact about the session, the regex is only a guess about one
            // sentence. Neither requires a model call.
            ...(input.sessionIntent && weakContinuationIntent(input.userInput)
              ? [{
                  protocolId: input.sessionIntent.protocolId,
                  protocolVersion: input.sessionIntent.protocolVersion,
                  priority: 300,
                  reasonCode: "SESSION_INTENT_INHERITED",
                  taskRelation: "continue" as const
                }]
              : []),
            ...(!input.sessionIntent && analyticIntent(input.userInput)
              ? [{
                  protocolId: "data-analysis",
                  protocolVersion: "1",
                  priority: 100,
                  reasonCode: "ANALYTIC_INTENT",
                  taskRelation: "replace" as const
                }]
              : [])
          ],
      classificationInput: {
        userText: input.userInput,
        ...(input.sessionIntent
          ? {
              sessionIntent: {
                protocolId: input.sessionIntent.protocolId,
                protocolVersion: input.sessionIntent.protocolVersion,
                intentText: input.sessionIntent.intentText.slice(0, 300)
              }
            }
          : {}),
        ...(input.classifierContext ? { background: input.classifierContext } : {})
      }
    });
  } catch (error) {
    input.runtimeOptions?.onEvent?.({
      eventId: `${input.runId}:segment:1:0:protocol.route.failed`,
      type: "protocol.route.failed",
      runId: input.runId,
      segmentId: `${input.runId}:segment:1`,
      protocolId: "unresolved",
      protocolVersion: "0",
      revision: 0,
      payload: { reason: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
  if (!persistedState && route.source !== "explicit") {
    const substituted = substitute({
      protocolId: route.definition.id,
      protocolVersion: route.definition.version
    });
    const substitutedDefinition = substituted.protocolId === route.definition.id
      ? undefined
      : protocolRegistry.find(substituted.protocolId, substituted.protocolVersion);
    if (substitutedDefinition) {
      route = {
        ...route,
        definition: substitutedDefinition,
        reasonCodes: [...route.reasonCodes, `PROTOCOL_SUBSTITUTED:${route.definition.id}`]
      };
    }
  }
  const intentText = effectiveIntentText(input, route.taskRelation);
  let userRequirements: AnalysisRequirement[] = [];
  let requirementsExtracted = Boolean(persistedState);
  const extractRequirementsInto = async (): Promise<void> => {
    if (requirementsExtracted || !input.requirementExtractor) {
      return;
    }
    requirementsExtracted = true;
    userRequirements = await input.requirementExtractor({ userText: intentText }) ?? [];
    if (userRequirements.length > 0) {
      for (const extension of requirementExtensions) {
        protocolRegistry.replace(extension.createDefinition(actionNames, userRequirements));
      }
    }
  };
  if (extensions.get(route.definition.id).extractsRequirements) {
    await extractRequirementsInto();
    const refreshed = protocolRegistry.find(route.definition.id, route.definition.version);
    if (refreshed) {
      route = { ...route, definition: refreshed };
    }
  }
  let activeProtocolId = route.definition.id;
  const reduceAction = (state: unknown, actionName: string, result: unknown): unknown =>
    extensions.get(activeProtocolId).reduce(state, actionName, result);
  let segmentId = persistedState?.segmentId ?? `${input.runId}:segment:1`;
  // Hooks and runtime actions read the active segment lazily: a handoff swaps both.
  const hookContext: ProtocolHookContext = {
    runId: input.runId,
    intentText,
    tools: input.tools,
    ...(input.semanticProvider ? { semanticProvider: input.semanticProvider } : {}),
    ...(input.semanticRequest ? { semanticRequest: input.semanticRequest } : {}),
    getDomain: () => protocolRuntime.getState(input.runId, segmentId).domain
  };
  const hooksByProtocol = new Map<string, ProtocolActionHooks>();
  const activeHooks = (): ProtocolActionHooks => {
    let hooks = hooksByProtocol.get(activeProtocolId);
    if (!hooks) {
      hooks = extensions.get(activeProtocolId).createHooks?.(hookContext) ?? {};
      hooksByProtocol.set(activeProtocolId, hooks);
    }
    return hooks;
  };
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.register(createToolCapabilityPlugin({
    id: "selected-run-tools",
    tools: input.tools,
    reduceAction
  }));
  capabilityRegistry.register(createRuntimeActionPlugin(
    reduceAction,
    input.semanticProvider,
    input.analysisContractGrounder,
    authorizedExtensions.flatMap((extension) => extension.runtimeActions?.(hookContext) ?? [])
  ));
  await capabilityRegistry.initialize();
  const runtimeOptions: ProtocolRuntimeOptions = {
    ...(input.runtimeOptions ?? {}),
    maxActions: input.runtimeOptions?.maxActions ?? extensions.get(route.definition.id).maxProtocolActions,
    ...(!persistedState
      ? {
          startEvents: [
            {
              type: "protocol.route.requested",
              payload: {
                authorizedProtocolIds: input.authorizedProtocolIds,
                explicit: input.explicitProtocol
              }
            },
            ...(route.source === "classifier"
              ? [{
                  type: "protocol.route.classified",
                  payload: { reasonCodes: route.reasonCodes, warnings: route.warnings }
                }]
              : []),
            {
              type: "protocol.route.resolved",
              payload: {
                protocolId: route.definition.id,
                protocolVersion: route.definition.version,
                reasonCodes: route.reasonCodes,
                source: route.source,
                taskRelation: route.taskRelation,
                warnings: route.warnings
              }
            },
            ...(extensions.get(route.definition.id).extractsRequirements && userRequirements.length > 0
              ? [{
                  type: "analysis.requirements.extracted",
                  payload: {
                    requirements: userRequirements.map((requirement) => ({
                      id: requirement.id,
                      kind: requirement.kind,
                      description: requirement.description,
                      required: requirement.required,
                      assertions: requirement.assertions.map((assertion) => ({
                        id: assertion.id,
                        kind: assertion.kind,
                        required: assertion.required
                      }))
                    }))
                  }
                }]
              : [])
          ]
        }
      : {})
  };
  let protocolRuntime = new ProtocolRuntime(
    route.definition as AgentProtocolDefinition<RunProtocolDomainState>,
    stateStore,
    runtimeOptions
  );
  try {
    if (persistedState) {
      protocolRuntime.restore(input.runId, segmentId);
    } else {
      protocolRuntime.start({
        runId: input.runId,
        segmentId,
        contextPackageRef: input.initialContextPackageRef
      });
    }
  } catch (error) {
    await capabilityRegistry.dispose();
    throw error;
  }
  const handoffCoordinator = new ProtocolHandoffCoordinator(protocolRegistry, stateStore, {
    ...(runtimeOptions.onEvent ? { onEvent: runtimeOptions.onEvent } : {})
  });
  const actionRouter = new ActionRouter(capabilityRegistry, protocolRuntime, {
    automaticActions: (actionInput) => activeHooks().automaticActions?.(actionInput) ?? [],
    preparatoryActions: (actionInput) => activeHooks().preparatoryActions?.(actionInput) ?? [],
    afterPreparatoryActions: (actionInput) => activeHooks().afterPreparatoryActions?.(actionInput),
    serverPolicy: input.serverPolicy ?? allowAction,
    ...(input.resourceAuthorization ? { resourceAuthorization: input.resourceAuthorization } : {}),
    projectContext: input.projectContext,
    projectFinalObservation: ({ actionName, domain, observation, rawResult }) =>
      actionName === "protocol.handoff.propose"
        ? handoffObservation({
            observation,
            protocolId: activeProtocolId,
            phase: protocolRuntime.getState(input.runId, segmentId).phase,
            allowedActions: protocolRuntime.allowedActions(input.runId, segmentId),
            toolPlanEntries: input.toolPlanEntries ?? actionNames.map((name) => ({
              name,
              source: "selected-run-tools",
              exposed: true,
              availability: "available" as const,
              reasons: ["source:selected-run-tools"]
            }))
          })
        : activeHooks().projectFinalObservation?.({ actionName, domain, observation, rawResult }) ?? observation,
    projectProtocolEventResult: ({ actionName, rawResult }) => {
      const protocolResult = activeHooks().projectProtocolEventResult?.({ actionName, rawResult });
      if (protocolResult !== undefined) {
        return protocolResult;
      }
      if (actionName === "semantic.context.resolve") {
        return semanticResolutionEventResult(rawResult);
      }
      return actionName === "analysis.contract.ground"
        ? analysisContractGroundingEventResult(rawResult)
        : undefined;
    },
    afterAction: async ({ actionName, rawResult }) => {
      if (actionName !== "protocol.handoff.propose") {
        return;
      }
      const proposedProtocolId = directString(rawResult, "targetProtocolId");
      const proposedProtocolVersion = directString(rawResult, "targetProtocolVersion");
      if (!proposedProtocolId || !proposedProtocolVersion) {
        throw new Error("PROTOCOL_HANDOFF_PROPOSAL_INVALID");
      }
      const { protocolId: targetProtocolId, protocolVersion: targetProtocolVersion } = substitute({
        protocolId: proposedProtocolId,
        protocolVersion: proposedProtocolVersion
      });
      if (extensions.find(targetProtocolId)?.extractsRequirements) {
        // A general-task run handing off to data-analysis still owes the analysis its
        // requirements; extract them now so the new segment starts with a full contract.
        await extractRequirementsInto();
      }
      const current = protocolRuntime.getState(input.runId, segmentId);
      const transitionKind = route.source === "classifier"
        && route.taskRelation === "replace"
        && STRICT_ANALYSIS_PROTOCOL_IDS.includes(current.protocolId)
        && targetProtocolId === "general-task"
        && current.phase === route.definition.initialPhase
        ? "route-correction" as const
        : "continue" as const;
      const handoff = handoffCoordinator.handoff({
        runId: input.runId,
        segmentId,
        expectedRevision: current.revision,
        authorizedProtocolIds: input.authorizedProtocolIds,
        target: { protocolId: targetProtocolId, protocolVersion: targetProtocolVersion },
        reasonCodes: recordStringArray(rawResult, "reasonCodes"),
        transitionKind,
        ...(input.sessionId
          ? {
              intentTransition: {
                sessionId: input.sessionId,
                sourceRunId: input.runId,
                userInput: input.userInput,
                taskRelation: route.taskRelation,
                targetProtocolId,
                targetProtocolVersion
              }
            }
          : {})
      });
      const targetDefinition = protocolRegistry.find(targetProtocolId, targetProtocolVersion);
      if (!targetDefinition) {
        throw new Error("PROTOCOL_HANDOFF_TARGET_UNAVAILABLE");
      }
      activeProtocolId = targetProtocolId;
      segmentId = handoff.next.segmentId;
      protocolRuntime = new ProtocolRuntime(
        targetDefinition as AgentProtocolDefinition<RunProtocolDomainState>,
        stateStore,
        { ...runtimeOptions, startEvents: [] }
      );
      protocolRuntime.restore(input.runId, segmentId);
      actionRouter.replaceProtocolRuntime(protocolRuntime);
    }
  });
  return {
    actionRouter,
    capabilityRegistry,
    handoffCoordinator,
    route,
    get protocolRuntime() {
      return protocolRuntime;
    },
    get segmentId() {
      return segmentId;
    },
    acknowledgeEvent: (event) => stateStore.acknowledgeEvent(event),
    dispose: () => capabilityRegistry.dispose()
  };
};

const createRuntimeActionPlugin = (
  reduceAction: (state: unknown, actionName: string, result: unknown) => unknown,
  semanticProvider?: { resolve(request: SemanticRequest): Promise<SemanticResolution> },
  analysisContractGrounder?: AnalysisContractGrounder,
  extensionActions: ProtocolRuntimeActionDefinition[] = []
): CapabilityPlugin => {
  const names = [
    "general.answer.commit",
    "protocol.handoff.propose",
    "semantic.context.resolve",
    "analysis.contract.ground",
    "data.query.plan",
    "data.query.validate",
    "analysis.result.validate",
    "analysis.evidence.bind",
    "analysis.requirements.commit"
  ];
  const extensionNames = extensionActions.map((action) => action.name);
  const collision = extensionNames.find((name, index) =>
    names.includes(name) || extensionNames.indexOf(name) !== index);
  if (collision) {
    throw new Error(`PROTOCOL_RUNTIME_ACTION_DUPLICATE:${collision}`);
  }
  return {
    manifest: { id: "protocol-runtime-actions", version: "1", provides: [...names, ...extensionNames] },
    actions: [
      ...names.map((name) => ({
        name,
        exposure: name === "protocol.handoff.propose" || name === "analysis.requirements.commit"
          ? "agent" as const
          : "runtime" as const,
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        idempotency: "supported" as const,
        execute: async (_context: unknown, actionInput: unknown) => executeRuntimeAction(
          name,
          actionInput,
          semanticProvider,
          analysisContractGrounder
        ),
        reduce: (state: unknown, result: unknown) => reduceAction(state, name, result)
      })),
      ...extensionActions.map((action) => ({
        name: action.name,
        exposure: action.exposure,
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        idempotency: "supported" as const,
        execute: async (context: { abortSignal?: AbortSignal }, actionInput: unknown) => action.execute(
          actionInput,
          context.abortSignal ? { abortSignal: context.abortSignal } : {}
        ),
        reduce: (state: unknown, result: unknown) => reduceAction(state, action.name, result)
      }))
    ]
  };
};

const executeRuntimeAction = async (
  name: string,
  actionInput: unknown,
  semanticProvider?: { resolve(request: SemanticRequest): Promise<SemanticResolution> },
  analysisContractGrounder?: AnalysisContractGrounder
): Promise<unknown> => {
  if (name === "semantic.context.resolve" && semanticProvider) {
    return semanticProvider.resolve(actionInput as SemanticRequest);
  }
  if (name === "analysis.contract.ground") {
    const groundingInput = actionInput as AnalysisContractGroundingInput;
    const result = analysisContractGrounder
      ? await analysisContractGrounder(groundingInput)
      : { requirements: groundingInput.requirements, findings: [] };
    return {
      ...result,
      datasourceRevision: groundingInput.datasourceRevision,
      schema_id: directString(groundingInput.physicalSchema, "schema_id")
        ?? directString(groundingInput.physicalSchema, "schemaId")
    };
  }
  if (name === "data.query.validate") {
    const sql = directString(actionInput, "sql");
    const schemaId = directString(actionInput, "schema_id") ?? directString(actionInput, "schemaId");
    const sqlReasons = validateReadonlySql(sql);
    return {
      valid: Boolean(sql && schemaId && sqlReasons.length === 0),
      reasons: [
        ...(sql ? [] : ["SQL_REQUIRED"]),
        ...(schemaId ? [] : ["SCHEMA_ID_REQUIRED"]),
        ...sqlReasons
      ]
    };
  }
  return actionInput;
};

const validateReadonlySql = (sql: string | undefined): string[] => {
  if (!sql) {
    return [];
  }
  const normalized = stripLeadingSqlComments(sql).trim().replace(/;\s*$/u, "");
  const reasons: string[] = [];
  if (!/^(?:select|with)\b/iu.test(normalized)) {
    reasons.push("SQL_NOT_READ_ONLY");
  }
  if (
    /\b(?:insert|update|delete|drop|alter|create|grant|revoke|copy|call|pragma|attach|detach|vacuum|truncate|merge)\b/iu
      .test(normalized)
  ) {
    reasons.push("SQL_MUTATION_KEYWORD_FORBIDDEN");
  }
  if (normalized.includes(";")) {
    reasons.push("SQL_MULTIPLE_STATEMENTS_FORBIDDEN");
  }
  return reasons;
};

const stripLeadingSqlComments = (sql: string): string => {
  let remaining = sql.trimStart();
  while (remaining.startsWith("--") || remaining.startsWith("/*")) {
    if (remaining.startsWith("--")) {
      const lineEnd = remaining.indexOf("\n");
      remaining = lineEnd < 0 ? "" : remaining.slice(lineEnd + 1).trimStart();
      continue;
    }
    const blockEnd = remaining.indexOf("*/", 2);
    remaining = blockEnd < 0 ? "" : remaining.slice(blockEnd + 2).trimStart();
  }
  return remaining;
};

/**
 * Routing ACCELERATOR only: a keyword hit skips the classifier call for obviously
 * analytic requests. It gates no quality-critical path — requirement extraction and
 * semantic grounding follow the resolved route, never this regex — so a miss costs
 * one classifier call and a false hit is corrected by session-intent inheritance.
 */
const analyticIntent = (userInput: string): boolean =>
  /\b(?:sql|queries?|metrics?|analytics?|analyz(?:e|ing|ed)?|analys(?:e|is|ing|ed)|statistics?|data\s+(?:analysis|query)|revenue\s+trend|group\s+by|cohort\s+analysis|retention\s+analysis|conversion\s+funnel)\b|分析|统计|查询数据|指标分析|(?:计算.*(?:数据|订单|利润|指标))|销售额分析|营收分析|订单量分析|环比分析|同比分析|留存分析|转化漏斗/iu
    .test(userInput);

/**
 * The task description this run should analyze: the recorded session intent for a
 * weak continuation follow-up (with the follow-up appended as a trailing note), or
 * the user's own words whenever they carry a task of their own.
 */
const effectiveIntentText = (
  input: CreateRunProtocolBoundaryInput,
  taskRelation: import("./protocol-router.js").TaskRelation
): string => input.sessionIntent && taskRelation === "continue"
  ? `${input.sessionIntent.intentText}\n(后续指示: ${input.userInput})`
  : input.sessionIntent && taskRelation === "refine"
    ? `${input.sessionIntent.intentText}\n(补充要求: ${input.userInput})`
    : input.userInput;

/**
 * Short "try again"-style follow-ups that carry no task of their own. They are the
 * canonical case for inheriting the recorded session intent: the words say nothing,
 * the session record says everything. The length cap keeps sentences that add real
 * new instructions out of the deterministic path (the classifier handles those with
 * the session intent as context).
 */
const weakContinuationIntent = (userInput: string): boolean => {
  const normalized = userInput.trim();
  return normalized.length > 0
    && normalized.length <= 24
    && /^(?:请\s*)?(?:再次尝试|再试(?:一次)?|重试(?:一次)?|继续|接着|重来|再来一次|重新来|重新试|重新跑|try again|retry|continue|resume|keep going|one more time)[\s!！?？。,.，]*$/iu
      .test(normalized);
};

const handoffObservation = (input: {
  observation: unknown;
  protocolId: string;
  phase: string;
  allowedActions: string[];
  toolPlanEntries: ToolPlanEntry[];
}): Record<string, unknown> => {
  const snapshot = resolveToolPlanAvailability({
    entries: input.toolPlanEntries,
    protocolId: input.protocolId,
    phase: input.phase,
    allowedActions: input.allowedActions
  });
  return {
    ...(typeof input.observation === "object" && input.observation !== null && !Array.isArray(input.observation)
      ? input.observation as Record<string, unknown>
      : { result: input.observation }),
    activeProtocolId: input.protocolId,
    activePhase: input.phase,
    availableTools: snapshot
      .filter((entry) => entry.exposed && entry.availability === "available")
      .map((entry) => entry.name),
    protocolDisabledTools: snapshot
      .filter((entry) => entry.exposed && entry.availability === "protocol-disabled")
      .map((entry) => entry.name)
  };
};

const allowAction = (): ProtocolGuardResult => ({ allowed: true });

const directString = (value: unknown, key: string): string | undefined => {
  const field = recordValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const recordStringArray = (value: unknown, key: string): string[] => {
  const field = recordValue(value, key);
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
};

const recordValue = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

export type RunProtocolContextProjection = ContextPackageRef | ActionContextProjection;
