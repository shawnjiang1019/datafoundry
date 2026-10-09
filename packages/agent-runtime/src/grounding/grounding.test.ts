import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAnalysisAssertions } from "../protocol/analysis-contract.js";
import { createUserAnalysisRequirements } from "../protocol/analysis-requirements.js";
import {
  groundingAutomaticActions,
  projectGroundedSchemaObservation,
  semanticResolutionEventResult
} from "../protocol/data-analysis-hooks.js";
import { createDataAnalysisProtocol, reduceDataAnalysisAction } from "../protocol/protocols/data-analysis.js";
import { validateSqlSemantics } from "../protocol/sql-semantic-validator.js";
import { applyGroundingGate } from "./grounding-gate.js";
import {
  EvidenceGroundingProvider,
  groundEvidence,
  renderGroundingForAgent,
  summarizeGrounding,
  verifiedJoinRules
} from "./evidence-grounding-provider.js";
import { readLakeSemantics } from "./lake-semantics.js";
import type { GroundingCandidate, GroundingSchema, GroundingSqlProbe, PhysicalEvidence } from "./types.js";

type DuckConnection = { all(sql: string, callback: (error: Error | null, rows: Record<string, unknown>[]) => void): void };
type DuckDatabase = { connect(): DuckConnection; close(callback: (error: Error | null) => void): void };

// A lake shaped like KramaBench wildfire-hard-17, with invented names and values: fire
// records reference stations by an integer whose only match is a zero-padded VARCHAR
// column in the registry, next to plausible decoy ID columns.
const STATIONS = Array.from({ length: 30 }, (_, index) => 41000 + index * 7);
const REFERENCED = STATIONS.slice(0, 23);

let database: DuckDatabase;
let connection: DuckConnection;

const all = (sql: string): Promise<Record<string, unknown>[]> =>
  new Promise((resolve, reject) => connection.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))));

const probe: GroundingSqlProbe = async (sql) => {
  const rows = await all(sql);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((column) => row[column])) };
};

const schemaOf = async (): Promise<GroundingSchema> => {
  const rows = await all(
    "SELECT table_name, column_name, data_type FROM information_schema.columns ORDER BY table_name, ordinal_position"
  );
  const tables = new Map<string, Array<{ name: string; type: string }>>();
  for (const row of rows) {
    const table = String(row.table_name);
    tables.set(table, [...(tables.get(table) ?? []), { name: String(row.column_name), type: String(row.data_type) }]);
  }
  return { dialect: "duckdb", tables: [...tables].map(([name, columns]) => ({ name, columns })) };
};

const QUESTION = "What is the average elevation of the weather stations used for fire monitoring?";

beforeAll(async () => {
  const loaded = await import("duckdb") as unknown as { default?: { Database: new (path: string) => DuckDatabase } };
  const duckdb = (loaded.default ?? loaded) as { Database: new (path: string) => DuckDatabase };
  database = new duckdb.Database(":memory:");
  connection = database.connect();
  const fireRows = Array.from({ length: 60 }, (_, index) => {
    const station = index < 56 ? REFERENCED[index % REFERENCED.length] : 99000 + index;
    return `('INC-${index}', 'CA', ${station}, ${index * 10})`;
  });
  const registryRows = STATIONS.map((station, index) =>
    `(${index + 1}, ${16777000 + index}, ${19000000 + index}, '0${station}', 'STATION ${index}', ${1000 + index * 50})`);
  for (const statement of [
    "CREATE TABLE fires (incident_number VARCHAR, state VARCHAR, station_ref BIGINT, acres BIGINT)",
    `INSERT INTO fires VALUES ${fireRows.join(", ")}`,
    "CREATE TABLE fires_copy AS SELECT * FROM fires",
    "CREATE TABLE fires_dictionary (\"Variable Name\" VARCHAR, \"Description\" VARCHAR)",
    "INSERT INTO fires_dictionary VALUES "
      + "('incident_number', 'Incident identifying number from the ICS-209 report'), "
      + "('state', 'Two-letter abbreviation of the state where the fire started'), "
      + "('station_ref', 'Remote Automatic Weather Station (RAWS) ID number for weather data'), "
      + "('acres', 'Final fire size in acres as reported at containment')",
    "CREATE TABLE raws_registry (OBJECTID BIGINT, \"Station ID\" BIGINT, \"WX ID\" BIGINT, "
      + "\"NWS ID\" VARCHAR, \"Station Name\" VARCHAR, \"Elevation\" BIGINT)",
    `INSERT INTO raws_registry VALUES ${registryRows.join(", ")}`,
    // Same values as station_ref but no naming or documentation link: must not be proposed.
    "CREATE TABLE gauge_readings (reading BIGINT, unit VARCHAR)",
    `INSERT INTO gauge_readings VALUES ${STATIONS.map((station) => `(${station}, 'mm')`).join(", ")}`,
    // Codes matching another table's headers, without prose: not a dictionary.
    "CREATE TABLE state_codes (code VARCHAR, label VARCHAR)",
    "INSERT INTO state_codes VALUES ('incident_number', 'a'), ('state', 'b'), ('acres', 'c')"
  ]) {
    await all(statement);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => database.close(() => resolve()));
});

