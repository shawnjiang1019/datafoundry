# KramaBench failure analysis

Per-question failure causes from running KramaBench against DataFoundry, with the evidence for each. The point is to separate failures that better planning would fix from failures that better grounding, ingestion, or runtime hygiene would fix.

## Scope and provenance

| | |
| --- | --- |
| Domains | legal (30), wildfire (21), biomedical (9) on the pre-fix build; archeology (12), environment (20), astronomy (12) on the post-fix build |
| Model | `glm-5.3-flash` via z.ai, one model profile throughout |
| Score rule | First complete pass per domain. legal/wildfire/biomedical scored 34.93/60 (58.2%) |
| Evidence | Run transcripts in `apps/api/storage/metadata/workbench.sqlite` (`run_events`, `sql_audit_logs`, `protocol_event_journal`); answers in `KramaBench/results/DataFoundrySUT/response_cache/tasks/` |
| Reference | "Reference" below means the `subtasks` pipeline KramaBench ships with each task, which is the authors' own solution |

Two builds are involved, so scores are not comparable across the line: the later build fixed a DuckDB connection bug (41% → 6% SQL failure), stopped blocking `REPLACE()`, and raised the visible-table cap from 20 to 200.

| Domain | Score | Build | Note |
| --- | --- | --- | --- |
| legal | 17 / 30 (56.7%) | pre-fix | 111 of 131 tables hidden by the 20-table cap |
| wildfire | 12.93 / 21 (61.6%) | pre-fix | |
| biomedical | 5 / 9 (55.6%) | pre-fix | |
| archeology | 6 / 12 (50.0%) | post-fix | Climate workbook header lost at ingest (since fixed) |
| environment | **17.67 / 20 (88.3%)** | post-fix | Beach datasheets still mis-ingested in this run |
| astronomy | 2 / 8 (25.0%) of tasks that ran | post-fix | 4 of 12 excluded: the model endpoint was unreachable (`Cannot connect to API: getaddrinfo`). Over all 12 it is 16.7% |

environment is the cleanest signal so far: 17 exact answers, one partial, two wrong, no run loops, and 0–2 SQL failures per run.

## 1. Population and grain

The largest class of analysis errors. Every query ran, every number was internally consistent, and the SQL was correct for what the agent thought the question meant. What was wrong was **which rows were counted, and what one row represents**.

Two distinct traps:

- **Grain** — the unit of analysis. One row per incident, per state, per report, per sample.
- **Universe** — the population at a fixed grain. All reports, or only reports with a loss; all cases, or only non-excluded ones.

### wildfire-hard-10 — two tables, two units, opposite answers

> By count, are there more fires in Democratic or Republican states?

**Expected** `Republican` · **Got** `Democratic` · run `run-818c6b22`

The agent counted rows in `Fire_Weather_Data_2002_2014_2016`, an incident-level table covering 11 western states: 4,285 Democratic vs 2,251 Republican. The reference sums the `Total Fires` column of `wildfire_total_fires_p45_54`, a state-level table covering 50 states: 29,115 vs 35,782.

The agent **ran the reference's query too** and reported its result — 29,115 vs 35,782, matching the reference exactly — then labelled it a "cross-check", called the incident table "the correct grain for counting individual fires", and answered from it.

**Cause.** Grain choice. The finer table is not a superset: its 11 states skew Democratic, so aggregating up does not reproduce the national picture.

**Would be caught by.** Treating disagreement between two sources for the same quantity as a finding rather than a footnote.

### legal-easy-19 — same table, two denominators

> What is the proportion (round to 3 decimal places) of fraud reporters who lost between $1-$500 in 2024?

**Expected** `0.523` · **Got** `0.199` · run `run-b6c5fd99`

Numerator agreed: 516,308 reports in the $1–$500 buckets. The agent divided by `Number of Fraud Reports` = 2,600,678 (everyone, including the 1,613,158 who reported no loss). The reference divides by the `Reports with $ Loss` scalar (987,520): 516,308 / 987,520 = 0.5228 → 0.523.

**Cause.** Universe. Both denominators sit in the same table, and "fraud reporters who lost between $1 and $500" is a subset of those who lost anything.

**Would be caught by.** Declaring numerator and denominator populations separately in the contract, then checking that the numerator's filter is a restriction of the denominator's.

### legal-hard-22 — hierarchical rows summed with their children

> What is the proportion (round to 4 decimal places) of all reports who reported identity theft with Back Account (Theft Type) and New Accounts (Theft Subtype)?

**Expected** `0.0555` · **Got** `0.0442` · run `run-45537b8a`

Numerator agreed: 62,982. The agent built the denominator by summing every numeric row of `2024_CSN_Identity_Theft_Reports_by_Type`, giving 1,423,380 — which double counts, because the table interleaves theft-type totals with their subtype breakdowns in one column. 62,982 / 1,135,291 (the real identity-theft total) = 0.0555.

**Cause.** Grain confusion inside a single table: parent and child rows share a column, so `SUM()` counts each report twice.

**Would be caught by.** A grain assertion on the scan: one row per subtype, with subtotal rows excluded. Also by a reconciliation check against the reported identity-theft total.

