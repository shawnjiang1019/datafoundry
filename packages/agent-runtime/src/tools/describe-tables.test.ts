import type { DataGateway } from "@datafoundry/data-gateway";
import { describe, expect, it } from "vitest";

import { buildAgentInstructions } from "../index.js";
import { createDataFoundryToolRegistry } from "./data-tools.js";
import { createDescribeTablesTool, DESCRIBE_TABLES_TOOL_NAME, describeTablesInputSchema } from "./describe-tables.js";
import {
  describeTables,
  envAnnotationDeliveryFromEnvironment,
  envAnnotationForTables,
  envAnnotationIndexForTables,
  parseEnvAnnotation,
  type EnvAnnotation,
  type EnvAnnotationDelivery
} from "./env-annotation.js";

const CLINICAL = "1_s2_0_S0092867420301070_mmc1";
const PHOSPHO = "1_s2_0_S0092867420301070_mmc3__F_SS_phospho";
const ALL_LAYERS = ["author_text", "descriptions", "table_edges"] as const;

const exported = {
  environment_id: "env-1",
  tables: {
    [CLINICAL]: {
      columns: {
        idx: { type: "str", roles: ["identifier"], role_details: {}, value_sample: ["'S001'"], cardinality: "high" },
        Case_excluded: {
          type: "str",
          roles: ["eligibility_flag"],
          role_details: { eligibility_flag: { keep_value: "'No'" } },
          value_sample: ["'No'", "'Yes'"],
          cardinality: "low"
        },
        Age: { type: "float", roles: [], role_details: {}, value_sample: ["61.0"], cardinality: "medium" }
      },
      links: [{ column: "idx", other_table: PHOSPHO, other_column: "Gene", kind: "join_candidate", signals: ["value_format"], score: 0.5 }]
    },
    [PHOSPHO]: {
      columns: { Gene: { type: "str", roles: [], role_details: {}, value_sample: ["'ABCF1'"], cardinality: "high" } },
      links: []
    },
    plain: { columns: { x: { type: "int", roles: [] } }, links: [] }
  },
  author_text: {
    [CLINICAL]: { table: [{ kind: "readme", text: "Clinical data for 153 cases.", source: "mmc1__README#1" }], columns: {} }
  },
  descriptions: {
    tables: {
      [CLINICAL]: {
        summary: { text: "One row per case.", verdict: "inferred" },
        columns: { Case_excluded: { text: "'Yes' marks excluded cases.", verdict: "inferred" } }
      }
    }
  },
  table_edges: {
    edges: [{
      left: CLINICAL, right: PHOSPHO, left_to_right: 0.5, right_to_left: 1,
      support_left_to_right: 1, support_right_to_left: 1, via: [["idx", "Gene"]], value_only: false
    }]
  }
};

const annotation: EnvAnnotation = parseEnvAnnotation(exported, [...ALL_LAYERS])!;

const createRegistry = (envAnnotationDelivery: EnvAnnotationDelivery) =>
  createDataFoundryToolRegistry({
    dataGateway: {
      inspectSchema: async () => ({
        datasource_id: "bio",
        dialect: "duckdb",
        tables: [CLINICAL, PHOSPHO, "plain"].map((name) => ({ name, columns: [{ name: "c", type: "VARCHAR" }] }))
      }),
      previewTable: async () => ({ columns: ["c"], rows: [["v"]] })
    } as unknown as DataGateway,
    emitter: { emit: () => undefined },
    runContext: {
      user_id: "user-1", workspace_id: "workspace-1", session_id: "session-1", run_id: "run-1", user_input: "q",
      chat_mode: "copilotkit", enabled_datasource_ids: ["bio"], selected_datasource_id: "bio", model_name: "m"
    },
    envAnnotation: annotation,
    envAnnotationDelivery
  });

describe("describe_tables", () => {
  it("returns every default section with the notes that qualify them", () => {
    const result = describeTables(annotation, [CLINICAL], { maxChars: 12000 }) as {
      tables: Record<string, Record<string, unknown>>;
      author_text_note?: string;
      descriptions_note?: string;
      related_tables_note?: string;
    };
    expect(Object.keys(result.tables[CLINICAL]!)).toEqual(["roles", "links", "related_tables", "author_text", "descriptions"]);
    expect(result.tables[CLINICAL]!.roles).toEqual({
      eligibility_flags: [{ column: "Case_excluded", keep_value: "'No'" }],
      identifiers: ["idx"]
    });
    expect(result.author_text_note).toBeDefined();
    expect(result.descriptions_note).toBeDefined();
    expect(result.related_tables_note).toBeDefined();
  });

  it("returns only the requested sections and columns", () => {
    const result = describeTables(annotation, [CLINICAL], { sections: ["columns"], columns: ["case_excluded"], maxChars: 12000 }) as {
      tables: Record<string, Record<string, unknown>>;
    };
    expect(result.tables[CLINICAL]).toEqual({
      columns: { Case_excluded: { type: "str", cardinality: "low", roles: ["eligibility_flag"], value_sample: ["'No'", "'Yes'"] } }
    });
  });

  it("reports unknown tables with close matches instead of failing", () => {
    const result = describeTables(annotation, [CLINICAL, "mmc1", "nope"], { maxChars: 12000 }) as {
      tables: Record<string, unknown>;
      unknown_tables?: { name: string; close_matches: string[] }[];
    };
    expect(Object.keys(result.tables)).toEqual([CLINICAL]);
    expect(result.unknown_tables).toEqual([
      { name: "mmc1", close_matches: [CLINICAL] },
      { name: "nope", close_matches: [] }
    ]);
  });

  it("drops whole sections to fit the budget and says what it left out", () => {
    const full = JSON.stringify(describeTables(annotation, [CLINICAL, PHOSPHO], { maxChars: 100000 })).length;
    const result = describeTables(annotation, [CLINICAL, PHOSPHO], { maxChars: full - 40 }) as {
      tables: Record<string, Record<string, unknown>>;
      omitted?: Record<string, string[]>;
    };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(full - 40);
    expect(result.omitted?.[CLINICAL]).toEqual(["descriptions"]);
    expect(result.tables[CLINICAL]).not.toHaveProperty("descriptions");
    expect(result.tables[CLINICAL]).toHaveProperty("roles");
  });

  it("is exposed as a tool that reads the annotation", () => {
    const tool = createDescribeTablesTool(annotation);
    expect(tool.id).toBe(DESCRIBE_TABLES_TOOL_NAME);
    expect(describeTablesInputSchema.safeParse({ table_names: [CLINICAL], sections: ["roles"] }).success).toBe(true);
    expect(describeTablesInputSchema.safeParse({ table_names: [] }).success).toBe(false);
    expect(describeTablesInputSchema.safeParse({ table_names: [CLINICAL], sections: ["rows"] }).success).toBe(false);
  });
});

