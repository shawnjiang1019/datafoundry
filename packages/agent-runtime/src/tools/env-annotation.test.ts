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
