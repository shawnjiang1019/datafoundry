import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataGateway } from "@datafoundry/data-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createToolObservationBoundary } from "../context/tool-observation/tool-observation-boundary.js";
import { ToolObservationDispatcher } from "../context/tool-observation/tool-observation-dispatcher.js";
import { toolObservationModelFromPackage } from "../context/tool-observation/tool-observation-projection-items.js";
import { createDataFoundryToolRegistry } from "./data-tools.js";
import {
  createEnvAnnotationGuard,
  envAnnotationForTables,
  envAnnotationFromEnvironment,
  envAnnotationMaxCharsFromEnvironment,
  parseEnvAnnotation,
  type EnvAnnotation
} from "./env-annotation.js";

const CLINICAL = "1_s2_0_S0092867420301070_mmc1";
const PHOSPHO = "1_s2_0_S0092867420301070_mmc3__F_SS_phospho";

/** Shaped like `dtrail-annotate --export-agent-json` output for the biomedical domain. */
const annotation: EnvAnnotation = parseEnvAnnotation({
  schema_version: "1.2",
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
      links: [{
        column: "idx",
        other_table: PHOSPHO,
        other_column: "Gene",
        kind: "join_candidate",
        signals: ["value_format"],
        score: 0.5
      }]
    },
    [PHOSPHO]: {
      columns: {
        Gene: { type: "str", roles: [], role_details: {}, value_sample: ["'ABCF1'"], cardinality: "high" },
        "FDR.phos": {
          type: "float",
          roles: ["competing_measures"],
          role_details: { competing_measures: { group: ["FDR.phos", "FDR.prot"] } }
        },
        "FDR.prot": {
          type: "float",
          roles: ["competing_measures"],
          role_details: { competing_measures: { group: ["FDR.phos", "FDR.prot"] } }
        }
      },
      links: []
    },
    plain: { columns: { x: { type: "int", roles: [] } }, links: [] }
  }
})!;

const runContext = {
  user_id: "user-1",
  workspace_id: "workspace-1",
  session_id: "session-1",
  run_id: "run-annotation",
  user_input: "analyze",
  chat_mode: "copilotkit",
  enabled_datasource_ids: ["bio"],
  selected_datasource_id: "bio",
  model_name: "test-model"
} as const;

const tableSummary = (name: string) => ({ name, columns: [{ name: "c", type: "VARCHAR" }] });

const createRegistry = (envAnnotation?: EnvAnnotation) => {
  const dataGateway = {
    inspectSchema: async () => ({
      datasource_id: "bio",
      dialect: "duckdb",
      tables: [tableSummary(CLINICAL), tableSummary("plain")]
    }),
    previewTable: async () => ({ columns: ["c"], rows: [["v"]] }),
    runSqlReadonly: async () => ({ columns: ["n"], rows: [[1]], row_count: 1, audit_log_id: "audit-1", elapsed_ms: 1 })
  } as unknown as DataGateway;
  return createDataFoundryToolRegistry({
    dataGateway,
    emitter: { emit: () => undefined },
    runContext: { ...runContext, enabled_datasource_ids: [...runContext.enabled_datasource_ids] },
    ...(envAnnotation ? { envAnnotation } : {})
  });
};

const modelView = (toolName: string, raw: unknown): Record<string, unknown> => {
  const runScope = { modelName: "test", resourceId: "user-1", runId: "run-1", sessionId: "session-1" };
  const boundary = createToolObservationBoundary({ identity: runScope });
  const dispatcher = new ToolObservationDispatcher(boundary.packager, runScope);
  return toolObservationModelFromPackage(dispatcher.dispatch(toolName, raw)) as Record<string, unknown>;
};

