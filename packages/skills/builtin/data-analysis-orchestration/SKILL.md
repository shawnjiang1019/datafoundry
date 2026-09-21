---
name: data-analysis-orchestration
description: Orchestrate end-to-end data analysis tasks from datasource selection and plan approval through tracked execution, result validation, and artifact delivery for multi-step investigations and reports.
version: 1.0.0
tags:
  - data
  - analysis
  - orchestration
  - plan
  - sql
  - report
  - artifact
  - 数据分析
  - 查数
  - 指标
  - 报表
  - 任务编排
  - 数据源
allowed-tools:
  - list_data_sources
  - inspect_schema
  - preview_table
  - run_sql_readonly
  - retrieve_knowledge
  - read_file
  - write_file
  - edit_file
  - list_files
  - grep
  - ask_user
  - submit_plan
  - task_write
  - task_update
  - task_complete
  - task_check
  - promote_workspace_file
  - read_workspace_file
  - list_workspace_files
  - analysis_requirements_commit
denied-tools: []
user-invocable: true
---
# Data Analysis Orchestration

Use this skill to run multi-step data work end to end: choose the right datasource, decide between a
direct answer or an approved plan, execute with tracked tasks, validate results, and deliver verified
artifacts.

Chinese search aliases: 数据分析, 查数, 指标查询, 报表, 任务编排, 数据源选择, 计划审批, 多步分析, 交付产物.

This workflow is adapted for this workbench from external agent orchestration skill patterns:

- Confirm the datasource before touching data.
- Choose direct execution or plan approval based on task weight.
- Track every step with tasks; verify completion before delivering.
- Validate results and artifacts before claiming success.
- Retry only the failed step; never repeat completed work.

## 1. Pre-Flight Checks

1. Call `list_data_sources` before any data access, then choose the exact datasource:
   - Prefer a datasource the user explicitly named.
   - Auto-select only when exactly one candidate clearly matches the request.
   - When several candidates are plausible, ask the user to choose with `ask_user`; never guess.
2. When a knowledge base is enabled for the run, call `retrieve_knowledge` first for metric
   definitions, prior findings, or document-backed facts before guessing or writing SQL.
3. Datasource and schema context are per-run. A datasource or schema chosen in an earlier session
   must be reconfirmed with `list_data_sources` and `inspect_schema` in the current run.
4. Model credentials, datasource credentials, and tool configuration are provided by the runtime.
   Do not read, print, or construct credentials or configuration files.

## 2. Choose The Workflow

### Direct execution

For one-off lookups that need no prior review — one metric, a simple filter, or a factual
question — skip planning: classify the question, inspect the schema, run a small number of
read-only queries, validate, and answer.

### Plan approval and tracked execution

Use this path when the work has three or more distinct actions, spans several sub-questions, or the
user wants to review the approach first:

1. Call `task_write` with the full task breakdown before doing the work.
2. When the user should approve before execution, submit the plan with `submit_plan` and wait for
   the decision. Do not start executing while a plan is pending. If the plan is rejected, revise
   and resubmit instead of proceeding anyway.
3. Execute stepwise: mark a step in progress with `task_update`, then finished with
   `task_complete`.
4. Before delivering, call `task_check` and confirm no task is left incomplete or in progress.

## 3. Query Discipline

- Inspect before query. `inspect_schema` returns a run-local `schema_id`; use it for
  `preview_table` and `run_sql_readonly`. A schema token from an earlier run is not valid.
- Use exact inspected table and column names. If a query fails, re-inspect the schema or simplify
  the query; do not guess alternate names blindly.
- Retrieve only the data needed for the current question. Prefer a few high-signal queries over
  many speculative ones.
- Write only single read-only `SELECT` or `WITH` statements through `run_sql_readonly`.

## 4. Accept Results Before Delivering

A finished tool call is not success by itself. Before presenting conclusions:

1. Run validation checks appropriate to the task: row-count sanity, null handling, magnitude
   plausibility, aggregation alignment, trend continuity, and whether filters matched the requested
   scope. Investigate concerns when possible and surface remaining caveats.
2. Confirm completion: every task must be complete per `task_check`. Any failed or skipped step
   makes the delivery partial even when the rest succeeded; state this explicitly.
3. Commit final claims with `analysis_requirements_commit` only when they are backed by validated
   query evidence.
4. For artifacts, cite the exact paths returned by the tools that produced them and confirm the
   file exists and is readable with `read_workspace_file` or `list_workspace_files` before
   referencing it. Save reusable outputs as workspace files and publish cross-session ones with
   `promote_workspace_file`.

When delivering, state the datasource used, overall completion status, failed or skipped steps, key
conclusions, and artifact paths.

## 5. Troubleshoot Failures

- Schema or SQL error: re-run `inspect_schema`, correct names, or simplify the query; do not guess
  alternate names blindly.
- Ambiguous or missing datasource: re-run `list_data_sources`; if it stays ambiguous, ask the user
  to choose.
- Tool failure: surface it and explain what failed and how the approach adapted. Never hide tool
  failures.
- Step failure mid-task: keep completed results and artifacts, report the failed step and its
  impact, fix the specific cause, and retry only that step.
- Do not re-run completed steps that already produced files or artifacts just to confirm them; read
  the existing outputs instead.

## Guardrails

- Never bypass the Data Gateway with command-line database clients, write SQL, DDL, or
  multi-statement SQL.
- Never invent schemas, rows, metric definitions, SQL results, artifact paths, or file contents.
- Never print or log credentials, API keys, or connection strings.
- Never claim full success when any step failed or was skipped.
- Never re-execute completed side-effectful work only to produce a summary.
