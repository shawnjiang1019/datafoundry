# wildfire-hard-10

> By count, are there more fires in Democratic states or Republican states? Answer **only** with 'Democratic' or 'Republican'.

| | |
|---|---|
| Expected | `Republican` (string_exact) |
| Graded answer | `Democratic` |
| Score | 0.0 |
| Failure reason | Source / column selection (reclassified) |
| Run | `run-818c6b22` · completed · 593s · glm-5.3-flash |
| Activity | 39 steps: 12 messages, 27 tool calls (9 failed), 18 SQL (15 ok) |
| Contract grounding | failed |
| Declared sources | `Wildfire_Acres_by_State.csv`, `democratic_vs_republican_votes_by_usa_state_2020.csv`, `wildfire_total_fires_p45_54.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
