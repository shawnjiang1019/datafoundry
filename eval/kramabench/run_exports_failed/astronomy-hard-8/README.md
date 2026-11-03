# astronomy-hard-8

> Compare the predictive accuracy (using RMSE) of two single-variable linear regression models forecasting Swarm Alpha's along-track acceleration 3 hours ahead during May 11, 2024. Model 1 uses only OMNI Kp index as input; Model 2 uses only OMNI solar wind dynamic pressure (Pdyn) as input. Report both RMSE values on the test set in a list with format [number for Kp input, number for Pdyn input].

| | |
|---|---|
| Expected | `[6.1655e-07, 5.1206e-07]` (list_approximate) |
| Graded answer | `not computable from the available data` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-eded22bc` · completed · 736s · glm-5.3-flash |
| Activity | 45 steps: 19 messages, 26 tool calls (3 failed), 15 SQL (14 ok) |
| Contract grounding | failed |
| Declared sources | `omni2/omni2_Kp_Index.lst`, `omni2/omni2_Flow_Pressure.lst`, `swarm/SW_OPER_ACCACAL_2__20240511T000000_20240511T235959_0304.cdf` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