describe("env annotation enrichment", () => {
  it("summarizes only the named tables, flags and links included", () => {
    expect(envAnnotationForTables(annotation, [CLINICAL])).toEqual({
      note: expect.any(String),
      tables: {
        [CLINICAL]: {
          eligibility_flags: [{ column: "Case_excluded", keep_value: "'No'" }],
          identifiers: ["idx"],
          links: [`idx -> ${PHOSPHO}.Gene (join_candidate: value_format)`]
        }
      }
    });
    expect(envAnnotationForTables(annotation, [PHOSPHO])?.tables).toEqual({
      [PHOSPHO]: { competing_measures: [["FDR.phos", "FDR.prot"]] }
    });
  });

  it("is absent for tables without roles or links, and capped in size", () => {
    expect(envAnnotationForTables(annotation, ["plain", "unknown"])).toBeUndefined();
    const capped = envAnnotationForTables(annotation, [PHOSPHO, CLINICAL], 260);
    // The eligibility table is kept first; links go before whole tables do.
    expect(Object.keys(capped?.tables as object)).toEqual([CLINICAL]);
    expect(capped).toMatchObject({ omitted_tables: 1 });
    expect((capped?.tables as Record<string, object>)[CLINICAL]).not.toHaveProperty("links");
  });

  it("attaches the annotation to inspect_schema and preview_table results", async () => {
    const registry = createRegistry(annotation);
    const schema = await registry.inspectSchema({ datasource_id: "bio" });
    expect(Object.keys(schema.env_annotation?.tables as object)).toEqual([CLINICAL]);
    const model = modelView("inspect_schema", schema);
    expect(model.env_annotation).toEqual(schema.env_annotation);

    const preview = await registry.previewTable({ schema_id: schema.schema_id, table: CLINICAL });
    expect(modelView("preview_table", preview)).toHaveProperty(["env_annotation", "tables", CLINICAL]);
  });
});

describe("env annotation SQL guard", () => {
  it("warns once when a query reads a flagged table without filtering the flag", () => {
    const guard = createEnvAnnotationGuard(annotation);
    const sql = `SELECT COUNT(*) FROM "${CLINICAL}" WHERE Age > 50`;
    expect(guard.check(sql)).toEqual([
      `Table ${CLINICAL} has eligibility flag Case_excluded (keep 'No') that this query does not filter; `
      + "if the question concerns samples/patients in the study, filter it (Case_excluded = 'No')."
    ]);
    expect(guard.check(sql)).toEqual([]);
  });

  it("stays quiet when the flag is filtered or the table is not read", () => {
    const guard = createEnvAnnotationGuard(annotation);
    expect(guard.check(`SELECT COUNT(*) FROM "${CLINICAL}" c WHERE c.Case_excluded = 'No'`)).toEqual([]);
    expect(guard.check(`SELECT * FROM "${CLINICAL}_other"`)).toEqual([]);
  });

  it("lists the alternatives of a competing measure used alone", () => {
    const guard = createEnvAnnotationGuard(annotation);
    expect(guard.check(`SELECT Gene FROM "${PHOSPHO}" WHERE "FDR.prot" < 0.05`)).toEqual([
      `Column FDR.prot of ${PHOSPHO} has competing variants: FDR.phos; `
      + "confirm FDR.prot is the measure the question asks for."
    ]);
    // Both variants used: the query already chose between them.
    expect(createEnvAnnotationGuard(annotation).check(
      `SELECT "FDR.phos", "FDR.prot" FROM "${PHOSPHO}"`
    )).toEqual([]);
    // A longer name (FDR.protein) or another table's column is not a use.
    expect(createEnvAnnotationGuard(annotation).check(`SELECT "FDR.protein" FROM "${PHOSPHO}"`)).toEqual([]);
    expect(createEnvAnnotationGuard(annotation).check(`SELECT "FDR.prot" FROM other_table`)).toEqual([]);
  });

  it("adds the warnings to run_sql_readonly results without blocking them", async () => {
    const registry = createRegistry(annotation);
    const schema = await registry.inspectSchema({ datasource_id: "bio" });
    const sql = `SELECT COUNT(*) FROM "${CLINICAL}"`;
    const first = await registry.runSqlReadonly({ schema_id: schema.schema_id, sql });
    expect(first.result.row_count).toBe(1);
    expect(first.env_annotation_warnings).toHaveLength(1);
    expect(modelView("run_sql_readonly", first).annotation_warnings).toEqual(first.env_annotation_warnings);

    const repeated = await registry.runSqlReadonly({ schema_id: schema.schema_id, sql });
    expect(repeated).toMatchObject({ cache_hit: true });
    expect(repeated).not.toHaveProperty("env_annotation_warnings");
  });
});

