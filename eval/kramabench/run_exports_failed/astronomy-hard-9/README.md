# astronomy-hard-9

> Determine the best lag (from 0 to 48 hours) between atmospheric drag--measured as semi-major axis change (in km) from TLE data of SATCAT 43180--and the OMNI AP index, that maximizes the r^2 correlation during May 1--30, 2024. TLE epoch times should be rounded to the nearest hour to align with AP measurements. Use hourly OMNI2 data. omni2 data format specification can be found at omni2.text file Use earth's gravitational paremeter mu = 398600.4418 km^3/s^2.

| | |
|---|---|
| Expected | `24` (numeric_exact) |
| Graded answer | `N/A` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-a502c4bc` · completed · 780s · glm-5.3-flash |
| Activity | 42 steps: 10 messages, 32 tool calls (4 failed), 21 SQL (21 ok) |
| Contract grounding | failed |
| Declared sources | `TLE/43180.tle`, `omni2_low_res/omni2_2024.dat`, `omni2_low_res/omni2.txt` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
