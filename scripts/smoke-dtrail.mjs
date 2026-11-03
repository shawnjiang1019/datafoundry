import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = (process.env.DTRAIL_API_URL ?? "http://127.0.0.1:8061").replace(/\/+$/, "");

const jsonRequest = async (path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { data, status: response.status };
};

try {
  let healthy;
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
    healthy = response.ok;
  } catch (error) {
    console.error(
      `d-trail service not reachable at ${baseUrl} `
      + `(${error instanceof Error ? error.message : String(error)}).`
    );
    console.error("Start the d-trail service first, then re-run this smoke. See docs/en/guides/dtrail.md.");
    process.exit(2);
  }
  if (!healthy) {
    console.error(`d-trail service at ${baseUrl} did not answer GET /healthz. Start the d-trail service first.`);
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "dtrail-smoke-"));
  const csvPath = join(dir, "region_amount.csv");
  writeFileSync(csvPath, "region,amount\nN,10\nS,20\n", "utf8");

  const run = await jsonRequest("/runs", {
    task: {
      group_by: ["region"],
      aggregations: [{ function: "sum", column: "amount", as: "total" }],
      output_contract: { required_fields: [] }
    },
    sources: [{ name: "region_amount", kind: "csv", path: csvPath }],
    workspace_id: "default",
    grounder: "baseline"
  });
  assert.equal(run.status, 200, `POST /runs expected 200, got ${run.status}: ${JSON.stringify(run.data)}`);
  const taskId = typeof run.data === "object" && run.data !== null
    ? run.data.task_id ?? run.data.taskId ?? run.data.id ?? run.data.run_id ?? run.data.runId
    : undefined;
  assert.ok(taskId, `POST /runs returned no task_id: ${JSON.stringify(run.data)}`);

  const trail = await jsonRequest(`/runs/${encodeURIComponent(String(taskId))}/trail`);
  assert.equal(trail.status, 200, `GET /runs/{id}/trail expected 200, got ${trail.status}: ${JSON.stringify(trail.data)}`);
  assert.ok(Array.isArray(trail.data), `GET /runs/{id}/trail expected an array, got: ${JSON.stringify(trail.data)}`);

  const validation = await jsonRequest(`/runs/${encodeURIComponent(String(taskId))}/trail/validate`);
  assert.equal(
    validation.status,
    200,
    `GET /runs/{id}/trail/validate expected 200, got ${validation.status}: ${JSON.stringify(validation.data)}`
  );
  const integrityPass = Array.isArray(validation.data)
    ? validation.data.length === 0
    : validation.data?.integrity === "pass"
      || ["pass", "ok", "valid"].includes(String(validation.data?.status))
      || validation.data?.valid === true
      || validation.data?.ok === true
      || validation.data?.passed === true;
  assert.ok(integrityPass, `trail integrity validation did not pass: ${JSON.stringify(validation.data)}`);

  console.log(`d-trail smoke OK: run ${taskId} at ${baseUrl}; trail has ${trail.data.length} entries; integrity passes.`);
} catch (error) {
  console.error(`d-trail smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
