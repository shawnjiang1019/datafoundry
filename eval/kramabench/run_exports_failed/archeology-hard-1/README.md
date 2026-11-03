# archeology-hard-1

> What is the average Potassium in ppm from the first and last time the study recorded people in the Maltese area? Assume that Potassium is linearly interpolated between samples. Round your answer to 4 decimal places.

| | |
|---|---|
| Expected | `8577.5298` (numeric_exact) |
| Graded answer | `8347.1887` |
| Score | 0.0 |
| Failure reason | Units / reference frame (verified) |
| Run | `run-de06f9d6` · completed · 690s · glm-5.3-flash |
| Activity | 29 steps: 14 messages, 15 tool calls (5 failed), 7 SQL (6 ok) |
| Contract grounding | failed |
| Declared sources | `climateMeasurements.xlsx`, `radiocarbon_database_regional.xlsx` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
