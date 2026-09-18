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
- We can evaluate on KramaBench to validate the effectiveness in dealing with unstructured data.

## 4. Enterprise control plane

Auth exists (`apps/api/src/auth/`: password login, sessions, email verification, CSRF). The control-plane layer does not:

- **No RBAC** — `WorkspaceMembershipRecord.role` is only `owner`; workspace `kind` only `personal`.
- **No approvals** workflow.
- **No audit export** (SQL audit is persisted internally, but not exportable through a governed path).
- **No policy-as-code**.
- **No cost limits** (context budgeting exists; spend/quota governance does not).

## 5. Memory & Governance

Long-term memory is stored as untyped text, and there are no state-level operators. `DataTask IR` acts as a record but is per-run only so it gets deleted after the task finishes. Because of this it doesn't contribute to governance.

The `IR` represents the interpretation of the task, so it decides a contract that the agent must obey. By storing it instead of getting rid of it, it can be used to derive relations in the enterprise data and help construct/evolve the grounding layer.

The only governed evolving state which is recorded belongs to the agent's own execution, it does not record the evolving state of organizational knowledge.

From the GEMS proposal, the goal is to be able to derive the current state of organizational knowledge from reading the governed log.
<!-- 
## Priority read

Item 4 is the highest-leverage gap: the loop scaffolding is already there, so adding real search is additive rather than a rewrite. Item 3 is the strategic differentiator (a durable semantic layer is the moat). Items 5 and 6 are table-stakes for enterprise adoption but are greenfield builds. -->