describe("readLakeSemantics", () => {
  it("reads column descriptions from a dictionary detected in the data", async () => {
    const lake = await readLakeSemantics(await schemaOf(), probe);

    expect(lake.dictionaryTables).toEqual(["fires_dictionary"]);
    expect(lake.facts).toContainEqual({
      subject: { table: "fires", column: "station_ref" },
      text: "Remote Automatic Weather Station (RAWS) ID number for weather data",
      source: { kind: "dictionary_table", ref: "fires_dictionary.Variable Name = 'station_ref'" },
      extractedBy: "deterministic"
    });
  });

  it("skips a table it cannot read instead of losing the whole lake", async () => {
    const schema = await schemaOf();
    const unreadable = { name: "broken", columns: [{ name: "a", type: "VARCHAR" }, { name: "b", type: "VARCHAR" }] };
    const lake = await readLakeSemantics({ ...schema, tables: [unreadable, ...schema.tables] }, probe);

    expect(lake.dictionaryTables).toEqual(["fires_dictionary"]);
  });

  it("finds tables holding identical rows", async () => {
    const lake = await readLakeSemantics(await schemaOf(), probe);

    expect(lake.duplicateTables).toEqual([["fires", "fires_copy"]]);
  });
});

describe("groundEvidence", () => {
  it("accepts the only key the data supports and rejects the documented decoys", async () => {
    const context = await groundEvidence(QUESTION, { inspectSchema: schemaOf, probe });
    const byTarget = new Map(context.candidates
      .filter((candidate) => candidate.from.column === "station_ref")
      .map((candidate) => [candidate.to.column, candidate]));

    expect(byTarget.get("NWS ID")).toMatchObject({
      from: { table: "fires", column: "station_ref" },
      status: "ACCEPT",
      physicalEvidence: { matched: 23, fromDistinct: 27, form: "numeric", textOnlyContainment: 0 }
    });
    expect(byTarget.get("Station ID")?.status).toBe("REJECT");
    expect(byTarget.get("WX ID")?.status).toBe("REJECT");
    expect(byTarget.get("Station Name")?.status).toBe("REJECT");
    expect(context.candidates.some((candidate) => candidate.to.table === "gauge_readings")).toBe(false);
    expect(context.candidates.some((candidate) => candidate.from.table === "fires_copy")).toBe(false);
  });

  it("gives the answer frame the joins grounding verified", async () => {
    let framePrompt = "";
    const context = await groundEvidence(QUESTION, {
      inspectSchema: schemaOf,
      probe,
      proposeFrame: async (prompt) => {
        framePrompt = prompt;
        return JSON.stringify({ decisions: [] });
      }
    });

    expect(context.frame?.warnings).toEqual(["ANSWER_FRAME_NO_DECISIONS"]);
    expect(framePrompt).toContain("VERIFIED JOINS (checked against the data)");
    expect(framePrompt).toContain(
      "- fires.station_ref -> raws_registry.NWS ID: TRY_CAST(TRIM(CAST(\"fires\".\"station_ref\" AS VARCHAR)) AS DOUBLE) = "
      + "TRY_CAST(TRIM(CAST(\"raws_registry\".\"NWS ID\" AS VARCHAR)) AS DOUBLE)"
    );
    expect(framePrompt).not.toContain("raws_registry.Station ID:");
  });

  it("degrades to a warning instead of failing the run", async () => {
    await expect(groundEvidence(QUESTION, {
      inspectSchema: async () => ({ dialect: "postgres", tables: [] }),
      probe
    })).resolves.toMatchObject({ candidates: [], warnings: ["EVIDENCE_GROUNDING_UNSUPPORTED_DIALECT:postgres"] });

    const blocked = await groundEvidence(QUESTION, {
      inspectSchema: schemaOf,
      probe: async () => { throw new Error("SQL_BLOCKED"); }
    });
    expect(blocked.candidates.length).toBeGreaterThan(0);
    expect(blocked.candidates.every((candidate) =>
      candidate.status === "UNCERTAIN" && candidate.reason === "not validated against the data")).toBe(true);
    expect(renderGroundingForAgent(blocked)).toBeUndefined();

    await expect(groundEvidence(QUESTION, {
      inspectSchema: async () => { throw new Error("SCHEMA_UNAVAILABLE"); },
      probe
    })).resolves.toMatchObject({ candidates: [], warnings: ["EVIDENCE_GROUNDING_FAILED:SCHEMA_UNAVAILABLE"] });
  });
});

