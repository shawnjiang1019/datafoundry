# Claude Code + the notes service

Claude Code answers KramaBench data questions with the grounding notes: it grounds the question,
queries through the notes, and cannot finish until `check_answer` approves the query its answer
came from.

| Piece | File | Role |
|---|---|---|
| MCP server | `.mcp.json` | starts `notes-mcp` on the `wildfire` and `biomedical` data |
| Skill | `.claude/skills/grounding/SKILL.md` | tells Claude the order: `ground`, `run_sql` with `notes_id`, `check_answer` |
| Stop hook | `.claude/hooks/require-check.mjs` (wired in `.claude/settings.json`) | blocks finishing until `check_answer` said ok after the last query |

## Run it

1. Build the repo (`npm run build` at the root), so `../../dist/server.js` exists.
2. Copy the data the KramaBench eval builds into `data/` (not committed):
   `wildfire.duckdb` and `biomedical.duckdb` from the eval's `system_scratch/DataFoundrySUT/`.
   The service opens them read-only.
3. Open this folder in Claude Code and accept the trust prompt once (until then Claude Code ignores
   the folder's permissions; hooks and the skill still load).
4. Ask: *What is the average age of patients with serous tumor samples analyzed in the study?*

## What to expect (dry run, 2026-11-03)

Without the notes, Claude answered 68.08: it noticed the `Case_excluded` column, named 68.5 as an
alternative, and kept 68.08. With this folder:

```
ground                    -> notes_id
run_sql x5                -> explores, averages every serous patient
check_answer (68.08)      -> challenge EXCLUSION_FLAG_IGNORED: 9 of 153 rows are marked by Case_excluded
run_sql x2                -> "analyzed in the study": leaves the excluded cases out
check_answer (68.5)       -> ok
FINAL_ANSWER: 68.5        (correct)
```

If Claude tries to finish without checking, the Stop hook sends it back (at most twice per session).
An explicit instruction from you to skip the check outranks the hook.