describe("without an annotation", () => {
  it("leaves schema, preview and SQL results unchanged", async () => {
    const registry = createRegistry();
    const schema = await registry.inspectSchema({ datasource_id: "bio" });
    expect(schema).not.toHaveProperty("env_annotation");
    expect(modelView("inspect_schema", schema)).not.toHaveProperty("env_annotation");
    const preview = await registry.previewTable({ schema_id: schema.schema_id, table: CLINICAL });
    expect(preview).toEqual({ datasource_id: "bio", table: CLINICAL, columns: ["c"], rows: [["v"]] });
    const sql = await registry.runSqlReadonly({ schema_id: schema.schema_id, sql: `SELECT * FROM "${CLINICAL}"` });
    expect(sql).toEqual({ result: expect.any(Object), sql: `SELECT * FROM "${CLINICAL}"` });
    expect(modelView("run_sql_readonly", sql)).not.toHaveProperty("annotation_warnings");
  });
});

describe("DF_ENV_ANNOTATION_PATH", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it("loads the exported file, and ignores an unset variable or a malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-env-annotation-"));
    dirs.push(dir);
    const good = join(dir, "annotation.json");
    const bad = join(dir, "bad.json");
    writeFileSync(good, JSON.stringify({ environment_id: "env-1", tables: { t: { columns: {}, links: [] } } }));
    writeFileSync(bad, "{not json");

    expect(envAnnotationFromEnvironment({ DF_ENV_ANNOTATION_PATH: good })).toEqual({
      environment_id: "env-1",
      tables: { t: { columns: {}, links: [] } }
    });
    expect(envAnnotationFromEnvironment({})).toBeUndefined();
    expect(envAnnotationFromEnvironment({ DF_ENV_ANNOTATION_PATH: bad })).toBeUndefined();
    expect(envAnnotationFromEnvironment({ DF_ENV_ANNOTATION_PATH: join(dir, "missing.json") })).toBeUndefined();
    expect(parseEnvAnnotation({ tables: [] })).toBeUndefined();
  });
});

