# wildfire-easy-3

> Which US states (using full names) fall into the most number of NIFC Geographic Areas?

| | |
|---|---|
| Expected | `['California', 'Nevada']` (list_exact) |
| Graded answer | `["Arizona","California","Colorado","Idaho","Montana","Nevada","New Mexico","Oregon","Utah","Washington","Wyoming"]` |
| Score | 0.3076923076923077 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-3c75bdd0` · completed · 759s · glm-5.3-flash |
| Activity | 64 steps: 7 messages, 57 tool calls (17 failed), 42 SQL (32 ok) |
| Contract grounding | failed |
| Declared sources | `usa.gpkg`, `nifc_geographic_areas.gpkg` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
