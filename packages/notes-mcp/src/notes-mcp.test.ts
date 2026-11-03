import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { acquireDuckDb, duckDbClose, duckDbRun } from "@datafoundry/data-gateway/dist/adapters/duckdb-runtime.js";

const execFileAsync = promisify(execFile);
import { beforeAll, describe, expect, it } from "vitest";

import { duckDbDatasource } from "./datasource.js";
import { createNotesMcpServer } from "./mcp.js";
import { NotesStore } from "./notes-store.js";
import { createNotesTools, MAX_CELL_CHARS, MAX_RESULT_CHARS, NotesToolError } from "./tools.js";

// A lake shaped like KramaBench wildfire-hard-17, with invented names and values: fire records
// reference 12 of 30 stations by an integer whose only match is a zero-padded VARCHAR column in
// the registry, next to decoy ID columns. Plus a study table with an exclusion flag.
const STATIONS = Array.from({ length: 30 }, (_, index) => 41000 + index * 7);
const REFERENCED = STATIONS.slice(0, 12);
const STATIONS_QUESTION = "What is the average elevation of the weather stations used by the fires?";
const ALL_STATIONS = "SELECT AVG(\"Elevation\") AS e FROM raws_registry";
const LINKED_STATIONS = "SELECT AVG(r.\"Elevation\") AS e FROM raws_registry r WHERE EXISTS (SELECT 1 FROM fires f "
  + "WHERE TRY_CAST(f.station_ref AS DOUBLE) = TRY_CAST(r.\"NWS ID\" AS DOUBLE))";

const path = join(mkdtempSync(join(tmpdir(), "notes-mcp-")), "lake.duckdb");
const tools = () => createNotesTools({ datasources: { wildfire: duckDbDatasource(path) } });

