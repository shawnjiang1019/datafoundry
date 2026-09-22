# DA-Code on DataFoundry

Run [DA-Code](https://github.com/yiyihum/da-code) (EMNLP 2024) with DataFoundry as the system under test, then score with DA-Code's own evaluator.

DA-Code grades **files**, not chat answers: each task says "save the result to `result.csv`", and `evaluate.py` compares that file with the gold file. This runner drives DataFoundry over the tasks and lays the produced files out where the evaluator expects them.

| File | Purpose |
| --- | --- |
| `datafoundry_dacode.py` | Task runner: ingest → run → collect output files |

## How it works

Per task:

1. **Ingest.** Tabular files in `da_code/source/<task-id>/` are loaded into a per-task DuckDB (one table per file) and registered as a datasource, so the SQL-first agent can query them. This reuses the KramaBench harness's ingester, including header and delimiter detection.
2. **Seed the workspace.** All source files (including `README.md` and `tips.md`, which are not tables) are copied into the session workspace, so `read_file` reaches anything SQL cannot express.
3. **Run** the task instruction plus a short harness note describing both access paths and the required deliverable.
4. **Collect.** The output files DA-Code expects — read from its own `configs/eval/eval_all.jsonl`, e.g. `result.csv`, `author.csv`, `submission.csv` — are copied to `<output_dir>/<task-id>/`.

**Answer recovery.** The runner takes the file the agent wrote, and falls back to a fenced block in the final message when there is none. DataFoundry's analysis protocol can refuse `write_file` until requirement claims are committed; for DA-Code the file *is* the deliverable, so the harness accepts either.

Per-task records (status, timing, session id, which outputs came from a file vs a reply block, the tail of the final message) are written to `<output_dir>/_runs/<task-id>.json`.

## Prerequisites

- DataFoundry running (`npm run start`) with a verified account and a working model profile
- DA-Code cloned, by default at `C:\Users\shawn\DA-Code` (override with `--dacode-root` or `DACODE_ROOT`)
- Python with `requests`, `duckdb`, `pandas`, `openpyxl` (the `kbench` env already has these)

Environment variables are the same as the KramaBench harness:

```powershell
$env:DF_API="http://127.0.0.1:8787"
$env:DF_EMAIL="<email>"; $env:DF_PASSWORD="<password>"
$env:DF_LLM_PROFILE="<model profile id>"
$env:DF_RUN_TIMEOUT="1800"
```

## Usage

```powershell
# what can run with the data you have
python eval\dacode\datafoundry_dacode.py --list

# a few tasks
python eval\dacode\datafoundry_dacode.py --types di,dw,dm,sa --limit 5

# specific tasks, or resume a partial run
python eval\dacode\datafoundry_dacode.py --ids data-sa-028,di-text-001
python eval\dacode\datafoundry_dacode.py --types di,dm --resume
```

Then score, from the DA-Code repo:

```powershell
python evaluate.py --output_dir output\datafoundry --gold_dir da_code\gold `
    --eval_json da_code\configs\eval\eval_all.jsonl --result_dir results
```

The evaluator prints an average score plus breakdowns by task type, hardness, and result type.

## Coverage

DA-Code has 500 tasks. By grading function:

| Grader | Tasks | Reachable by a SQL-first agent |
| --- | --- | --- |
| `compare_csv` | 243 | yes |
| `compare_text` | 71 | yes |
| `compare_sqlite` | 8 | yes |
| `compare_ml` + `compare_competition_ml` | 100 | no — needs model training |
| `compare_image` | 78 | no — needs plot files |

So ~322 of 500 are in scope for these runs. Within those, tasks needing a statistical function SQL lacks (a t-test p-value, for example) will still fail unless Python execution is enabled.

**The public repo ships source data for ~62 tasks** (23 of them in the di/dw/dm/sa groups). The full dataset is a separate download — see "Get Full Dataset" in DA-Code's README for the `source.zip` and `gold.zip` Drive links, unzipped to `da_code/source` and `da_code/gold`.

## Notes and limitations

- **One DuckDB per task**, named with a random suffix. The API holds DuckDB files open for its lifetime, so reusing a filename across runs would fail to open.
- **Datasource accumulation:** each task registers `dac-<task-id>-<suffix>`. Remove them periodically if the datasource list gets noisy.
- **Python and plots are off** in these runs, so ML and visualization tasks are expected failures rather than results worth reporting.
- **Scores are not comparable to DA-Code's published baselines**, which run an agent in a Docker sandbox with Python, bash and multi-file code execution. This harness measures a SQL-first agent on the subset it can express.