### legal-hard-18 — counterfactual base

> If the 2007 reports were distributed exactly like the 2024 ones, how many identity theft reports in 2007 would concern people ages 40 or older (rounded to the nearest thousand)?

**Expected** `91000` · **Got** `126000` · run `run-b5684398`

The reference applies the 2024 distribution twice: 2007 total reports (1,070,447) × 2024 identity-theft share (0.1754) × 2024 share of identity-theft reports aged 40+ (0.4861) ≈ 91,000. The agent used the **actual** 2007 identity-theft count (259,314) × 0.4861 ≈ 126,000.

**Cause.** Universe, under a counterfactual. "Distributed exactly like 2024" means the 2007 identity-theft count is itself derived from the 2024 share, not read from the data. The agent's reading is defensible; the question is ambiguous.

**Would be caught by.** Making the counterfactual base explicit in the grounded contract ("base = total 2007 reports × 2024 category share") and requiring the agent to state which quantities are observed and which are derived.

### biomedical-easy-2 — an exclusion flag defines the study population

> What is the average age of patients with serous tumor samples analyzed in the study?

**Expected** `68.5` · **Got** `68.08` · run `run-090c4e32`

The reference filters `Case_excluded == 'No'` and `Histologic_type == 'Serous'`, leaving 12 ages with mean 68.5. The agent kept the excluded case, computing 68.08 over 13 patients. Its own final message says: *"excluding `Case_excluded` rows would give 68.5, but the standard analysis set includes it"* — it computed the right answer and rejected it.

**Cause.** Universe. "Analyzed in the study" is a convention encoded in a column, not a filter stated in the question.

**Would be caught by.** Grounding exclusion flags as part of the population when a table has one, and surfacing the alternative population as a candidate rather than a discarded note.

### biomedical-hard-5 — wrong source table and population

> What is the median number of variants per Mbp for the serous tumor samples in the study? Round the result to 4 decimal places.

**Expected** `2.6563` · **Got** `2.4241` · run `run-716d63a2`

The reference reads `Log2_variant_per_Mbp` from the **mmc7 `B-APM subtypes` sheet**, restricted to serous cases with `Case_excluded == 'No'`, converts with `2 ** value` and takes the median. The agent read the same-named column from **mmc1** over 13 serous samples without the exclusion filter.

**Cause.** Two tables carry a column of the same name for overlapping but different sample sets. Universe plus source selection.

**Would be caught by.** Recording which table a column was bound to, and flagging when a column name is ambiguous across tables.

### biomedical-hard-1 — cohort definition

> What is the Spearman correlation between the abundance of the protein PLK1 and the abundance of CHEK2-S163 in tumor samples? Exclude samples not in the study and with missing values.

**Expected** `0.4765` · **Got** `0.5616` · run `run-87a8492d`

The reference defines the cohort as `Case_excluded == 'No'` and `Histologic_type` in (Endometrioid, Serous). The agent used all 104 samples flagged `Tumor`, then dropped missing values pairwise, ending with 28 pairs.

**Cause.** Universe. "Samples not in the study" is the same exclusion convention as easy-2, and the question even says so.

### wildfire-hard-17 — population defined by use, not by status

> What is the average elevation (in feet) of the weather stations used for fire site monitoring in the NOAA dataset?

**Expected** `4830.9` · **Got** `3188.9141` · run `run-ebf9c64b`

The reference takes the station IDs that appear in the fire records (`station_verified_in_psa`), matches them to the station registry on `NWS ID` (759 stations), and averages their elevation. The agent started correctly from `station_verified_in_psa` but tried `Station ID`, `WX ID`, `NESS ID` and `MesoWest Station ID` — all zero matches — never tried `NWS ID`, then substituted "all active stations" (2,352) as the population.

**Cause.** Universe, reached through an incomplete key search. See also §6: the proximate failure is stopping a search early and silently changing the population.

**Would be caught by.** Treating a zero-row join as an error that forces a replan, never a silent switch of population.

### archeology-hard-5 — a key that collapses rows

> In the Maltese dataset, find the year of the most northern Neolithic sample … What is the maximum aluminum value recorded in the climate dataset in the closest year to that year? If there are multiple closest years, take the max aluminum value measured across all of them.

**Expected** `66158.3691` · **Got** `36828.7165` · run `run-bde869c5`

The reference derives the climate year as `1950 − round(Age_ky.1) × 1000`, which makes many rows share a year, then takes the maximum `Al` across **all rows of the closest year**. The agent used unrounded `Age_ky`, so every row had a distinct year, found exactly one closest row, and reported its `Al`.

**Cause.** Grain. The rounding defines the key, and the question's "if there are multiple closest years" is the hint that the key is expected to collapse rows.

**Would be caught by.** Declaring the join/match key and its granularity, then checking whether the match produced one row or a set.

### environment-hard-16 — the entity key was not normalized

> How many marine beaches (from 2002 to 2023 inclusive) remained safe to swimming for the entire time (i.e., no violation at all throughout the seasons; if no data for a beach in a particular year, assume safe)?