beforeAll(async () => {
  const fires = Array.from({ length: 60 }, (_, index) =>
    `('INC-${index}', 'CA', ${index < 59 ? REFERENCED[index % REFERENCED.length] : 99000 + index}, ${index * 10})`);
  const registry = STATIONS.map((station, index) =>
    `(${index + 1}, ${16777000 + index}, ${19000000 + index}, '0${station}', 'STATION ${index}', ${1000 + index * 50})`);
  const patients = Array.from({ length: 20 }, (_, index) => `('P${index}', ${40 + index}, '${index < 4 ? "Yes" : "No"}')`);
  // The service opens the lake read-only, and DuckDB will not open one file both writable and
  // read-only in one process, so another process writes it.
  const statements = [
    "CREATE TABLE fires (incident_number VARCHAR, state VARCHAR, station_ref BIGINT, acres BIGINT)",
    `INSERT INTO fires VALUES ${fires.join(", ")}`,
    "CREATE TABLE fires_dictionary (\"Variable Name\" VARCHAR, \"Description\" VARCHAR)",
    "INSERT INTO fires_dictionary VALUES "
      + "('incident_number', 'Incident identifying number from the ICS-209 report'), "
      + "('state', 'Two-letter abbreviation of the state where the fire started'), "
      + "('station_ref', 'Remote Automatic Weather Station (RAWS) ID number for weather data'), "
      + "('acres', 'Final fire size in acres as reported at containment')",
    "CREATE TABLE raws_registry (OBJECTID BIGINT, \"Station ID\" BIGINT, \"WX ID\" BIGINT, "
      + "\"NWS ID\" VARCHAR, \"Station Name\" VARCHAR, \"Elevation\" BIGINT)",
    `INSERT INTO raws_registry VALUES ${registry.join(", ")}`,
    "CREATE TABLE patients (patient_id VARCHAR, age BIGINT, excluded VARCHAR)",
    `INSERT INTO patients VALUES ${patients.join(", ")}`
  ];
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import duckdb from "duckdb";
    const database = new duckdb.Database(${JSON.stringify(path)}, (error) => {
      if (error) throw error;
      database.exec(${JSON.stringify(statements.join(";\n"))}, (failure) => {
        if (failure) throw failure;
        database.close(() => undefined);
      });
    });
  `]);
});

/** Counts the fire records from a separate process, opening the lake read-only as the service does. */
const countFromAnotherProcess = async (): Promise<string> => (await execFileAsync(process.execPath, ["--input-type=module", "-e", `
  import duckdb from "duckdb";
  const database = new duckdb.Database(${JSON.stringify(path)}, duckdb.OPEN_READONLY, (error) => {
    if (error) { console.error(String(error)); process.exit(1); }
    database.all("SELECT COUNT(*)::INTEGER AS n FROM fires", (failure, rows) => {
      if (failure) { console.error(String(failure)); process.exit(1); }
      console.log(rows[0].n);
    });
  });
`])).stdout.trim();

describe("notes tools", () => {
  it("finds the link column names alone would miss, and rejects the decoy keys", async () => {
    const notes = await tools().ground({ question: STATIONS_QUESTION, datasource: "wildfire" });
    const relationships = notes.verified_joins?.relationships as Array<{ from: string; to: string; status: string }>;

    expect(relationships).toContainEqual(expect.objectContaining({
      from: "fires.station_ref", to: "raws_registry.NWS ID", status: "ACCEPT"
    }));
    expect(relationships.some((relationship) => relationship.status === "REJECT")).toBe(true);
    // Readings stay hidden unless asked for: the double-check is the default.
    expect(notes.readings).toBeUndefined();
  });

  it("challenges an answer over every station, then accepts the one over the linked stations", async () => {
    const service = tools();
    const { notes_id } = await service.ground({ question: STATIONS_QUESTION, datasource: "wildfire" });

    expect(await service.runSql({ notes_id, sql: ALL_STATIONS })).toMatchObject({ status: "ok", rows: [[1725]] });
    // check_answer reads the last query that ran through run_sql.
    const challenge = await service.checkAnswer({ notes_id, answer: "1725" });
    expect(challenge).toMatchObject({ status: "challenge", code: "LINKED_POPULATION_IGNORED", challenges_left: 1 });
    expect(challenge.status === "challenge" && challenge.message).toContain("only 12 rows of raws_registry");

    expect(await service.runSql({ notes_id, sql: LINKED_STATIONS })).toMatchObject({ status: "ok" });
    expect(await service.checkAnswer({ notes_id, answer: "1275" })).toEqual({ status: "ok" });
  });

  it("blocks a join the data proved wrong and names the verified key instead", async () => {
    const service = tools();
    const { notes_id } = await service.ground({ question: STATIONS_QUESTION, datasource: "wildfire" });
    const decoy = "SELECT AVG(r.\"Elevation\") FROM fires f JOIN raws_registry r ON f.station_ref = r.\"Station ID\"";

    const blocked = await service.runSql({ notes_id, sql: decoy });
    expect(blocked.status).toBe("blocked");
    expect(JSON.stringify(blocked)).toContain("NWS ID");
    // check_sql reports the same problems without running anything: the wrong key, and the verified one missing.
    expect((await service.checkSql({ notes_id, sql: decoy })).problems.map((problem) => problem.code)).toEqual([
      "SQL_SEMANTIC_JOIN_MISSING:fires:raws_registry",
      "SQL_SEMANTIC_JOIN_REJECTED:fires.station_ref:raws_registry.Station ID"
    ]);
  });

  it("challenges an answer that ignores an exclusion flag, and not one that uses it", async () => {
    const service = tools();
    const { notes_id } = await service.ground({ question: "What is the average age of the patients?", datasource: "wildfire" });

    expect(await service.checkAnswer({ notes_id, final_sql: "SELECT AVG(age) FROM patients" }))
      .toMatchObject({ status: "challenge", code: "EXCLUSION_FLAG_IGNORED" });
    expect(await service.checkAnswer({ notes_id, final_sql: "SELECT AVG(age) FROM patients WHERE excluded = 'No'" }))
      .toEqual({ status: "ok" });
  });

  it("challenges at most twice per question, then lets the answer stand", async () => {
    const service = tools();
    const { notes_id } = await service.ground({ question: STATIONS_QUESTION, datasource: "wildfire" });
    const check = () => service.checkAnswer({ notes_id, final_sql: ALL_STATIONS });

    expect((await check()).status).toBe("challenge");
    expect((await check()).status).toBe("challenge");
    expect(await check()).toMatchObject({ status: "ok", note: expect.stringContaining("limit") });
  });

  it("never stops an agent: no notes or no SQL means ok, and writes are refused as an error result", async () => {
    const service = tools();
    expect(await service.checkAnswer({ notes_id: "n-missing", final_sql: ALL_STATIONS })).toMatchObject({ status: "ok" });
    const { notes_id } = await service.ground({ question: STATIONS_QUESTION, datasource: "wildfire" });
    expect(await service.checkAnswer({ notes_id })).toMatchObject({ status: "ok", note: expect.stringContaining("No SQL") });
    expect(await service.runSql({ notes_id, sql: "DROP TABLE fires" })).toMatchObject({ status: "error", message: expect.stringMatching(/^Read-only/u) });
    expect(await service.runSql({ datasource: "wildfire", sql: "SELECT COUNT(*) AS n FROM fires" })).toMatchObject({ status: "ok", rows: [[60]] });
  });

  it("cuts a large result to a reply an agent can read, and says how to see the rest", async () => {
    const big = await tools().runSql({ datasource: "wildfire", sql: "SELECT i, repeat('x', 400) AS s FROM range(5000) t(i)" });

    expect(big.status).toBe("ok");
    if (big.status !== "ok") return;
    expect(JSON.stringify(big.rows).length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 1000);
    expect(String(big.rows[0]?.[1])).toHaveLength(MAX_CELL_CHARS + 1);
    expect(big.row_count).toBe(1000);
    expect(big.truncated?.note).toMatch(/^Showing \d+ of 1000\+ rows/u);
    // A small result comes back whole, with no truncation note.
    expect(await tools().runSql({ datasource: "wildfire", sql: "SELECT COUNT(*) AS n FROM fires" })).not.toHaveProperty("truncated");
  });

  it("reports caller mistakes as tool errors", async () => {
    await expect(tools().ground({ question: "q", datasource: "nope" })).rejects.toBeInstanceOf(NotesToolError);
    await expect(tools().runSql({ notes_id: "n-missing", sql: "SELECT 1" })).rejects.toThrow(/Call ground first/u);
  });
});

describe("read-only data", () => {
  it("refuses writes at the database, not only at the SQL guard", async () => {
    const handle = await acquireDuckDb(path, { readOnly: true });
    const connection = handle.database.connect();
    await expect(duckDbRun(connection, "CREATE TABLE written AS SELECT 1 AS a")).rejects.toThrow(/read-only/iu);
    await duckDbClose(connection);
  });

  it("lets separate processes read one file while this one has it open (two lanes, one domain)", async () => {
    expect(await tools().runSql({ datasource: "wildfire", sql: "SELECT COUNT(*) AS n FROM fires" })).toMatchObject({ rows: [[60]] });
    expect(await Promise.all([countFromAnotherProcess(), countFromAnotherProcess()])).toEqual(["60", "60"]);
  });
});

describe("notes store", () => {
  it("drops notes after their time limit", () => {
    let now = 0;
    const store = new NotesStore(1000, () => now);
    const entry = store.create({ datasource: "d", question: "q", grounding: { facts: [], candidates: [], duplicateTables: [], warnings: [] } });

    expect(store.get(entry.id)).toBe(entry);
    now = 1001;
    expect(store.get(entry.id)).toBeUndefined();
  });
});

describe("notes MCP server", () => {
  it("lists the four tools and answers a call over MCP", async () => {
    const server = createNotesMcpServer(tools(), ["wildfire"]);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["check_answer", "check_sql", "ground", "run_sql"]);
    const ground = await client.callTool({ name: "ground", arguments: { question: STATIONS_QUESTION, datasource: "wildfire" } });
    expect(ground.structuredContent).toMatchObject({ notes_id: expect.stringMatching(/^n-/u) });
    const unknown = await client.callTool({ name: "ground", arguments: { question: "q", datasource: "nope" } });
    expect(unknown.isError).toBe(true);

    await client.close();
  });
});
