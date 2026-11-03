# biomedical-easy-9

> What is the difference between the average false discovery rate (FDR) in CBX3 genes and the average FDR for the rest of the genes?

| | |
|---|---|
| Expected | `-0.008003975` (numeric_exact) |
| Graded answer | `-0.30146079356102073` |
| Score | 0.0 |
| Failure reason | Source / column selection (verified) |
| Run | `run-9b8f9330` · completed · 435s · glm-5.3-flash |
| Activity | 30 steps: 10 messages, 20 tool calls (6 failed), 4 SQL (3 ok) |
| Contract grounding | failed |
| Declared sources | `1-s2.0-S0092867420301070-mmc3.xlsx` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
