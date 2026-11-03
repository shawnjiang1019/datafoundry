# wildfire-hard-19

> In 2016, what percentage (to 2 decimal places) of fires were brought under control with it raining moderately or heavily (>0.05 in) in the fire area on the same or a day before the control day? Assume that the narrowest diameter of the fire area is 1km. Under this assumption, if a weather station falls into the fire area, you can use the detailed weather observation from that station for that fire incident.

| | |
|---|---|
| Expected | `32.76` (numeric_approximate) |
| Graded answer | `Variant A (NWS ID join) yields 464/479 = 96.87%. For due diligence, let me also compute the rounded-coordinate join variant (Variant B) to compare which interpretation fits the data design.` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-5bd24bf4` · failed · 1861s · glm-5.3-flash |
| Activity | 76 steps: 20 messages, 56 tool calls (18 failed), 41 SQL (31 ok) |
| Contract grounding | failed |
| Declared sources | `noaa_wildfires.csv`, `noaa_wildfires_variabledescrip.csv`, `WeatherEvents_Jan2016-Dec2022.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
