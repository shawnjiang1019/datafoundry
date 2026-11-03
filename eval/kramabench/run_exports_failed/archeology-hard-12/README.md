# archeology-hard-12

> Count the number of human conflicts between 800 and 1400 AD, and attribute them as best you can to modern countries. Define a conflict as between two actors that lasts at least a year.

| | |
|---|---|
| Expected | `409` (numeric_exact) |
| Graded answer | `233` |
| Score | 0.0 |
| Failure reason | Spec ambiguity (verified) |
| Run | `run-b9e4b33f` · completed · 1836s · glm-5.3-flash |
| Activity | 65 steps: 27 messages, 38 tool calls (13 failed), 31 SQL (20 ok) |
| Contract grounding | failed |
| Declared sources | `conflict_brecke.csv`, `worldcities.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
