---
name: grounding
description: Answer questions about the data with the notes service. Use for any question answered with SQL on the "wildfire" or "biomedical" data sources.
---
# Grounded data answers

The `notes` MCP server checks your work against facts verified in the data. Follow this order.

1. **Ground first.** Call `ground` with the question and the data source. Keep the `notes_id` it returns.
   Read `verified_joins`: a key listed as ACCEPT is checked against the data; one listed as REJECT does not match.
2. **Query through the notes.** Run every query with `run_sql`, passing the `notes_id`. A join the data
   proved wrong is blocked, with the key to use instead. Look at real values before relying on them.
3. **Check before you answer.** When you have your answer, call `check_answer` with the `notes_id`, your
   answer, and `final_sql` (the one query your answer came from).
   - `ok`: give the answer.
   - `challenge`: the data disagrees with how you got the answer. Read the evidence, decide whether it
     applies to the question, recompute if it does, and call `check_answer` again.
4. End with one line: `FINAL_ANSWER: <answer>`.

You cannot finish before `check_answer` has approved your last query: a hook stops you.
