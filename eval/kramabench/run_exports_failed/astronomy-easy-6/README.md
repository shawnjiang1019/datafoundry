# astronomy-easy-6

> Using TLE data fetched for Starlink satellites 58214, calculate the average rate of semi-major axis decay (km/day) for the Gannon storm (May 10-13, 2024) and the preceding quiet period (May 1-4, 2024). Use earth's gravitational paremeter mu = 398600.4418 km^3/s^2, earth radius 6371.0 km, and Kepler's law as a rough estimate of the semi-major axis length. Report in a pair of numbers: (average_quiet_rate_km_day, average_storm_rate_km_day). The tle files are located in input/space-track/, with format <NORAD_ID>_storm.csv and <NORAD_ID>_quiet.csv.

| | |
|---|---|
| Expected | `[0.0193, -0.002]` (list_approximate) |
| Graded answer | `[DataFoundry run failed] Rate limit reached for requests` |
| Score | 0.0 |
| Failure reason | Provider rate limit (verified) |
| Run | `run-8fb7443a` · failed · 5s · glm-5.3-flash |
| Activity | 0 steps: 0 messages, 0 tool calls (0 failed), 0 SQL (0 ok) |
| Contract grounding | none |
| Declared sources | `space-track/58214_storm.csv`, `space-track/58214_quiet.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
