import { describe, expect, it } from "vitest";

import { InMemoryProtocolStateStore } from "./in-memory-protocol-state-store.js";
import { dataAnalysisExtension, ProtocolExtensionRegistry, type ProtocolExtension } from "./protocol-extensions.js";
import { createRunProtocolBoundary } from "./run-protocol-boundary.js";

/** A stand-in for a protocol that extends data-analysis: same phases, own id, one extra runtime action. */
const fakePlannedExtension = (executed: unknown[] = []): ProtocolExtension => ({
  ...dataAnalysisExtension,
  protocolId: "fake-planned",
  classifierExcluded: true,
  createDefinition: (actionNames, requirements) => {
    const base = dataAnalysisExtension.createDefinition(actionNames, requirements);
    return {
      ...base,
      id: "fake-planned",
      phases: Object.fromEntries(Object.entries(base.phases).map(([name, phase]) => [
        name,
        { ...phase, allowedActions: [...phase.allowedActions, "fake.extension.action"] }
      ]))
    };
  },
  runtimeActions: () => [{
    name: "fake.extension.action",
    exposure: "runtime",
    execute: async (actionInput) => {
      executed.push(actionInput);
      return { ok: true };
    }
  }]
});

const baseInput = (runId: string) => ({
  runId,
  initialContextPackageRef: { packageId: `context-${runId}`, revision: 0 },
  tools: {},
  projectContext: () => ({ packageId: `context-${runId}`, revision: 0 })
});

describe("ProtocolExtensionRegistry", () => {
  it("rejects duplicate protocol ids", () => {
    expect(() => new ProtocolExtensionRegistry([dataAnalysisExtension, dataAnalysisExtension]))
      .toThrow("PROTOCOL_EXTENSION_DUPLICATE:data-analysis");
  });
});

describe("createRunProtocolBoundary extensions", () => {
  it("substitutes a deterministic data-analysis route and dispatches extension runtime actions", async () => {
    const executed: unknown[] = [];
    const boundary = await createRunProtocolBoundary({
      ...baseInput("run-substituted"),
      userInput: "analyze revenue by region",
      authorizedProtocolIds: ["general-task", "data-analysis", "fake-planned"],
      extensions: [fakePlannedExtension(executed)],
      protocolSubstitutions: { "data-analysis": { protocolId: "fake-planned", protocolVersion: "1" } }
    });

    expect(boundary.route.definition.id).toBe("fake-planned");
    expect(boundary.route.reasonCodes).toEqual(["ANALYTIC_INTENT", "PROTOCOL_SUBSTITUTED:data-analysis"]);
    await boundary.actionRouter.execute({
      runId: "run-substituted",
      segmentId: boundary.segmentId,
      actionId: "extension-1",
      actionName: "fake.extension.action",
      input: { probe: 1 }
    });
    expect(executed).toEqual([{ probe: 1 }]);
  });

  it("never substitutes explicit selections or restored segments", async () => {
    const stateStore = new InMemoryProtocolStateStore();
    const input = {
      ...baseInput("run-explicit"),
      userInput: "analyze revenue by region",
      authorizedProtocolIds: ["general-task", "data-analysis", "fake-planned"],
      extensions: [fakePlannedExtension()],
      protocolSubstitutions: { "data-analysis": { protocolId: "fake-planned", protocolVersion: "1" } },
      stateStore
    };
    const explicit = await createRunProtocolBoundary({
      ...input,
      explicitProtocol: { protocolId: "data-analysis", protocolVersion: "1" }
    });
    expect(explicit.route.definition.id).toBe("data-analysis");
    await explicit.dispose();

    const restored = await createRunProtocolBoundary(input);
    expect(restored.route.definition.id).toBe("data-analysis");
    expect(restored.route.reasonCodes).toEqual(["PROTOCOL_SEGMENT_RESTORED"]);
  });

  it("ignores substitutions to unauthorized protocols and registers no unauthorized runtime actions", async () => {
    const boundary = await createRunProtocolBoundary({
      ...baseInput("run-unauthorized"),
      userInput: "analyze revenue by region",
      authorizedProtocolIds: ["general-task", "data-analysis"],
      extensions: [fakePlannedExtension()],
      protocolSubstitutions: { "data-analysis": { protocolId: "fake-planned", protocolVersion: "1" } }
    });

    expect(boundary.route.definition.id).toBe("data-analysis");
    expect(boundary.capabilityRegistry.resolve("fake.extension.action")).toBeUndefined();
    expect(boundary.capabilityRegistry.resolve("data.query.plan")).toBeDefined();
  });
});
