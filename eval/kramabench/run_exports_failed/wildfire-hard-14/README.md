# wildfire-hard-14

> What is the correlation between the proportion of generally unsafe air quality days according to the EPA and the amount of land affected by fires in 2024? Round to 2 decimal places.

| | |
|---|---|
| Expected | `0.65` (numeric_approximate) |
| Graded answer | `0.42` |
| Score | 0.7386363636363636 |
| Failure reason | Measure definition (verified) |
| Run | `run-461d7983` · completed · 842s · glm-5.3-flash |
| Activity | 48 steps: 17 messages, 31 tool calls (13 failed), 21 SQL (14 ok) |
| Contract grounding | failed |
| Declared sources | `Wildfire_Acres_by_State.csv`, `annual_aqi_by_county_2024.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
