# wildfire-easy-2

> Which NIFC geographic area intersects with the most US states? Give the abbreviation of the geographic area

| | |
|---|---|
| Expected | `EACC` (string_exact) |
| Graded answer | `SACC` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-56b535cd` · completed · 710s · glm-5.3-flash |
| Activity | 29 steps: 12 messages, 17 tool calls (6 failed), 9 SQL (6 ok) |
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