describe("renderGroundingForAgent", () => {
  it("shows the non-obvious key with its join condition and the rejected alternatives", async () => {
    const rendered = renderGroundingForAgent(await groundEvidence(QUESTION, { inspectSchema: schemaOf, probe }));
    const relationships = rendered?.relationships as Array<Record<string, unknown>>;

    expect(relationships[0]).toMatchObject({
      from: "fires.station_ref",
      to: "raws_registry.NWS ID",
      status: "ACCEPT",
      documentation: "Remote Automatic Weather Station (RAWS) ID number for weather data",
      join_condition: "TRY_CAST(TRIM(CAST(\"fires\".\"station_ref\" AS VARCHAR)) AS DOUBLE) = "
        + "TRY_CAST(TRIM(CAST(\"raws_registry\".\"NWS ID\" AS VARCHAR)) AS DOUBLE)"
    });
    expect(relationships.filter((item) => item.status === "REJECT").map((item) => item.to)).toEqual(
      expect.arrayContaining(["raws_registry.Station ID", "raws_registry.WX ID"])
    );
    expect(rendered?.notes).toEqual(["fires and fires_copy hold exactly the same rows."]);
  });

  it("shows nothing when grounding found nothing the agent could miss", () => {
    expect(renderGroundingForAgent({ facts: [], candidates: [], duplicateTables: [], warnings: [] })).toBeUndefined();
  });
});