**Expected** `60` · **Got** `74` · run `run-2d736bd2`

The reference normalizes `Beach Name` by splitting on `@` and keeping the part before it, so `Wollaston @ Sachem St` and `Wollaston @ Rice Rd` are the same beach. The agent grouped by the raw string, counted 672 distinct marine beach names, and found 74 with no violation. Under the normalized key a beach is disqualified if **any** of its sampling points ever violated, giving 60.

The agent did validate its partition (74 safe + 598 violating = 672 total, no name appearing as both Marine and Fresh), so the arithmetic was sound on the wrong key.

**Cause.** Grain: the unit of analysis is a beach, but the key used was a sampling-point label. A finer key splits one entity into several and changes the answer.

**Would be caught by.** Declaring the entity key in the contract, then probing for near-duplicate keys (shared prefix before a separator, differing suffixes) before grouping.

### Summary of this class

| Task | Sub-type | Expected | Got |
| --- | --- | --- | --- |
| wildfire-hard-10 | Grain across tables | Republican | Democratic |
| legal-easy-19 | Universe (denominator) | 0.523 | 0.199 |
| legal-hard-22 | Grain inside one table | 0.0555 | 0.0442 |
| legal-hard-18 | Universe (counterfactual base) | 91000 | 126000 |
| biomedical-easy-2 | Universe (exclusion flag) | 68.5 | 68.08 |
| biomedical-hard-5 | Universe + source table | 2.6563 | 2.4241 |
| biomedical-hard-1 | Universe (cohort) | 0.4765 | 0.5616 |
| wildfire-hard-17 | Universe (defined by use) | 4830.9 | 3188.9141 |
| archeology-hard-5 | Grain (collapsing key) | 66158.3691 | 36828.7165 |
| environment-hard-16 | Grain (entity key not normalized) | 60 | 74 |

Ten tasks, about a third of all failures examined, and more than any other single cause.

**Three checks would cover all nine:**

1. **Declare the grain per output node** — what one row represents — and verify `COUNT(*) = COUNT(DISTINCT grain keys)`, which also catches join fan-out.
2. **Declare numerator and denominator universes separately** on ratio requirements, and verify that the numerator filter restricts the denominator filter.
3. **Cross-source agreement**: when two grounded tables can supply the same quantity, compute both and make a disagreement a finding, not a footnote.

None of these is in D-Trail today. Its `output_contract` is only `{required_fields: [...]}`, and the words grain, population and universe do not appear in its source. Its verification answers "did we execute the plan we committed to", not "was this the right population".

## 2. Other causes (to be expanded)

Recorded here so the counts stay honest; each needs the same per-question treatment as §1.

| Cause | Tasks | Note |
| --- | --- | --- |
| Column identity after bad ingestion | archeology-hard-1, hard-2 | `climateMeasurements.xlsx` has its header on row 5; the harness read row 0, so columns became `Unnamed: 7/11/21`. Fixed in the ingester (header detection) |
| Missing or unusable source data | wildfire-easy-2, easy-3, hard-19, hard-21, legal-hard-1 | `.gpkg` and HTML are not ingested; `ZHVI.csv` and `WeatherEvents_*.csv` are absent from the lake |
| Runtime and protocol defects | archeology-hard-1, hard-12, legal-hard-29, legal-easy-11 | Commit tool echoes its input so the agent cannot tell it succeeded (67 identical commits in one run); no paging strategy for truncated results; rejected actions repeated in a loop |
| Precision and convention | legal-hard-17 | Reference uses the published `Percentage` (0.0304); the agent computed the share (0.030443). 32,542 vs 32,587 |
| Measure definition | environment-hard-20 | "Most polluted" ranked by average `Indicator Level` (agent) vs violation rate (reference). Same city, same data, 2 of 3 beaches match |
| Reference self-inconsistency | environment-easy-3 | The reference groups by (beach, city code, community code) but joins the years on beach name alone, so a name under two codes is counted twice. 268 vs the agent's self-consistent 267 |
| Instruction following | archeology-hard-9 | The stated tie-break ("take the max rank") was replaced with "last in data order" |
| Output format | legal-hard-24, wildfire-hard-16, hard-18 | Right answer, wrong shape: missing suffix, unrounded values, list instead of a sentence |
| Planning | wildfire-easy-9, hard-10, hard-17 | Composition (subtracting a mean from a total), candidate selection, incomplete search |
| Benchmark inconsistency | archeology-easy-8 | The reference pipeline's own output is 55, the gold answer is 52 |

## 3. What this implies

- **Grounding beats planning on this evidence.** Roughly 16 of the failures are grounding, against 3 where better planning plausibly changes the answer. The planning three are all in wildfire, the domain with the deepest multi-source tasks.
- **Depth does not predict failure.** environment has the deepest tasks (median 8 reference steps, 85% multi-source) and the best score, because its sources are the same table repeated per year and its column names match the question's words. legal and biomedical are shallower and harder, because several tables can answer the same question at different grains.
- **Fix the runtime defects first.** They are cheap, and they cost whole tasks: one commit loop burned an entire step budget after the analysis was already complete.
