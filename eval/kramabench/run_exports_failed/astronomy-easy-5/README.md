# astronomy-easy-5

> Estimate the total count of satellite major altitude changes (change of altitude > 1000m within 12h) for satellite 48445 during 2024 using TLE history. Use skifield's itrf_xyz to estimate altitude from TLE.

| | |
|---|---|
| Expected | `2` (numeric_exact) |
| Graded answer | `0` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-a8cf6f2f` · completed · 775s · glm-5.3-flash |
| Activity | 44 steps: 18 messages, 26 tool calls (7 failed), 16 SQL (12 ok) |
| Contract grounding | failed |
| Declared sources | `TLE/48445.tle` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