describe("DF_ENV_ANNOTATION_LAYERS", () => {
  const exported = {
    environment_id: "env-1",
    tables: {
      [CLINICAL]: {
        columns: {
          Case_excluded: {
            type: "str",
            roles: ["eligibility_flag"],
            role_details: { eligibility_flag: { keep_value: "'No'" } },
            value_sample: ["'No'", "'Yes'"]
          }
        },
        links: []
      },
      rain: { columns: { Mar: { type: "float" } }, links: [] }
    },
    author_text: {
      rain: {
        table: [{ kind: "footnote", text: "Values are in inches", source: "rain__notes#3" }],
        columns: { Mar: [{ kind: "column", text: "Mar: converted from text", source: "rain__notes#2" }] }
      }
    },
    descriptions: {
      source: "model",
      tables: {
        [CLINICAL]: {
          summary: { text: "One row per case in the study.", verdict: "inferred" },
          columns: { Case_excluded: { text: "'Yes' marks a case excluded from the study.", verdict: "inferred" } }
        },
        rain: { summary: { text: "Monthly rainfall, 2 years.", verdict: "checked" }, columns: {} }
      }
    }
  };

  it("adds no layer unless asked, so existing runs are unchanged", () => {
    const plain = parseEnvAnnotation(exported, [])!;
    expect(plain.tables.rain).toEqual({ columns: { Mar: { type: "float" } }, links: [] });
    expect(envAnnotationForTables(plain, ["rain"])).toBeUndefined();
    const summary = envAnnotationForTables(plain, [CLINICAL]) as { tables: Record<string, unknown> };
    expect(Object.keys(summary)).toEqual(["note", "tables"]);
    expect(summary.tables[CLINICAL]).toEqual({ eligibility_flags: [{ column: "Case_excluded", keep_value: "'No'" }] });
  });

  it("shows author text verbatim and model descriptions labelled, each with its own note", () => {
    const layered = parseEnvAnnotation(exported, ["author_text", "descriptions"])!;
    const summary = envAnnotationForTables(layered, [CLINICAL, "rain"]) as {
      author_text_note?: string;
      model_descriptions_note?: string;
      tables: Record<string, Record<string, unknown>>;
    };
    expect(summary.author_text_note).toContain("word for word");
    expect(summary.model_descriptions_note).toContain("not facts");
    expect(summary.tables.rain?.author_text).toEqual(["Values are in inches", "Mar: converted from text"]);
    expect(summary.tables.rain?.model_descriptions).toEqual({ table: "Monthly rainfall, 2 years. [checked]" });
    expect(summary.tables[CLINICAL]?.model_descriptions).toEqual({
      table: "One row per case in the study. [inferred]",
      columns: { Case_excluded: "'Yes' marks a case excluded from the study. [inferred]" }
    });
    expect(summary.tables[CLINICAL]?.eligibility_flags).toEqual([{ column: "Case_excluded", keep_value: "'No'" }]);
  });

  it("enables each layer on its own", () => {
    const textOnly = envAnnotationForTables(parseEnvAnnotation(exported, ["author_text"])!, ["rain"]) as {
      model_descriptions_note?: string;
      tables: Record<string, Record<string, unknown>>;
    };
    expect(textOnly.tables.rain?.author_text).toBeDefined();
    expect(textOnly.tables.rain?.model_descriptions).toBeUndefined();
    expect(textOnly.model_descriptions_note).toBeUndefined();
  });

  it("drops links, then text, before dropping whole tables to fit the cap", () => {
    const layered = parseEnvAnnotation(exported, ["author_text", "descriptions"])!;
    const small = envAnnotationForTables(layered, [CLINICAL, "rain"], 330) as {
      model_descriptions_note?: string;
      omitted_tables?: number;
      tables: Record<string, Record<string, unknown>>;
    };
    expect(small.omitted_tables).toBeUndefined();
    expect(small.tables[CLINICAL]?.eligibility_flags).toBeDefined();
    expect(small.tables[CLINICAL]?.model_descriptions).toBeUndefined();
    expect(small.model_descriptions_note).toBeUndefined();
  });

  it("never shows less than the base annotation when the text cannot fit", () => {
    const long = (n: number) => `${"word ".repeat(40)}${n}`;
    const crowded = {
      ...exported,
      tables: {
        ...exported.tables,
        [CLINICAL]: {
          ...exported.tables[CLINICAL],
          links: [{ column: "idx", other_table: "assay", other_column: "sample", kind: "join_candidate", score: 0.5 }]
        }
      },
      descriptions: {
        tables: {
          [CLINICAL]: {
            columns: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, { text: long(i), verdict: "inferred" }]))
          }
        }
      }
    };
    const base = envAnnotationForTables(parseEnvAnnotation(crowded, [])!, [CLINICAL], 600) as {
      tables: Record<string, Record<string, unknown>>;
    };
    const layered = envAnnotationForTables(parseEnvAnnotation(crowded, ["descriptions"])!, [CLINICAL], 600) as {
      tables: Record<string, Record<string, unknown>>;
    };
    expect(base.tables[CLINICAL]?.links).toBeDefined();
    expect(layered.tables[CLINICAL]?.links).toEqual(base.tables[CLINICAL]?.links);
  });

  it("orders described columns by role, eligibility flags first", () => {
    const layered = parseEnvAnnotation({
      ...exported,
      descriptions: { tables: { [CLINICAL]: { columns: {
        Age: { text: "Age at diagnosis.", verdict: "inferred" },
        Case_excluded: { text: "'Yes' marks excluded cases.", verdict: "inferred" }
      } } } }
    }, ["descriptions"])!;
    const summary = envAnnotationForTables(layered, [CLINICAL]) as {
      tables: Record<string, { model_descriptions?: { columns?: Record<string, string> } }>;
    };
    expect(Object.keys(summary.tables[CLINICAL]?.model_descriptions?.columns ?? {})).toEqual(["Case_excluded", "Age"]);
  });

  it("shows soft table edges from both ends only with the table_edges layer", () => {
    const withEdges = {
      ...exported,
      table_edges: {
        note: "soft edges",
        edges: [{
          left: CLINICAL,
          right: "rain",
          left_to_right: 0.5,
          right_to_left: 1,
          support_left_to_right: 1,
          support_right_to_left: 1,
          via: [["idx", "sample"]],
          kinds: ["join_candidate"],
          value_only: true,
          summary: "value-only ..."
        }]
      }
    };
    expect(parseEnvAnnotation(withEdges, [])!.tables.rain?.related_tables).toBeUndefined();
    const layered = parseEnvAnnotation(withEdges, ["table_edges"])!;
    expect(layered.tables.rain?.related_tables).toEqual([
      { other_table: CLINICAL, weight: 1, via: [["sample", "idx"]], value_only: true }
    ]);
    const summary = envAnnotationForTables(layered, [CLINICAL, "rain"]) as {
      related_tables_note?: string;
      tables: Record<string, { related_tables?: string[] }>;
    };
    expect(summary.related_tables_note).toMatch(/soft edges/u);
    expect(summary.tables[CLINICAL]?.related_tables).toEqual([
      `rain via idx=sample; 50% of this table's linked columns; value-only (names differ, values match)`
    ]);
  });

  it("lifts the per-table limits when the budget is above the default", () => {
    const layered = parseEnvAnnotation({
      ...exported,
      descriptions: { tables: { [CLINICAL]: {
        columns: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, { text: `Column ${i}.`, verdict: "inferred" }]))
      } } }
    }, ["descriptions"])!;
    const shown = (maxChars: number) => Object.keys((envAnnotationForTables(layered, [CLINICAL], maxChars) as {
      tables: Record<string, { model_descriptions?: { columns?: Record<string, string> } }>;
    }).tables[CLINICAL]?.model_descriptions?.columns ?? {}).length;
    expect(shown(2500)).toBe(8);
    expect(shown(12000)).toBe(12);
  });

  it("reads the budget from the environment variable", () => {
    expect(envAnnotationMaxCharsFromEnvironment({ DF_ENV_ANNOTATION_MAX_CHARS: "12000" })).toBe(12000);
    expect(envAnnotationMaxCharsFromEnvironment({ DF_ENV_ANNOTATION_MAX_CHARS: "lots" })).toBe(2500);
    expect(envAnnotationMaxCharsFromEnvironment({})).toBe(2500);
  });

  it("reads the layers from the environment variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-env-layers-"));
    try {
      const path = join(dir, "annotation.json");
      writeFileSync(path, JSON.stringify(exported));
      const withLayers = envAnnotationFromEnvironment({
        DF_ENV_ANNOTATION_PATH: path,
        DF_ENV_ANNOTATION_LAYERS: "descriptions, unknown"
      })!;
      expect(withLayers.tables.rain?.descriptions?.summary?.text).toBe("Monthly rainfall, 2 years.");
      expect(withLayers.tables.rain?.author_text).toBeUndefined();
      const without = envAnnotationFromEnvironment({ DF_ENV_ANNOTATION_PATH: path })!;
      expect(without.tables.rain?.descriptions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
