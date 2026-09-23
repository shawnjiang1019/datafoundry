# DataFoundry Capability Gaps

A set of notes highlighting gaps of what is currently in DataAgent/DataFoundry, and some areas of improvement that GEMS can be used.

For a full list of DataFoundry/DataAgent capabilities consult the GitHub/GitCode repositories.

## Summary

| Roadmap item | State | Core gap |
| --- | --- | --- |
| Unified semantic layer | Partial | Grounding exists; no durable first-party store |
| Autonomous analyst loops | Partial | Loop exists; no search / multi-hypothesis |
| Evaluation & reliability lab | Near-empty | One benchmark |
| Enterprise control plane | Not started | Auth only; no RBAC / approvals / limits |
| Table discovery over a lake | Not started | Alphabetical truncation, no search or ranking |
| Grain & population contract | Not started | Grain, universe and entity key are never declared or checked |

## 1. Semantic layer

Entities and relationships exist only as **inference via the optional external DataLink service** (`services/datalink`: a confidence-scored graph of column/table/concept/entity nodes + edges) plus a local schema fallback (`agent-runtime/src/semantic/`).

Missing as durable first-party state (`packages/metadata` `ConfigResourceKind` = datasource-schema / knowledge-base / mcp-server / model-profile / skill only):

- **Metrics** — no stored, reusable metric definitions.
- **Lineage** — not modeled anywhere.
- **Policies** — no semantic-level governance rules.

Net: the agent can *guess business meaning* from an external graph, but the product has no owned semantic layer to curate, version, or enforce.

`DataLink` defines nodes to be columns from different graphs and constructs relations between those nodes. They also have `concept nodes` and `entity nodes`, but no `tool nodes`

For finding non-direct relations it requires a `bfs` or graph search component. (Is X reachable from Y?). Alternatively vector search can be used on the nodes instead, but this does not guarantee that there will be a path between them.

The construction of knowledge/concept graphs is different in comparison to GEMS proposal. GEMS supposes that an authoritative source is given, then it derives the relations, extracts, and progressively formalizes.

There is a claimed unified semantic layer which is in `DataGallery` but that is not open.

Semantic layer is primarily `NL2SQL`.

## 2. Analyst loops

`protocol-runtime.ts` + `protocols/data-analysis.ts` implement a **deterministic phase machine**: `scope → semantic_grounding → query_planning → execution → validation → synthesis`, gated by boolean predicates, with sequential retries (`Q1 → Q2…`) when validation fails.

What is missing:

- **No search algorithms** — no MCTS, beam, best-first/A*, rollouts, or reward/value model. Path selection lives entirely in the LLM's forward pass.
- **No multi-hypothesis exploration** — the agent commits to one line of investigation and revises it in place. It never spins up competing approaches and ranks them. (Branching exists but is *user-initiated*: `session-branching.ts`.)
- **No controlled experiments** — the verifier (`result-verifier.ts`, `sql-semantic-validator.ts`) is a pass/fail **gate**, not a heuristic used to score and select among candidates.

Cheapest first step to close it: sample N query plans and rank them with the existing verifier before committing.

## 3. Evaluation & reliability lab

- **One benchmark only** — `services/datalink/evaluate/bird` (BIRD NL2SQL).
- **Wrong layer** — it scores the DataLink retrieval service, not the core agent runtime.
- **No suite** — nothing for tool-use, end-to-end tasks, or retrieval across the product.
- **No regression gates** — not wired into CI; no failure-forensics harness. The ~50 `scripts/smoke-*.mjs` are integration smoke checks, not evals.
- We can evaluate on KramaBench to validate the effectiveness in dealing with unstructured data. Now done: `eval/kramabench/` runs all six domains end to end, with per-task failure causes in `notes/kramabench-failure-analysis.md` and `notes/figures/kramabench-failure-causes.png`. A DA-Code adapter (`eval/dacode/`) exists for file-deliverable tasks.

## 4. Enterprise control plane

Auth exists (`apps/api/src/auth/`: password login, sessions, email verification, CSRF). The control-plane layer does not:

- **No RBAC** — `WorkspaceMembershipRecord.role` is only `owner`; workspace `kind` only `personal`.
- **No approvals** workflow.
- **No audit export** (SQL audit is persisted internally, but not exportable through a governed path).
- **No policy-as-code**.
- **No cost limits** (context budgeting exists; spend/quota governance does not).

## 5. Table discovery over a lake (fragmentation)

Observed while running KramaBench (`notes/kramabench-failure-analysis.md`). Two different problems both present as "too many tables".

