# wildfire-hard-21

> Based on NOAA data, what are the top 3 states that lost the most residential property in value between 2005 and 2010 (including 2005 and 2010)? Answer in state full names and do not discard rows with missing values unecessarily.

| | |
|---|---|
| Expected | `['California', 'Washington', 'Idaho']` (list_exact) |
| Graded answer | `["Washington", "California", "Utah"]` |
| Score | 0.6666666666666666 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-3989d26b` · completed · 648s · glm-5.3-flash |
| Activity | 34 steps: 16 messages, 18 tool calls (7 failed), 5 SQL (4 ok) |
| Contract grounding | failed |
| Declared sources | `noaa_wildfires.csv`, `noaa_wildfires_variabledescrip.csv`, `ZHVI.csv`, `state_abbreviation_to_state.json` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
