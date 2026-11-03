# wildfire-hard-17

> What is the average elevation (in feet) of the weather stations used for fire site monitoring in the NOAA dataset?

| | |
|---|---|
| Expected | `4830.9` (numeric_approximate) |
| Graded answer | `3188.9141` |
| Score | 0.7463286198201022 |
| Failure reason | Grain & entity key (reclassified) |
| Run | `run-ebf9c64b` · completed · 723s · glm-5.3-flash |
| Activity | 48 steps: 22 messages, 26 tool calls (16 failed), 12 SQL (5 ok) |
| Contract grounding | failed |
| Declared sources | `noaa_wildfires.csv`, `noaa_wildfires_variabledescrip.csv`, `PublicView_RAWS_-3515561676727363726.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