describe("applyGroundingGate", () => {
  const candidate = (to: string, evidence: Partial<PhysicalEvidence>, semantic = true): GroundingCandidate => ({
    from: { table: "a", column: "ref" },
    to: { table: "b", column: to },
    relation: "references",
    relevance: 0.5,
    semanticEvidence: semantic ? [{ rule: "same_name", detail: "test" }] : [],
    physicalEvidence: {
      fromDistinct: 100, toDistinct: 100, toNonNull: 100, matched: 0, containment: 0, form: "text",
      textOnlyContainment: 0, targetUniqueRate: 1, typeCompatible: true, types: "BIGINT->BIGINT", ...evidence
    }
  });

  it("decides each case by one named rule", () => {
    const [incompatible, small, none, accepted, physicalOnly, partial] = applyGroundingGate([
      candidate("t1", { typeCompatible: false, types: "BOOLEAN->BIGINT" }),
      candidate("t2", { toDistinct: 4, matched: 4, containment: 1 }),
      candidate("t3", { matched: 1, containment: 0.01 }),
      candidate("t4", { matched: 95, containment: 0.95 }),
      { ...candidate("t5", { matched: 95, containment: 0.95 }, false), to: { table: "c", column: "t5" } },
      { ...candidate("t6", { matched: 40, containment: 0.4 }), to: { table: "d", column: "t6" } }
    ]);

    expect(incompatible?.status).toBe("REJECT");
    expect(small).toMatchObject({ status: "UNCERTAIN", reason: expect.stringMatching(/^small_domain/u) });
    expect(none).toMatchObject({ status: "REJECT", reason: expect.stringMatching(/^no_value_overlap/u) });
    expect(accepted?.status).toBe("ACCEPT");
    expect(physicalOnly).toMatchObject({ status: "UNCERTAIN", reason: expect.stringMatching(/^physical_only/u) });
    expect(partial).toMatchObject({ status: "UNCERTAIN", reason: expect.stringMatching(/^partial_overlap/u) });
  });

  it("marks two accepted keys into one target table as ambiguous", () => {
    const decided = applyGroundingGate([
      candidate("x", { matched: 90, containment: 0.9 }),
      candidate("y", { matched: 85, containment: 0.85 })
    ]);

    expect(decided.map((item) => item.status)).toEqual(["UNCERTAIN", "UNCERTAIN"]);
    expect(decided[0]?.reason).toMatch(/^ambiguous: 2 columns of b/u);
  });
});

const initialDataAnalysisState = () => createDataAnalysisProtocol([]).createInitialState({
  contextPackageRef: { packageId: "package-1", revision: 1 },
  runId: "run-1"
});

describe("data-analysis protocol wiring", () => {
  it("keeps the grounding from semantic resolution and shows it with the inspected schema", async () => {
    const grounding = await groundEvidence(QUESTION, { inspectSchema: schemaOf, probe });
    const resolution = {
      value: { tables: [], evidence_grounding: grounding },
      capabilities: ["physical-schema", "evidence-grounding"],
      trust: "verified",
      warnings: [],
      provider: "local",
      mode: "fallback",
      datasourceRevision: "1"
    };
    const state = reduceDataAnalysisAction(
      initialDataAnalysisState(),
      "semantic.context.resolve",
      resolution
    );

    expect(state.evidenceGrounding?.candidates.length).toBe(grounding.candidates.length);
    expect(projectGroundedSchemaObservation({ tables: [] }, state)).toMatchObject({
      grounded_relationships: { relationships: expect.arrayContaining([
        expect.objectContaining({ to: "raws_registry.NWS ID", status: "ACCEPT" })
      ]) }
    });
    expect(semanticResolutionEventResult(resolution)).toMatchObject({
      provider: "local",
      evidenceGrounding: { accepted: 1 }
    });
  });

  it("gives the contract grounder only what the agent sees", async () => {
    const state = createDataAnalysisProtocol([], createUserAnalysisRequirements([{
      kind: "metric",
      description: "Average station elevation",
      acceptanceCriteria: ["One number in feet"]
    }])).createInitialState({ contextPackageRef: { packageId: "package-1", revision: 1 }, runId: "run-1" });
    const contractInput = async (question: string) => {
      const grounding = await groundEvidence(question, { inspectSchema: schemaOf, probe });
      const [action] = groundingAutomaticActions({
        actionName: "semantic.context.resolve",
        domain: state,
        input: { physicalSchema: { tables: [] }, datasourceRevision: "1" },
        rawResult: {
          value: { tables: [], evidence_grounding: grounding },
          capabilities: ["physical-schema", "evidence-grounding"],
          mode: "fallback"
        }
      }, { runId: "run-1", intentText: question, tools: {}, getDomain: () => state });
      return (action?.input as { semanticResolution: unknown }).semanticResolution;
    };

    await expect(contractInput(QUESTION)).resolves.toMatchObject({
      value: { tables: [], grounded_relationships: { relationships: expect.any(Array) } },
      capabilities: ["physical-schema", "evidence-grounding"]
    });
    await expect(contractInput("How many acres burned in total?")).resolves.toEqual({
      value: { tables: [] },
      capabilities: ["physical-schema"],
      mode: "fallback"
    });
  });

  it("leaves the schema observation unchanged when grounding is off", () => {
    const state = initialDataAnalysisState();

    expect(projectGroundedSchemaObservation({ tables: [] }, state)).not.toHaveProperty("grounded_relationships");
  });
});

