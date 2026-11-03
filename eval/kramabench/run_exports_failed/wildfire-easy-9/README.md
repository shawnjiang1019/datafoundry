# wildfire-easy-9

> How many more or less fatalities occurred due to wildfires on days with humidity less than 30% compared to the average? Positive numbers indicate more, and negative numbers will indicate less. Round to four decimal places.

| | |
|---|---|
| Expected | `-0.0059` (numeric_approximate) |
| Graded answer | `25.9818` |
| Score | 0.00022697894866428658 |
| Failure reason | Grain & entity key (reclassified) |
| Run | `run-6b350c16` · completed · 440s · glm-5.3-flash |
| Activity | 21 steps: 4 messages, 17 tool calls (9 failed), 7 SQL (4 ok) |
| Contract grounding | failed |
| Declared sources | `Fire_Weather_Data_2002-2014_2016.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