describe("tool delivery in inspect_schema", () => {
  it("keeps the deciding roles inline and indexes the rest", () => {
    const index = envAnnotationIndexForTables(annotation, [CLINICAL, PHOSPHO, "plain"], 12000) as {
      describe_note: string;
      tables: Record<string, Record<string, unknown>>;
    };
    expect(index.describe_note).toMatch(/describe_tables/u);
    expect(index.tables[CLINICAL]).toEqual({
      eligibility_flags: [{ column: "Case_excluded", keep_value: "'No'" }],
      identifiers: ["idx"],
      more: "describe_tables: 1 link, 1 related table, README/notes, 2 descriptions"
    });
    expect(index.tables[PHOSPHO]).toEqual({ more: "describe_tables: 1 related table" });
    expect(index.tables).not.toHaveProperty("plain");
  });

  it("fits a wide environment by dropping index lines before tables", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${i}`, {
      columns: { flag: { type: "str", roles: ["eligibility_flag"], role_details: { eligibility_flag: { keep_value: "'No'" } } } },
      links: Array.from({ length: 5 }, (__, j) => ({ column: "flag", other_table: `t${j}`, other_column: "flag", kind: "shared_column_name" }))
    }]));
    const wide = parseEnvAnnotation({ tables: many }, [])!;
    const names = Object.keys(many);
    const index = envAnnotationIndexForTables(wide, names, 3000) as { tables: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(index).length).toBeLessThanOrEqual(3000);
    expect(Object.values(index.tables).every((entry) => entry.eligibility_flags && !entry.more)).toBe(true);
  });

  it("uses the index for inspect_schema but keeps the full block for preview_table", async () => {
    const registry = createRegistry("tool");
    const schema = await registry.inspectSchema({ datasource_id: "bio" });
    const block = schema.env_annotation as { describe_note?: string; tables: Record<string, Record<string, unknown>> };
    expect(block.describe_note).toBeDefined();
    expect(block.tables[CLINICAL]).not.toHaveProperty("links");
    const preview = await registry.previewTable({ schema_id: schema.schema_id, table: CLINICAL }) as {
      env_annotation?: unknown;
    };
    expect(preview.env_annotation).toEqual(envAnnotationForTables(annotation, [CLINICAL]));
  });

  it("keeps today's inline block unless tool delivery is asked for", async () => {
    expect(envAnnotationDeliveryFromEnvironment({})).toBe("inline");
    expect(envAnnotationDeliveryFromEnvironment({ DF_ENV_ANNOTATION_DELIVERY: "tool" })).toBe("tool");
    const schema = await createRegistry("inline").inspectSchema({ datasource_id: "bio" });
    expect(schema.env_annotation).toEqual(envAnnotationForTables(annotation, [CLINICAL, PHOSPHO, "plain"]));
  });
});

describe("describe_tables instructions", () => {
  const baseInput = {
    runContext: {
      user_id: "user-1", workspace_id: "workspace-1", session_id: "session-1", run_id: "run-1", user_input: "q",
      chat_mode: "copilotkit", enabled_datasource_ids: ["bio"], selected_datasource_id: "bio", model_name: "m"
    },
    collaborationToolsEnabled: false,
    commandExecutionEnabled: false,
    taskToolsEnabled: false,
    selectedSkills: [],
    protocolId: "data-analysis",
    mcpToolNames: [],
    analysisRequirements: [],
    workspaceAttachments: []
  } as unknown as Parameters<typeof buildAgentInstructions>[0];

  it("tells the agent to read table notes only when the tool is enabled", () => {
    const data = ["list_data_sources", "inspect_schema", "preview_table", "run_sql_readonly"];
    expect(buildAgentInstructions({ ...baseInput, toolNames: [...data, DESCRIBE_TABLES_TOOL_NAME] }))
      .toContain("Call describe_tables for the tables you plan to query or join");
    expect(buildAgentInstructions({ ...baseInput, toolNames: data })).not.toContain("describe_tables");
  });
});
