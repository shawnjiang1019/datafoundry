# Running the annotation study (KramaBench biomedical, 4 questions)

This guide reproduces the environment-annotation study: four KramaBench biomedical questions that
DataFoundry failed, each run under the same agent with different context. The result to reproduce:

| Condition | KramaBench SUT | Score (2026-10-19/20, one run each) |
|---|---|---|
| Baseline: no DataLink, no annotation | `DataFoundrySUT` | 0/4 |
| DataLink only (control) | `DataFoundryDataLinkOnlySUT` | 1/4 |
| Annotation tools only | `DataFoundryAnnotationOnlySUT` | 2/4 |
| DataLink + annotation tools | `DataFoundryAnnotatedToolsSUT` | 4/4 |

Each condition is one run per question, so treat the gaps as indicative, not measured.

The four questions:

| Task | Question (abridged) | Expected |
|---|---|---|
| `biomedical-easy-2` | Average age of patients with serous tumor samples analyzed in the study | `68.5` |
| `biomedical-hard-5` | Median variants per Mbp for serous tumor samples in the study (4 dp) | `2.6563` |
| `biomedical-hard-1` | Spearman correlation of PLK1 and CHEK2-S163 abundance in tumor samples, excluding samples not in the study (4 dp) | `0.4765` |
| `biomedical-easy-9` | Average FDR for CBX3 minus average FDR for the other genes | `-0.008003975` |

What the annotation contributes: it is built offline, with no model, from sampled rows. Among
other roles, it marks `Case_excluded` in the clinical table (`…_mmc1`) as an eligibility flag
with keep value `'No'`. "In the study" means rows where `Case_excluded = 'No'`, and the agent
only learns this when the flag appears in its `inspect_schema` / `preview_table` results.

---

## 1. What you need

### Repositories and branches

