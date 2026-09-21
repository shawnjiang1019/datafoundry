# KramaBench on DataFoundry

Run [KramaBench](https://github.com/mitdbg/KramaBench) with DataFoundry as the system under test (SUT), then grade the results with KramaBench's own metrics.

KramaBench runs the loop and does the scoring. DataFoundry answers each task through its normal runtime: governed read-only SQL, the protocol, and the model profile you configure.

| File | Purpose |
| --- | --- |
| `datafoundry_sut.py` | KramaBench `System` implementation backed by DataFoundry (copied into KramaBench) |
| `grade_cached.py` | Offline grader for saved answers. Needs no DataFoundry calls and no API key. |

## How the harness works

For each domain (`process_dataset`):

1. Every file in `data/<domain>/input/` is loaded into a single DuckDB database (`system_scratch/DataFoundrySUT/<domain>.duckdb`). This is one table per CSV/TSV/Parquet/JSON file and one table per Excel sheet. Windows-1252 CSVs are transcoded, and single-column sheets are read as headerless lists.
2. That database is registered as a read-only DataFoundry datasource `kb-<domain>` and introspected.

For each task (`serve_query`):

1. The question is sent to `POST /api/copilotkit` as an agent run, with only `kb-<domain>` enabled. It carries an instruction to finish with `FINAL_ANSWER: <value>`.
2. The SUT reads the AG-UI event stream until the run ends, then reads the final assistant message from the conversation API.
3. The value after `FINAL_ANSWER:` becomes the graded answer. The full reply is kept as `full_response`.

KramaBench's exact-match metrics need a bare value such as `4.796`, not prose. Without the `FINAL_ANSWER` step, correct answers score 0.

## Prerequisites

- Node.js **≥ 22.22** (DataFoundry's `.npmrc` sets `engine-strict=true`)
- Python **3.11** (conda recommended)
- An OpenAI-compatible model endpoint that supports tool calling, for DataFoundry
- Optional: an OpenAI key, for KramaBench's LLM judge (see [Grading](#grading))

Commands below are PowerShell. On bash, use `export VAR=value` in place of `$env:VAR="value"`.

## 1. Set up DataFoundry

```powershell
cd <datafoundry>
npm install
npm run build
npm run build:web
```

Add these lines to `<datafoundry>/.env`:

```bash
AUTH_PUBLIC_BASE_URL=http://127.0.0.1:3000
AUTH_REGISTRATION_MODE=open
AUTH_EMAIL_DELIVERY=test                      # registration works without email
AUTH_SESSION_SECRET=<at least 32 random characters>
DATAFOUNDRY_MAX_RUN_TIMEOUT_MS=1800000        # allow 30-minute runs (default cap is 10)
```

Start it, and keep this terminal open for the whole evaluation:

```powershell
npm run start                                 # Web :3000, API :8787
curl.exe -s http://127.0.0.1:8787/ready       # wait until this returns JSON
```

The API port opens before the runtime finishes loading. If you send requests before `/ready` responds, you get `ECONNREFUSED`.

Then, in the web UI (`http://127.0.0.1:3000/login`):

1. **Register** an account. In test email mode, the verification link is returned directly.
2. **Create a model profile:** provider `openai-compatible`, with your base URL, key, and model. Set **timeout** to `1800000`. Run **Test** until it passes.
3. **Look up the profile id:**

```powershell
python -c "import requests,json; s=requests.Session(); s.post('http://127.0.0.1:8787/api/v1/auth/login',json={'email':'<email>','password':'<password>'}); print(json.dumps(s.get('http://127.0.0.1:8787/api/v1/model-profiles').json(),indent=2))"
```

Use the `id` of the profile you just created. **Don't use `server-default`**: that profile reads the `LLM_*` variables from `.env`, and they may point somewhere else.

## 2. Set up KramaBench

```powershell
git clone https://github.com/mitdbg/KramaBench.git
cd KramaBench
conda create -n kbench python=3.11 -y
conda activate kbench
```

Don't run `pip install .`. KramaBench's `pyproject.toml` fails on a setuptools layout error, and the harness runs in place anyway. Install the dependencies directly:

```powershell
pip install "pandas>=2.2.3,<3" "numpy>=1.26,<2.2" "huggingface-hub>=0.29.0" requests rich python-dotenv pillow jinja2 pyyaml typeguard rouge-score beautifulsoup4 wikipedia-api youtube-transcript-api "openai==1.72.0" untruncate-json duckdb openpyxl
```

Download the data (about 650 MB for all six domains; astronomy alone is about 490 MB). To download selected domains only, add an `allow_patterns` argument to `snapshot_download`.

```powershell
python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='eugenie-y/KramaBench', repo_type='dataset', local_dir='data')"
```

The harness expects the files at `data/<domain>/input/`.

### Install the SUT

```powershell
copy <datafoundry>\eval\kramabench\datafoundry_sut.py systems\datafoundry_sut.py
```

Replace the baseline imports in `systems/__init__.py` with the following. This registers the SUT and makes the bundled baselines optional, because they need `anthropic`, `smolagents`, and an OpenAI key just to be imported:

```python
from .baseline_example import ExampleBaselineSystem
from .dummy_system import DummySystem
from .datafoundry_sut import DataFoundrySUT

try:
    from .dsguru import *
except Exception as e:  # noqa: BLE001
    print(f"[systems] dsguru baselines unavailable: {e}")
try:
    from .smolagents import *
except Exception as e:  # noqa: BLE001
    print(f"[systems] smolagents baselines unavailable: {e}")
```

Re-copy `datafoundry_sut.py` whenever you change it.

## 3. Configure each terminal

Every terminal that runs `evaluate.py` needs these variables:

```powershell
conda activate kbench
cd <KramaBench>
$env:DF_API="http://127.0.0.1:8787"
$env:DF_EMAIL="<email>"; $env:DF_PASSWORD="<password>"
$env:DF_LLM_PROFILE="<model profile id>"
$env:DF_RUN_TIMEOUT="1800"                    # seconds; must be >= the profile timeout
$env:OPENAI_API_KEY="placeholder"             # or a real key; see Grading
```

| Variable | Meaning |
| --- | --- |
| `DF_API` | DataFoundry API base URL |
| `DF_EMAIL`, `DF_PASSWORD` | A verified DataFoundry account |
| `DF_LLM_PROFILE` | Model profile the agent runs with |
| `DF_RUN_TIMEOUT` | How long the SUT waits for the event stream, in seconds |
| `OPENAI_API_KEY` | Required to exist: KramaBench builds its judge client at startup even with `--no_pipeline_eval` |

Three timeouts must agree: `DATAFOUNDRY_MAX_RUN_TIMEOUT_MS` (the ceiling), the profile's timeout (the actual per-run limit), and `DF_RUN_TIMEOUT`. Whichever is shortest cuts the run off.

## 4. Smoke test one task

```powershell
$q = python -c "import json;print(json.load(open('workload/environment.json'))[0]['query'])"
python systems\datafoundry_sut.py --smoke --domain-dir data\environment\input --question $q
```

The expected answer is `4.796`. The first run on a domain also builds its DuckDB database. That takes seconds for most domains and about 7 minutes for biomedical.

## 5. Run a domain

```powershell
python evaluate.py --sut DataFoundrySUT --workload legal --no_pipeline_eval --num_workers 1 --verbose
```

| Flag | Why |
| --- | --- |
| `--workload <domain>` | One of `archeology`, `astronomy`, `biomedical`, `environment`, `legal`, `wildfire`. `<domain>-tiny` gives a quick subset. |
| `--no_pipeline_eval` | DataFoundry returns SQL and artifacts, not a Python pipeline, so code evaluation doesn't apply |
| `--num_workers 1` | Parallel workers deep-copy the SUT and multiply LLM concurrency |
| `--use_system_cache` | Reuse saved answers and run only missing tasks. Use it to resume or regrade. |

**Timing.** A task takes 5–15 minutes, because each run makes many LLM calls, including a schema-grounding step that grows with schema size.

| Domain | Tasks | Rough time |
| --- | --- | --- |
| biomedical | 9 | 1.5–3 h |
| wildfire | 21 | 2–3 h |
| legal | 30 | 4–6 h |
| all 104 | | 10–20 h serially |

**Parallel domains.** Each domain can run in its own terminal: datasources, databases, and caches are all per domain. One DataFoundry run can hold 2 or more concurrent LLM calls (main agent, session title, background helpers), so size the number of parallel domains to your provider's concurrency limit. With a limit of 4, run two lanes, for example `legal` in one terminal and `wildfire ; biomedical` in the other.

While a run is in progress, don't restart or rebuild DataFoundry, don't let the machine sleep, and avoid using the web UI with the same model.

## Outputs

Everything goes under `<KramaBench>/results/DataFoundrySUT/`:

| Path | Written | Contents |
| --- | --- | --- |
| `response_cache/tasks/<domain>_task_<id>_<timestamp>.json` | As each task finishes | `answer`, `full_response`, `runtime` |
| `response_cache/<domain>_<timestamp>.json` | End of domain | Merged answers |
| `<domain>_measures_<timestamp>.csv` | End of domain | Per-task scores (official) |
| `../aggregated_results.csv` | End of domain | One row per domain, replaced on rerun |
| `graded_snapshot.csv` | `grade_cached.py` | Offline grading table |

Every file is timestamped. Only `aggregated_results.csv` is rewritten. DataFoundry also keeps full run transcripts (events, SQL, protocol state) in `<datafoundry>/apps/api/storage/metadata/workbench.sqlite`.

## Grading

**Official (`evaluate.py`):** once all answers are cached, this only grades, which takes seconds:

```powershell
python evaluate.py --sut DataFoundrySUT --workload legal --no_pipeline_eval --use_system_cache
```

Most answer types are scored by code. `string_approximate` answers go to an **LLM judge** (OpenAI `gpt-5-mini`, hardcoded in `benchmark/metrics.py`). With a placeholder key, those tasks score 0. Legal has 3 of them, wildfire 4, biomedical 0.

⚠️ Use `--use_system_cache`, which re-grades the saved answers. Don't use `--use_evaluation_cache`, which reuses old scores.

**Offline (`grade_cached.py`):** uses the same metric classes. The judge is used if `OPENAI_API_KEY` holds a real key; otherwise it falls back to normalized exact match.

```powershell
$env:PYTHONPATH = (Get-Location).Path          # run from the KramaBench root
python <datafoundry>\eval\kramabench\grade_cached.py legal wildfire biomedical:first
```

`<domain>` grades the latest answer per task, like `evaluate.py`. `<domain>:first` grades the earliest.

## Rerun policy

Rerun a task only when the **harness or infrastructure** caused the failure: an ingestion bug, a disconnect, a provider or rate-limit error. Don't rerun DataFoundry's wrong answers or its timeouts under the configured budget. Those are results, and rerunning them until they pass is cherry-picking. When a domain has more than one pass, choose which to report by a fixed rule (for example, the first complete pass).

To rerun specific tasks, move their cached answers aside, then resume with `--use_system_cache`:

```powershell
cd results\DataFoundrySUT\response_cache
New-Item -ItemType Directory -Force superseded | Out-Null
Move-Item tasks\<domain>_task_<task-id>_*.json superseded\
Move-Item <domain>_2*.json superseded\          # the merged file, or the task counts as done
cd ..\..\..
python evaluate.py --sut DataFoundrySUT --workload <domain> --no_pipeline_eval --num_workers 1 --verbose --use_system_cache
```

To keep only the first pass per task:

```powershell
Get-ChildItem tasks\<domain>_task_* | Group-Object { $_.Name -replace '_\d{8}_\d{6}\.json$','' } |
  ForEach-Object { $_.Group | Sort-Object Name | Select-Object -Skip 1 } | Move-Item -Destination superseded
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ERR! EBADENGINE` | Node older than 22.22 | Upgrade Node (for example `conda create -n df -c conda-forge "nodejs>=22.22"`) |
| `ECONNREFUSED 127.0.0.1:8787` | API not ready yet | Wait for `/ready` |
| `No permission to access model: …` | Profile's model name or key is wrong, or the run used `server-default` | Fix the profile and set `DF_LLM_PROFILE` to its id |
| `RUN_TIMEOUT:300000` | The profile timeout is still 5 minutes | Raise the profile timeout and `DATAFOUNDRY_MAX_RUN_TIMEOUT_MS`, then rebuild and restart |
| `Read timed out` in the SUT | `DF_RUN_TIMEOUT` is shorter than the run | Raise `DF_RUN_TIMEOUT` |
| `400 Bad Request` on `/api/copilotkit` | Outdated SUT | Re-copy `datafoundry_sut.py` |
| `ModuleNotFoundError` (`untruncate_json`, `anthropic`) | Missing KramaBench dependency, or baselines imported | Install it, or apply the `systems/__init__.py` change |
| `OpenAIError: api_key … must be set` while grading | Evaluator starts its judge client at startup | Set `OPENAI_API_KEY`; a placeholder is enough |
| Answer `[DataFoundry] no answer` | Run finished without a final message | DataFoundry result. See the run in `workbench.sqlite`. |
| Answer `[DataFoundry run failed] …` | Run errored (timeout or provider error) | Rerun only if the cause was infrastructure |
| `429` / rate limit | Too many parallel domains | Fewer lanes, then rerun the affected tasks |

## Known limitations

- **File types not ingested:** `.html`, `.gpkg` (geospatial), `.py`. Tasks that depend only on these can't be answered.
- **SQL only:** these runs had Python execution off (`command_execution_enabled: false`), so statistics had to be computed in SQL.
- **One skill:** only the built-in `data-analysis` skill is available.
- **Full-lake mode only:** the SUT ignores KramaBench's `subset_files` and registers the whole lake, so `--use_truth_subset` has no effect yet.
- **Schema truncation:** on large lakes (legal has 131 tables), DataFoundry's context budget omits tables from `inspect_schema`, and the agent has to search for them itself.
- **Scores depend on the model:** report the model profile alongside any score.
