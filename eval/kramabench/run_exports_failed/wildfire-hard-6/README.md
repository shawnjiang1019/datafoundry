# wildfire-hard-6

> What is the correlation between (1) the difference between the number of NOAA and NIFC-reported fires and (2) the difference between the acres burned by NOAA and NIFC-reported fires, on an annual basis? Answer to three decimal places.

| | |
|---|---|
| Expected | `0.519` (numeric_approximate) |
| Graded answer | `0.505` |
| Score | 0.973733583489681 |
| Failure reason | Precision / convention (verified) |
| Run | `run-40cffe71` · completed · 531s · glm-5.3-flash |
| Activity | 30 steps: 9 messages, 21 tool calls (10 failed), 8 SQL (6 ok) |
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