| Repo | Branch | Used for |
|---|---|---|
| [`shawnjiang1019/datafoundry`](https://github.com/shawnjiang1019/datafoundry) | `datatrail-integration` | The baseline DataFoundry server (port 8787), the KramaBench SUT (`eval/kramabench/`), the DataLink service (`services/datalink/`) |
| same repo, **second checkout** | `feat/env-annotation-guard` | The DataFoundry server that delivers the annotation through its tools (port 8788) |
| [`ddsm-lab/d-trail`](https://github.com/ddsm-lab/d-trail) | `feat/annotation-assumption-integration` | `dtrail-annotate`, which builds the annotation |
| [`mitdbg/KramaBench`](https://github.com/mitdbg/KramaBench) | `main`, plus a small local patch (step 3) | The benchmark harness and grader |

The second DataFoundry checkout is easiest as a git worktree:

```powershell
cd <datafoundry>
git checkout datatrail-integration
git worktree add ..\datafoundry-guard feat/env-annotation-guard
```

### Tools

- Node.js ≥ 22.22, Python 3.11 (conda), [`uv`](https://docs.astral.sh/uv/) for DataLink
- An OpenAI-compatible model endpoint with tool calling. The study used `glm-5.3-flash` for the agent.
- About 8 GB free disk (KramaBench data, the DuckDB lake, CSV and graph exports)

Commands are PowerShell. Paths in `<angle brackets>` are your checkouts.

---

## 2. Set up DataFoundry (both checkouts)

Follow sections 1–3 of [`README.md`](README.md) in this folder for the main checkout: `npm install`,
`npm run build`, the `.env` lines, registering an account, and creating a model profile.

Then build the second checkout:

```powershell
cd <datafoundry-guard>
npm install
npm run build
```

Both servers must share one metadata store and storage root. That way the account, model profile,
registered data sources and MCP servers exist for both. The guard server is started in step 7.

---

## 3. Set up KramaBench

Follow section 2 of [`README.md`](README.md): clone it, create the `kbench` env, install the
dependencies, download the data, and install the SUT. Then:

1. **Register the study's SUTs.** In `systems/__init__.py`, change the DataFoundry import to:

   ```python
   from .datafoundry_sut import (
       DataFoundryAnnotatedSUT,
       DataFoundryAnnotatedToolsSUT,
       DataFoundryAnnotationOnlySUT,
       DataFoundryDataLinkOnlySUT,
       DataFoundrySUT,
   )
   ```

2. **Let a run select specific tasks.** In `benchmark/benchmark.py`, right after
   `full_workload = json.load(f)`, add:

   ```python
   only = {t.strip() for t in os.environ.get("KB_TASKS", "").split(",") if t.strip()}
   if only:
       unknown = only - {task["id"] for task in full_workload}
       if unknown:
           raise ValueError(f"KB_TASKS has ids not in {basename}: {sorted(unknown)}")
       full_workload = [task for task in full_workload if task["id"] in only]
       print(f"KB_TASKS: running only {sorted(only)}")
   ```

3. **Credentials.** Copy `kb-env.example.ps1` to `kb-env.ps1` and fill it in:
   `DF_EMAIL`, `DF_PASSWORD`, `DF_LLM_PROFILE` (your profile id), `DF_RUN_TIMEOUT=1800`,
   `OPENAI_API_KEY` (a placeholder is fine with `--no_pipeline_eval`). `kb-env.ps1` holds a
   password, so keep it out of git.

Re-copy `datafoundry_sut.py` into `systems/` whenever it changes.

---

## 4. Build the biomedical data exports

The first SUT run on a domain builds `system_scratch/DataFoundrySUT/biomedical.duckdb`. That
takes about 7 minutes for biomedical; the smoke test in `README.md` §4 triggers it. Then export
the lake's tables, from the KramaBench root:

```powershell
conda activate kbench
python <datafoundry>\eval\kramabench\export_duckdb_tables.py --format csv biomedical      # → system_scratch\dtrail_sources\biomedical\
python <datafoundry>\eval\kramabench\export_duckdb_tables.py --format parquet biomedical  # → system_scratch\datalink_sources\biomedical\
```

The CSVs feed the annotation (step 5); the Parquet files feed the DataLink graph (step 6).

---

## 5. Build the annotation (offline, no model)

```powershell
cd <d-trail>
git checkout feat/annotation-assumption-integration
conda create -n dtrail python=3.11 -y; conda activate dtrail
pip install -e .

$src = "<KramaBench>\system_scratch\dtrail_sources\biomedical"
$inputs = Get-ChildItem "$src\*.csv" | ForEach-Object { "--input"; "$($_.BaseName)=$($_.FullName)" }
dtrail-annotate @inputs `
  --annotation-root <KramaBench>\system_scratch\annotation_store `
  --export-agent-json <KramaBench>\system_scratch\annotations\agent_annotation.biomedical.json
```

This takes about a second. It prints a summary (tables, columns, relations, `content_hash`) and
writes `agent_annotation.biomedical.json`, the file the guard server reads.

**Check it worked:** the file should mark `Case_excluded` as an eligibility flag with keep `'No'`:

```powershell
python -c "import json; a=json.load(open(r'<KramaBench>\system_scratch\annotations\agent_annotation.biomedical.json')); print(a['tables']['1_s2_0_S0092867420301070_mmc1']['columns']['Case_excluded']['role_details'])"
# {'eligibility_flag': {'keep_value': "'No'"}}
```

---

## 6. Build and serve the DataLink graph

**Building the graph calls an LLM for every table and takes a while.** If someone on the team
already has `biomedical.db`, copy it to `<KramaBench>\system_scratch\datalink_graphs\` and skip
to *Serve it*.

**To build it yourself:** set the `llm` and `embedding` sections of
`<datafoundry>\services\datalink\datalink_config.json`, using `datalink_config.example.json`
as the template. Then:

```powershell
cd <datafoundry>\services\datalink
uv run datalink add-table --source "<KramaBench>\system_scratch\datalink_sources\biomedical\*.parquet" `
  --db "<KramaBench>\system_scratch\datalink_graphs\biomedical.db"
```

**Serve it** in its own terminal, and keep it open:

```powershell
cd <datafoundry>\services\datalink
uv run datalink serve --port 8080 --transport streamable-http `
  --db "<KramaBench>\system_scratch\datalink_graphs\biomedical.db"
```

Always pass `--db`. Without it, DataLink serves an empty default graph instead of the one in
its config, and every DataLink call quietly returns nothing.

**Register it in DataFoundry, once:** in the web UI's configuration page, add an MCP server
with URL `http://127.0.0.1:8080/mcp` and transport `streamable-http`. Note its id: runs that
use DataLink pass it as `DF_MCP_SERVER_IDS`.

---

## 7. Start the servers

Three terminals, all left open:

| Terminal | Command | Port |
|---|---|---|
| Baseline DataFoundry | `cd <datafoundry>; npm run start` (see `README.md` §1) | 8787 |
| DataLink | step 6 | 8080 |
| Guard DataFoundry | below | 8788 |

The guard server reads the main checkout's `.env` and storage, plus the annotation file:

```powershell
Get-Content <datafoundry>\.env | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { Set-Item "env:$($matches[1])" $matches[2].Trim() } }
$env:API_PORT = "8788"
$env:STORAGE_ROOT_DIR = "<datafoundry>\apps\api\storage"
$env:METADATA_DB_PATH = "<datafoundry>\apps\api\storage\metadata\workbench.sqlite"
$env:DF_ENV_ANNOTATION_PATH = "<KramaBench>\system_scratch\annotations\agent_annotation.biomedical.json"
cd <datafoundry-guard>
npm run start -- --api
```

Wait for `Agent runtime server listening at http://127.0.0.1:8788`.

The guard server reads `DF_ENV_ANNOTATION_PATH` when each run starts. If the file is missing,
tool results are unchanged. So **renaming the file turns the annotation off** for the next run,
without a restart. The DataLink-only control relies on this.

**Only one DataFoundry server should run an agent at a time.** Both use the same DuckDB lake,
and a second server writing to it can hold its lock.

---

## 8. Run the conditions

Run each condition from the KramaBench root, in a terminal set up like this:

```powershell
conda activate kbench
cd <KramaBench>
. .\kb-env.ps1
$env:KB_TASKS = "biomedical-easy-2,biomedical-easy-9,biomedical-hard-1,biomedical-hard-5"
$env:DTRAIL_ASSUME = "0"
$env:PYTHONUNBUFFERED = "1"
$ann = "<KramaBench>\system_scratch\annotations\agent_annotation.biomedical.json"
```

Each question takes roughly 5–12 minutes, so a condition takes 20–50 minutes. Run the
conditions one after another, not in parallel.

**A. Baseline** (main server, no DataLink, no annotation):

```powershell
$env:DF_API = "http://127.0.0.1:8787"; $env:DF_MCP_SERVER_IDS = ""
python evaluate.py --sut DataFoundrySUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
```

**B. DataLink only** (guard server, annotation file disabled):

```powershell
Move-Item $ann "$ann.disabled"
$env:DF_API = "http://127.0.0.1:8788"; $env:DF_MCP_SERVER_IDS = "<DataLink MCP server id>"
python evaluate.py --sut DataFoundryDataLinkOnlySUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
Move-Item "$ann.disabled" $ann
```

**C. Annotation tools only** (guard server, annotation on, no DataLink):

```powershell
$env:DF_API = "http://127.0.0.1:8788"; $env:DF_MCP_SERVER_IDS = ""
python evaluate.py --sut DataFoundryAnnotationOnlySUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
```

**D. DataLink + annotation tools** (guard server, annotation on, DataLink on):

```powershell
$env:DF_API = "http://127.0.0.1:8788"; $env:DF_MCP_SERVER_IDS = "<DataLink MCP server id>"
python evaluate.py --sut DataFoundryAnnotatedToolsSUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
```

Before each run, check that the annotation file is where that condition needs it:
`Test-Path $ann` should be `False` for B and `True` for C and D. The B and D runs differ only
in that file.

---

## 9. Read the results

Each run ends with `Total score is: …`. Per-question correctness is in
`results\<SUT>\biomedical_measures_<timestamp>.csv`, in the rows with `metric = success`.

To export answers, traces and step counts for comparison, run from the KramaBench root:

```powershell
$t = "--task biomedical-easy-2 --task biomedical-easy-9 --task biomedical-hard-1 --task biomedical-hard-5"
python <datafoundry>\eval\kramabench\export_runs.py biomedical $t.Split(" ") --sut DataFoundryAnnotatedToolsSUT --out <folder>
```

`<datafoundry>\eval\kramabench\token_usage.py` totals input and output tokens per run. The
exports from the original study are in
[`run_exports_annotation_study/`](run_exports_annotation_study/README.md).

**To confirm the annotation reached the agent** in conditions C and D, open a run's trace and
look for an `env_annotation` block in an `inspect_schema` or `preview_table` result for `…_mmc1`.
It should mention `Case_excluded` and keep `'No'`. If it's missing, the agent never inspected
that table, which is the usual reason C scores lower than D.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| DataLink calls return no nodes | `datalink serve` was started without `--db` |
| Run fails with a DuckDB lock error | Another DataFoundry server still has the lake open; stop it |
| `KB_TASKS has ids not in biomedical.json` | A typo in `KB_TASKS`, or the `benchmark.py` patch is missing (then all 40+ tasks run) |
| `ECONNREFUSED` right after startup | The API port opens before the runtime is ready; wait for the "listening" line (`/ready` on 8787) |
| Every condition scores the same | Check `Test-Path $ann` before the run, and that `DF_API` points at 8788 for B–D |
| HTTP 429 in the log | The model provider's rate limit; the SUT retries with backoff, so runs just take longer |
