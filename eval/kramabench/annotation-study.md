# Running the annotation study (KramaBench biomedical, 4 questions)

This guide reproduces the environment-annotation study: four KramaBench biomedical questions that
DataFoundry failed, each run under the same agent with different context. The result to reproduce:

| Condition | KramaBench SUT | Score (2026-10-19/20, one run each) |
|---|---|---|
| DataLink only (control) | `DataFoundryDataLinkOnlySUT` | 1/4 |
| Annotation tools only | `DataFoundryAnnotationOnlySUT` | 2/4 |
| DataLink + annotation tools | `DataFoundryAnnotatedToolsSUT` | 4/4 |

Each condition is one run per question, so treat the gaps as indicative, not measured.

All three run on the same server: the guard build (`feat/env-annotation-guard`, port 8788).
The control runs there with the annotation file removed, so the comparisons isolate one change
each:

- control → DataLink + annotation tools: adds the annotation
- annotation tools only → DataLink + annotation tools: adds DataLink, with the annotation on

The original study also had a plain-DataFoundry baseline and a prompt-injection condition.
They're left out here: they ran on a different build, so they don't compare cleanly with these
three.

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
| [`shawnjiang1019/datafoundry`](https://github.com/shawnjiang1019/datafoundry) | `datatrail-integration` | One-time setup through its web UI (account, model profile, MCP servers), the KramaBench SUT (`eval/kramabench/`), the DataLink service (`services/datalink/`) |
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

The runs themselves only use the guard server, which starts the API without the web UI. Use
the main checkout's server (`npm run start`, web UI on :3000) for the one-time setup: register
an account, create the model profile, and later register the DataLink MCP server (step 6).
Stop it before the runs. Both checkouts use the same metadata store and storage root, so the
guard server sees everything set up this way.

---

## 3. Set up KramaBench

Follow section 2 of [`README.md`](README.md): clone it, create the `kbench` env, install the
dependencies, download the data, and install the SUT. Then:

1. **Copy the ingest overrides too.** The README's install step copies `datafoundry_sut.py`
   and `ds_ingest`. The SUT also reads `ingest_overrides.json` from its own folder:

   ```powershell
   copy <datafoundry>\eval\kramabench\ingest_overrides.json systems\ingest_overrides.json
   ```

   Without it, the lake still builds, but differently: the biomedical proteomics sheets stay as
   wide matrices (one column per sample) instead of one row per protein and sample, so the agent
   works on different tables from the study. Copy it **before** the first run on the domain,
   since the lake is built only once (to rebuild, delete `system_scratch\DataFoundrySUT\biomedical.duckdb`).

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

Re-copy `datafoundry_sut.py` and `ingest_overrides.json` into `systems/` whenever they change.

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

Two terminals, both left open:

| Terminal | Command | Port |
|---|---|---|
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

Every condition uses the guard server:

```powershell
$env:DF_API = "http://127.0.0.1:8788"
```

**A. DataLink only** (annotation file disabled):

```powershell
Move-Item $ann "$ann.disabled"
$env:DF_MCP_SERVER_IDS = "<DataLink MCP server id>"
python evaluate.py --sut DataFoundryDataLinkOnlySUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
Move-Item "$ann.disabled" $ann
```

**B. Annotation tools only** (annotation on, no DataLink):

```powershell
$env:DF_MCP_SERVER_IDS = ""
python evaluate.py --sut DataFoundryAnnotationOnlySUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
```

**C. DataLink + annotation tools** (annotation on, DataLink on):

```powershell
$env:DF_MCP_SERVER_IDS = "<DataLink MCP server id>"
python evaluate.py --sut DataFoundryAnnotatedToolsSUT --workload biomedical --no_pipeline_eval --num_workers 1 --verbose
```

Before each run, check that the annotation file is where that condition needs it:
`Test-Path $ann` should be `False` for A and `True` for B and C. The A and C runs differ only
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

`<datafoundry>\eval\kramabench\token_usage.py` totals input and output tokens per run. Export
folders are git-ignored (`run_exports*/`), so the original study's exports aren't in the repo;
ask the study's owner for `run_exports_annotation_study/` if you want to compare against them.

**To confirm the annotation reached the agent** in conditions B and C, open a run's trace and
look for an `env_annotation` block in an `inspect_schema` or `preview_table` result for `…_mmc1`.
It should mention `Case_excluded` and keep `'No'`. If it's missing, the agent never inspected
that table, which is the usual reason B scores lower than C.

---

## 10. Running other questions

### Other biomedical questions

Nothing needs rebuilding: the lake, annotation, graph and servers all cover the whole domain.
Change `KB_TASKS` to the task ids you want and rerun any condition from step 8. To list the ids
and questions:

```powershell
python -c "import json; [print(t['id'], '|', t['query'][:100]) for t in json.load(open('workload/biomedical.json'))]"
```

To run the whole domain, clear the filter (`$env:KB_TASKS = ""`). At 5–12 minutes per question,
that takes several hours per condition.

Each run starts fresh and writes a new `results\<SUT>\biomedical_measures_<timestamp>.csv`.
Earlier answers are reused only with `--use_system_cache`, so don't pass it when you want a
new run of a question.

### Another domain

The setup is per domain. Repeat steps 4–7 with the domain's name in place of `biomedical`:

1. **Lake and exports (step 4):** the first SUT run on the domain builds
   `system_scratch\DataFoundrySUT\<domain>.duckdb`. Then run `export_duckdb_tables.py` with
   `--format csv <domain>` and `--format parquet <domain>`.
2. **Annotation (step 5):** run `dtrail-annotate` over
   `system_scratch\dtrail_sources\<domain>\*.csv`, writing
   `agent_annotation.<domain>.json`.
3. **DataLink graph (step 6):** build or copy `<domain>.db`, serve it on its own port, and
   register that URL as another MCP server. Each domain gets its own server and id. On the
   original machine the ports were 8080 (biomedical), 8081 (legal), 8082 (wildfire),
   8083 (archeology) and 8084 (environment); any free port works.
4. **Guard server (step 7):** restart it with `DF_ENV_ANNOTATION_PATH` pointing at the new
   domain's file. The server reads one annotation file, so it serves **one domain at a time**.
   Renaming the file toggles the annotation without a restart (that's how the control works),
   but changing which file it points to needs a restart.
5. **Run (step 8):** set `--workload <domain>`, `KB_TASKS` to that domain's ids,
   `DF_MCP_SERVER_IDS` to that domain's DataLink id, and `$ann` to its annotation file.

### Check the annotation before spending runs

The annotation only helps where its roles fit the failure. Before running a domain, see which
roles it found:

```powershell
python -c "import json, collections; a=json.load(open(r'<path>\agent_annotation.<domain>.json')); print(collections.Counter(r for t in a['tables'].values() for c in t['columns'].values() for r in c.get('roles') or []))"
```

- **`eligibility_flag`:** marks "in the study" / included / excluded columns. This is the role
  that fixed the biomedical questions.
- **`competing_measures`:** sibling variants of one measure, e.g. `FDR.phos` / `FDR.prot`.
- **`identifier`:** key-like columns, used for joins.

If a domain has only `identifier` roles (environment does), the agent gets identifiers, links
and sampled values but no population flag. That tests something different from the biomedical
result.

All roles and sampled values come from the **first 64 rows** of each file, not a random sample,
so a column can look narrower than it is. For example, environment's `Year` samples show only
`2002`, because the file is in date order. Keep this in mind when reading traces.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| DataLink calls return no nodes | `datalink serve` was started without `--db` |
| Run fails with a DuckDB lock error | Another DataFoundry server still has the lake open; stop it |
| `KB_TASKS has ids not in biomedical.json` | A typo in `KB_TASKS`, or the `benchmark.py` patch is missing (then all 40+ tasks run) |
| `ECONNREFUSED` right after startup | The API port opens before the runtime is ready; wait for the "listening" line before starting a run |
| Every condition scores the same | Check `Test-Path $ann` before the run, and that `DF_API` points at 8788 |
| HTTP 429 in the log | The model provider's rate limit; the SUT retries with backoff, so runs just take longer |
