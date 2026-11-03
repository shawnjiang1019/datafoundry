# astronomy-easy-4

> Determine the approximate period of solar activity cycles and identify the top five years of minimum and maximum activity between 1960 and 2020 using historical yearly mean sunspot numbers. To be considered as a maximum, a peak needs to have a prominence of 20 and distance of 5. Similar rules apply for the minimum.

| | |
|---|---|
| Expected | `The average period is 11 years, with maxima in 1968, 1979, 1989, 2000, and 2014, and minima in 1964, 1976, 1986, 1996, and 2008.` (string_approximate) |
| Graded answer | `11` |
| Score | 0.0 |
| Failure reason | Output format (verified) |
| Run | `run-4be766b2` · completed · 1195s · glm-5.3-flash |
| Activity | 56 steps: 23 messages, 33 tool calls (10 failed), 17 SQL (15 ok) |
| Contract grounding | clean |
| Declared sources | `SILSO/SN_y_tot_V2.0.csv` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