**Physical fragmentation — one logical table split across many files.** A lake arrives as shards: astronomy is 715 `swarma-*` files and 715 `omni2-*` files that are one time series each, chopped by date; legal has 104 `State_MSA_*` files, one per state; environment has 22 `water-body-testing-<year>` files. One table per file gives 1,538 tables for astronomy. Answering "average density in 2015" then means querying hundreds of shard tables one at a time — a run did 40 of them and hit the 30-minute cap before reaching any analysis.

This part is mechanical: same directory + same name pattern modulo dates/ids + identical column signature → one table with a `source_file` column. It is the easy end of *table union search* (SANTOS, Starmie); no embeddings needed while the schemas match exactly. Grouping takes astronomy to 66 tables and legal to ~30.

**Discovery — which tables are relevant.** `inspect_schema` shows the first N tables alphabetically (`schemaMaxTables`, default 20, then a character budget). Legal has 131 tables; the state-level tables sat in the hidden 111, and five tasks were answered "the dataset contains no state-level data" while the omission note naming those very tables sat in the result the model received. Raising the cap is a stopgap: at 1,538 tables no cap works.

The literature's pattern is a funnel — table-first filtering, vector similarity, LLM re-rank (schema linking / table retrieval). What is missing here is any ranking at all, plus a `search_tables` affordance so the agent can look past what it was shown instead of concluding the data does not exist.

Net: fragmentation is an ingestion-shape problem with a deterministic fix; discovery is a retrieval problem the product does not attempt.

## 6. Grain & population (the denominator problem)

The single largest cause of wrong answers in the KramaBench runs: 10 of 48 shortfalls, more than any other, and more than three times the planning failures.

The pattern is always the same — every query runs, every number is internally consistent, and the SQL is correct for what the agent thought the question meant. What is wrong is **which rows were counted, and what one row represents**:

- **Grain across tables.** "More fires in Democratic or Republican states?" — an incident-level table covering 11 western states says Democratic; the state-level table covering 50 says Republican. The agent ran both, called the second a cross-check, and answered from the first.
- **Grain inside one table.** Summing a column that interleaves theft-type totals with their subtype rows double counts the denominator (1,423,380 instead of 1,135,291).
- **Universe at a fixed grain.** "Fraud reporters who lost $1–$500" divides by reports *with a loss*, not all reports. "Samples analyzed in the study" means `Case_excluded == 'No'`. Both denominators sit in the same table; nothing in the contract says which one the question meant.
- **Entity key.** `Wollaston @ Sachem St` and `Wollaston @ Rice Rd` are one beach; grouping by the raw string turns 60 safe beaches into 74.

Nothing in the runtime declares or checks any of this. The grounded analysis contract carries requirements and assertions (source tables, dimensions, SQL constraints) but never a unit of analysis, a population, or an entity key. D-Trail is no better: its `output_contract` is only `{required_fields: [...]}`, and the words grain, population and universe do not appear in its source. Its verification answers "did we execute the plan we committed to", not "was this the right population".

Three checks would cover every case above, and all three are cheap `COUNT` / `COUNT(DISTINCT)` probes:

1. **Declare the grain** per output node and verify `COUNT(*) = COUNT(DISTINCT grain key)` — this also catches join fan-out.
2. **Declare numerator and denominator universes separately** on ratio requirements, and verify the numerator's filter restricts the denominator's.
3. **Cross-source agreement**: when two grounded tables can supply the same quantity, compute both and treat disagreement as a finding rather than a footnote.

A caveat from the ambiguity literature (AMBROSIA, AmbiQT, AmbiSQL): several of these questions have more than one defensible reading, and execution-based benchmarks score only one. The realistic goal is therefore not "always pick the gold reading" but **enumerate the candidate populations, choose by a stated default, and record the alternative in the claim** — which also makes the disagreement visible instead of silent.

Net: this is the grounding work that has to land before plan search is worth much. A planner consumes the grounded task; if the population is wrong, the plan is confidently wrong.

## 7. Memory & Governance

Long-term memory is stored as untyped text, and there are no state-level operators. `DataTask IR` acts as a record but is per-run only so it gets deleted after the task finishes. Because of this it doesn't contribute to governance.

The `IR` represents the interpretation of the task, so it decides a contract that the agent must obey. By storing it instead of getting rid of it, it can be used to derive relations in the enterprise data and help construct/evolve the grounding layer.

The only governed evolving state which is recorded belongs to the agent's own execution, it does not record the evolving state of organizational knowledge.

From the GEMS proposal, the goal is to be able to derive the current state of organizational knowledge from reading the governed log.
<!-- 
## Priority read

Item 4 is the highest-leverage gap: the loop scaffolding is already there, so adding real search is additive rather than a rewrite. Item 3 is the strategic differentiator (a durable semantic layer is the moat). Items 5 and 6 are table-stakes for enterprise adoption but are greenfield builds. -->
