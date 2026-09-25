# wildfire-hard-18

> Based on the NOAA dataset, controlling for the weather, do more aggressive suppression actually contribute to fire ending faster and affecting less buildings?

| | |
|---|---|
| Expected | `More aggressive suppression does not help fires end faster but helps fires affect less buildings.` (string_approximate) |
| Graded answer | `["No", "Yes"]` |
| Score | 0.0 |
| Failure reason | Output format (verified) |
| Run | `run-688218d9` · completed · 820s · glm-5.3-flash |
| Activity | 29 steps: 8 messages, 21 tool calls (11 failed), 11 SQL (5 ok) |
| Contract grounding | failed |
| Declared sources | `noaa_wildfires.csv`, `noaa_wildfires_variabledescrip.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
