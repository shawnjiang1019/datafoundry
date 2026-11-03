# Tools available to the DataFoundry agent

Every tool the agent can call, grouped by purpose. "Calls" counts how often the agent used each tool across the 97 graded KramaBench runs (from `eval/kramabench/run_exports/all_steps.csv`).

The protocol can also restrict tools by phase. For example, `list_data_sources` is rejected during the execution phase with `ACTION_NOT_ALLOWED_IN_PHASE`.

## Data (DataFoundry's governed data gateway)

| tool | what it does | calls |
|---|---|---|
| `list_data_sources` | Lists the datasources enabled for this run. In the benchmark, this is the one domain database, e.g. `kb-archeology`. | 100 |
| `inspect_schema` | Returns a datasource's tables and columns and issues a `schema_id` for this run. Every preview and SQL call must cite that ID, or it fails with `SCHEMA_REQUIRED_BEFORE_SQL`. | 117 |
| `preview_table` | Returns the first rows of one table, to show its shape and example values. | 298 |
| `run_sql_readonly` | Runs one read-only `SELECT`/`WITH` query through the gateway, which enforces the read-only guard, row limit and timeout, and writes an audit log entry. The full result is saved as a CSV; the agent receives a preview of the rows (often capped at 20) plus the total row count. | 1,177 |

## Analysis protocol

| tool | what it does | calls |
|---|---|---|
| `analysis_requirements_commit` | Commits the final claim for each requirement, bound to evidence from successful SQL results. The completion check reads these claims. It rejects numeric values with `ANALYSIS_CLAIM_VALUE_UNKNOWN` when contract grounding registered no value names. | 291 |
| `protocol_handoff` | Proposes switching the run to another authorized protocol, such as from data analysis to a general task, when the current one doesn't fit. The runtime decides whether to accept. | 4 |

## Knowledge

| tool | what it does | calls |
|---|---|---|
| `retrieve_knowledge` | Searches the uploaded documents in a knowledge base enabled for the run (glossaries, data dictionaries, past reports) and returns matching passages with citations. Benchmark runs enable none, so every call fails with `KNOWLEDGE_BASE_NOT_ENABLED`. | 48 |

## Skills

| tool | what it does | calls |
|---|---|---|
| `skill` | Loads a skill's instructions into the conversation, such as the data-analysis workflow. Most runs start with it. | 95 |
| `skill_search` | Finds available skills that match a query. | 2 |
| `skill_read` | Reads a file inside a skill package, such as a reference or template. | 0 |

## Files in the run's session workspace

A private folder for this session. Files created here stay here unless promoted.

| tool | what it does | calls |
|---|---|---|
| `list_files` | Lists files and folders in the session workspace. | 20 |
| `read_file` | Reads a file from the session workspace. | 0 |
| `write_file` | Creates or overwrites a file, e.g. a report or an exported table. | 28 |
| `edit_file` | Replaces text inside an existing file. | 0 |
| `file_stat` | Returns a file's size, type and timestamps. | 0 |
| `mkdir` | Creates a folder. | 0 |
| `grep` | Searches file contents for a pattern. | 0 |
| `execute_command` | Runs a shell command, including Python from a managed environment, inside a sandbox. Only offered when a sandbox is available (bubblewrap on Linux, Seatbelt on macOS) and `WORKSPACE_COMMAND_ENABLED` isn't `false`, so it isn't available on this Windows setup. | 0 |

## Shared workspace (across sessions)

| tool | what it does | calls |
|---|---|---|
| `list_workspace_files` | Lists files in the user's shared workspace area, which every session can see. Read-only. | 0 |
| `read_workspace_file` | Reads one file from the shared workspace area. | 0 |
| `promote_workspace_file` | Copies a session file into the shared area so other sessions can use it. | 0 |

## Task tracking and asking the user

Only offered when the task-state runtime is enabled for the run.

| tool | what it does | calls |
|---|---|---|
| `task_write` | Creates or replaces the run's structured task list. | 0 |
| `task_update` | Changes one task in the list by its ID, e.g. its status. | 0 |
| `task_complete` | Marks one task done by its ID. | 0 |
| `task_check` | Reports how many tasks are done and which are still open, to check before finishing. | 0 |
| `ask_user` | Pauses the run to ask the user a question, and resumes when they answer. | 0 |
| `submit_plan` | Pauses the run to show the user a plan for approval before continuing. | 0 |

---

**In practice**, the benchmark runs use almost only the four data tools and the commit tool. They account for 1,983 of 2,180 calls (91%), and `run_sql_readonly` alone is 54%. Of the rest, the most common by far is `retrieve_knowledge`, which can never succeed in these runs.
