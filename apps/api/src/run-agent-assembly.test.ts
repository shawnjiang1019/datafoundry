import { beforeEach, describe, expect, it, vi } from "vitest";

const createDataFoundry = vi.fn();

vi.mock("@datafoundry/agent-runtime", () => ({
  createDataFoundry: (input: unknown) => createDataFoundry(input),
  createDataFoundryRunContext: (input: unknown) => input
}));
vi.mock("@ag-ui/mastra", () => ({
  MastraAgent: class {
    constructor(readonly options: unknown) {}
  }
}));

const { createRunAgentAssembly } = await import("./run-agent-assembly.js");

const assemblyInput = (effectiveRunConfig: Record<string, unknown>) => ({
  effectiveRunConfig: {
    enabledDatasourceIds: [],
    fileIds: [],
    enabledKnowledgeIds: [],
    enabledMcpServerIds: [],
    enabledSkillIds: [],
    skillIds: [],
    skillMode: "auto",
    skillPolicy: { deniedToolNames: [], maxSkills: 20, requireUserInvocable: true, strictSkillTools: false },
    skillTags: [],
    evidenceRefs: [],
    ...effectiveRunConfig
  },
  longTermMemories: [],
  mcpRuntime: { servers: [], toolNames: [] },
  messages: [],
  userId: "user-1",
  workspaceId: "default"
}) as unknown as Parameters<typeof createRunAgentAssembly>[0];

describe("createRunAgentAssembly assumption receipt", () => {
  beforeEach(() => {
    createDataFoundry.mockReset();
    createDataFoundry.mockResolvedValue({ agent: {}, governedMessages: [], protocol: {} });
  });

  it("forwards the run config's assumption receipt to the agent runtime", async () => {
    const assumptionReceipt = { task_id: "task_1", trees: [{ status: "refuted" }] };
    await createRunAgentAssembly(assemblyInput({ assumptionReceipt }));

    expect(createDataFoundry.mock.calls[0]?.[0]).toMatchObject({ assumptionReceipt });
  });

  it("omits the field when the run has no receipt", async () => {
    await createRunAgentAssembly(assemblyInput({}));

    expect(createDataFoundry.mock.calls[0]?.[0]).not.toHaveProperty("assumptionReceipt");
  });
});
