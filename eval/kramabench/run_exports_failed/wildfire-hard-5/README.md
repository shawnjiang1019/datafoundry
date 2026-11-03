# wildfire-hard-5

> On average, how many more annual fires are reported by NOAA compared to NIFC since 2000? Round to the nearest whole number.

| | |
|---|---|
| Expected | `-1039` (numeric_exact) |
| Graded answer | `-71072` |
| Score | 0.0 |
| Failure reason | Source / column selection (verified) |
| Run | `run-ebbc8436` · completed · 835s · glm-5.3-flash |
| Activity | 26 steps: 11 messages, 15 tool calls (3 failed), 8 SQL (8 ok) |
| Contract grounding | failed |
| Declared sources | `noaa_wildfires_monthly_stats.csv`, `nifc_wildfires.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