describe("EvidenceGroundingProvider", () => {
  it("extends the existing resolution without changing its mode or trust", async () => {
    let groundings = 0;
    const provider = new EvidenceGroundingProvider(
      {
        resolve: async (request) => ({
          value: { tables: [] },
          capabilities: ["physical-schema"],
          trust: "verified",
          warnings: ["LOCAL_SEMANTIC_LIMITED_TO_PHYSICAL_SCHEMA"],
          provider: "local",
          mode: "fallback",
          datasourceRevision: request.datasourceRevision
        })
      },
      { inspectSchema: async () => { groundings += 1; return schemaOf(); }, probe }
    );
    const request = {
      userId: "u", workspaceId: "w", datasourceId: "lake", datasourceRevision: "1", query: QUESTION
    };

    const first = await provider.resolve(request);
    const second = await provider.resolve(request);

    expect(first).toMatchObject({ provider: "local", mode: "fallback", trust: "verified" });
    expect(first.capabilities).toEqual(["physical-schema", "evidence-grounding"]);
    expect(summarizeGrounding((first.value as { evidence_grounding: never }).evidence_grounding))
      .toMatchObject({ accepted: 1 });
    expect(second.value).toEqual(first.value);
    expect(groundings).toBe(1);
  });
});

describe("note binding", () => {
  const VERIFIED = "TRY_CAST(TRIM(CAST(\"fires\".\"station_ref\" AS VARCHAR)) AS DOUBLE) = "
    + "TRY_CAST(TRIM(CAST(\"raws_registry\".\"NWS ID\" AS VARCHAR)) AS DOUBLE)";

  const contractAssertions = async (binding: boolean) => {
    const grounding = await groundEvidence(QUESTION, { inspectSchema: schemaOf, probe, binding: { joins: binding } });
    const resolved = reduceDataAnalysisAction(initialDataAnalysisState(), "semantic.context.resolve", {
      value: { tables: [], evidence_grounding: grounding },
      capabilities: ["physical-schema", "evidence-grounding"],
      provider: "local",
      mode: "fallback",
      datasourceRevision: "1"
    });
    const requirements = createUserAnalysisRequirements([{
      kind: "metric",
      description: "Average elevation of stations used for fire monitoring",
      acceptanceCriteria: ["One number in feet"]
    }]).map((requirement) => ({
      ...requirement,
      assertions: createAnalysisAssertions(requirement.id, [
        { kind: "metric", description: "elevation of linked stations", sourceTables: ["fires", "raws_registry"] },
        { kind: "metric", description: "registry only", sourceTables: ["raws_registry"] }
      ])
    }));
    const grounded = reduceDataAnalysisAction(resolved, "analysis.contract.ground", { requirements, datasourceRevision: "1" });
    return grounded.requirements?.flatMap((requirement) => requirement.assertions) ?? [];
  };

  it("turns the shown join into a rule and forbids the rejected keys shown beside it", async () => {
    const grounding = await groundEvidence(QUESTION, { inspectSchema: schemaOf, probe, binding: { joins: true } });
    const [pair] = verifiedJoinRules(grounding);

    expect(pair?.tables).toEqual(["fires", "raws_registry"]);
    expect(pair?.rules[0]).toEqual({
      kind: "join",
      tables: ["fires", "raws_registry"],
      anyOf: [{
        left: { table: "fires", column: "station_ref" },
        right: { table: "raws_registry", column: "NWS ID" },
        compare: "numeric"
      }],
      condition: VERIFIED
    });
    expect(pair?.rules.filter((rule) => rule.kind === "avoid_join").map((rule) =>
      rule.kind === "avoid_join" ? rule.key.right.column : "")).toEqual(expect.arrayContaining(["Station ID", "WX ID"]));
  });

  it("adds the rules only to assertions over both tables, and only when binding is on", async () => {
    const [both, registryOnly] = await contractAssertions(true);
    const [unbound] = await contractAssertions(false);

    expect(both?.sqlConstraints.some((constraint) => constraint.kind === "join")).toBe(true);
    expect(registryOnly?.sqlConstraints).toEqual([]);
    expect(unbound?.sqlConstraints).toEqual([]);
  });

  describe("the SQL gate", () => {
    const codes = async (sql: string) => {
      const [both] = await contractAssertions(true);
      return validateSqlSemantics(sql, "duckdb", both ? [both] : []).map((finding) => finding.code);
    };

    it("accepts the verified join condition as given, TRY_CAST included", async () => {
      expect(await codes(`SELECT AVG(r."Elevation") AS e FROM fires JOIN raws_registry r ON ${VERIFIED}`)).toEqual([]);
    });

    it("accepts the verified key written another way: cast, IN subquery, or a renamed CTE column", async () => {
      expect(await codes(
        `SELECT AVG(r."Elevation") AS e FROM fires f JOIN raws_registry r ON CAST(r."NWS ID" AS BIGINT) = f.station_ref`
      )).toEqual([]);
      expect(await codes(
        `SELECT AVG("Elevation") AS e FROM raws_registry WHERE CAST("NWS ID" AS BIGINT) IN (SELECT station_ref FROM fires)`
      )).toEqual([]);
      expect(await codes(`
        WITH s AS (SELECT CAST("NWS ID" AS BIGINT) AS nws, "Elevation" AS elevation FROM raws_registry)
        SELECT AVG(s.elevation) AS e FROM fires f JOIN s ON s.nws = f.station_ref
      `)).toEqual([]);
    });

    it("rejects a join on a decoy key and names the verified condition", async () => {
      const sql = `SELECT AVG(r."Elevation") AS e FROM fires f JOIN raws_registry r ON r."Station ID" = f.station_ref`;
      const [both] = await contractAssertions(true);
      const findings = validateSqlSemantics(sql, "duckdb", both ? [both] : []);

      expect(findings.map((finding) => finding.code)).toEqual([
        "SQL_SEMANTIC_JOIN_MISSING:fires:raws_registry",
        "SQL_SEMANTIC_JOIN_REJECTED:fires.station_ref:raws_registry.Station ID"
      ]);
      expect(findings[1]?.message).toContain(VERIFIED);
    });

    it("rejects the verified key compared as text when it only matches as numbers", async () => {
      // wildfire-hard-17, 2026-10-08: right columns joined as VARCHAR gave 5134 instead of 4830.9.
      expect(await codes(
        `SELECT AVG(r."Elevation") AS e FROM fires f JOIN raws_registry r ON CAST(r."NWS ID" AS VARCHAR) = CAST(f.station_ref AS VARCHAR)`
      )).toEqual(["SQL_SEMANTIC_JOIN_COMPARED_AS_TEXT:fires:raws_registry"]);
      expect(await codes(`
        WITH used AS (SELECT DISTINCT station_ref FROM fires),
        matched AS (SELECT r."Elevation" AS elevation FROM used u
          JOIN raws_registry r ON CAST(r."NWS ID" AS VARCHAR) = CAST(u.station_ref AS VARCHAR))
        SELECT AVG(elevation) AS e FROM matched
      `)).toEqual(["SQL_SEMANTIC_JOIN_COMPARED_AS_TEXT:fires:raws_registry"]);
      expect(await codes(
        `SELECT AVG(r."Elevation") AS e FROM fires f JOIN raws_registry r ON TRY_CAST(r."NWS ID" AS BIGINT) = f.station_ref`
      )).toEqual([]);
    });

    it("does not force a join on queries that never combine the tables", async () => {
      expect(await codes(`
        SELECT (SELECT COUNT(*) FROM fires) AS fire_rows, (SELECT AVG("Elevation") FROM raws_registry) AS e
      `)).toEqual([]);
    });
  });
});
