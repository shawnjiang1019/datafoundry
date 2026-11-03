# legal-hard-17

> If the 2007 report category distribution were exactly like the 2024 ones, how many reports in 2007 would be Auto Related (rounded to the nearest integer)?

| | |
|---|---|
| Expected | `32542` (numeric_exact) |
| Graded answer | `32587` |
| Score | 0.0 |
| Failure reason | Precision / convention (verified) |
| Run | `run-48d682bb` · completed · 644s · glm-5.3-flash |
| Activity | 19 steps: 9 messages, 10 tool calls (3 failed), 2 SQL (1 ok) |
| Contract grounding | failed |
| Declared sources | `2024_CSN_Report_Count.csv`, `2024_CSN_Report_Categories.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
