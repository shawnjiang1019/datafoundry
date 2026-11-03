# archeology-hard-2

> Across the years, what was the percent of years the wet-dry index was increasing? Give your answer in percentage, round your answer to 2 decimal places.

| | |
|---|---|
| Expected | `38.42` (numeric_exact) |
| Graded answer | `50.25` |
| Score | 0.0 |
| Failure reason | Grain & entity key (verified) |
| Run | `run-7f672064` · completed · 278s · glm-5.3-flash |
| Activity | 20 steps: 9 messages, 11 tool calls (2 failed), 4 SQL (4 ok) |
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
