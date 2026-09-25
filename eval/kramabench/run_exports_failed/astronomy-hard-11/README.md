# astronomy-hard-11

> Using OMNI2 data, run the NRLMSISE-00 atmospheric model to predict neutral density values for Swarm-B throughout 2024. Derive model inputs (F10.7, F10.7A, daily Ap, 3-hour Ap vector) directly from the OMNI2 dataset. Compare predictions against measured neutral density from Swarm-B POD files and report RMSE over the entire year. Do not use external space weather feeds. OMNI2 data format specification can be found at omni2.text file. 3-hour AP defined according to https://www.mathworks.com/help/aeroblks/nrlmsise00atmospheremodel.html.

| | |
|---|---|
| Expected | `4.638e-13` (numeric_exact) |
| Graded answer | `[DataFoundry] no answer` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-ebc2d302` · completed · 836s · glm-5.3-flash |
| Activity | 83 steps: 0 messages, 83 tool calls (16 failed), 67 SQL (58 ok) |
| Contract grounding | failed |
| Declared sources | `swarmb/SB_DNS_POD_2024_*.txt`, `omni2_low_res/omni2_2024.dat`, `omni2_low_res/omni2_2023.dat`, `omni2_low_res/omni2.txt` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
