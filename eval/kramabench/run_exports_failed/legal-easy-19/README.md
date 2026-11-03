# legal-easy-19

> What is the proportion (round to 3 decimal places) of fraud reporters who lost between $1-$500 in 2024?

| | |
|---|---|
| Expected | `0.523` (numeric_exact) |
| Graded answer | `0.199` |
| Score | 0.0 |
| Failure reason | Grain & entity key (verified) |
| Run | `run-b6c5fd99` · completed · 414s · glm-5.3-flash |
| Activity | 17 steps: 6 messages, 11 tool calls (4 failed), 5 SQL (2 ok) |
| Contract grounding | failed |
| Declared sources | `2024_CSN_Fraud_Reports_by_Amount_Lost.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
