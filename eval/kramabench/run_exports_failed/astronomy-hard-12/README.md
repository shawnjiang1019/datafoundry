# astronomy-hard-12

> Estimate the mean geopotential energy per unit mass (in J/kg) experienced by Swarm-A from September 2 to 29, 2019 using precise orbital data. Use SP3 files to determine the satellite's geodetic position, and interpolate a mock geopotential field defined over latitude, longitude, and altitude to compute the potential energy at each timepoint. Average the results to compute the mean energy. Use earth radius 6371.0 km, and g = 9.80665 m/s^2. Answer round to 2 decimal places.

| | |
|---|---|
| Expected | `66822738.84` (numeric_exact) |
| Graded answer | `Timestamp reconstruction matters here: SP3 files typically name the validity start (20190902T235942), while in-file epochs begin at header date "2019 9 3 00:00:00" (start+18s). So filename-date reconstruction (which gave mean 66822663.02, not matching) mislabels every epoch by one day. The header-declared epoch date is authoritative. Let me verify header date vs filename date per file, then recompute with header-based timestamps.` |
| Score | 0.0 |
| Failure reason | Source data unavailable (verified) |
| Run | `run-6fce0487` · failed · 1816s · glm-5.3-flash |
| Activity | 117 steps: 50 messages, 67 tool calls (21 failed), 60 SQL (40 ok) |
| Contract grounding | failed |
| Declared sources | `swarm/POD/SW_OPER_SP3ACOM_2__201909??T????_201909??T????_0201/*.sp3`, `mock_tiegcm_grid_sept2019.npz` |

## Files

| file | what it holds |
|---|---|
| [trace.md](trace.md) | the whole run, untruncated, readable top to bottom |
| [steps.csv](steps.csv) | one row per agent step: tool, status, error, SQL, rows returned vs rows shown to the agent, message |
| [steps.jsonl](steps.jsonl) | the same steps with complete arguments and results, one JSON per line |
| [sql.csv](sql.csv) | every SQL statement sent, with status, rows, time and error |
| [sql_results/](sql_results/) | the full result CSV of each successful query (`step-NN.csv`) |
| [requirements.json](requirements.json) | requirements, acceptance criteria, assertions, grounding outcome |
