# archeology-easy-8

> How many unique sources were used in the Roman cities dataset?

| | |
|---|---|
| Expected | `52` (numeric_exact) |
| Graded answer | `55` |
| Score | 0.0 |
| Failure reason | Grain & entity key (verified) |
| Run | `run-0eaf498b` · completed · 374s · glm-5.3-flash |
| Activity | 30 steps: 13 messages, 17 tool calls (6 failed), 9 SQL (6 ok) |
| Contract grounding | failed |
| Declared sources | `roman_cities.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
