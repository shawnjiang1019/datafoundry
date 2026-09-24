# Population, grain and entity key: KramaBench examples

This is the largest failure class in the KramaBench run: 13 tasks, 12.25 of the 42.4 missing points. It holds three related mistakes. In each one the SQL runs, the arithmetic is right, and the agent validates its own work and commits with confidence. The answer is still wrong, because one row, one entity or the included set was defined wrong before the query ran.

| | the question it gets wrong | typical sign in the answer |
|---|---|---|
| **Grain** | What is one observation? | Off in kind or units |
| **Entity key** | When are two rows the same thing? | A count a few too high or a few too low |
| **Population** | Which things are included? | A ratio or average off by roughly the share included or excluded |

Sections 1–3 give an example of each. Section 4 is the procedure for telling them apart, and section 5 rates how solid each diagnosis is.

---

## 1. Population: the wrong set of rows

The unit is right and the entities are identified correctly, but the set being counted or divided by is not the one the question means.

### `legal-easy-19`: reproduced

> What is the proportion of fraud reporters who lost between $1–$500 in 2024?

**Expected** 0.523. **Got** 0.199.

The numerator was right. The agent summed the five loss bands from $1 to $500 and got 516,308 reports.

The denominator was every fraud reporter, 2,600,678. That includes 1,613,158 people who reported no loss at all. "Reporters who lost between $1 and $500" is a share of the reporters who lost money, not of everyone who filed.

**Check:**
```
2,600,678 − 1,613,158 = 987,520 reporters who lost money
516,308 / 987,520     = 0.5228  →  0.523  ✓
```

### `legal-hard-18`: reproduced

> If the 2007 reports were distributed exactly like the 2024 ones, how many identity theft reports in 2007 would concern people ages 40 or older?

**Expected** 91,000. **Got** 126,000.

The agent started from 2007's *actual* identity theft count (259,314) and applied 2024's age mix (48.6% aged 40+). It deliberately set the full 2007 total aside, writing: *"I deliberately did not use the 1,070,447 figure."*

The question asks for *all* 2007 reports to be distributed like 2024's, by report type and then by age. That puts the full 2007 total in the base.

**Check:**
```
1,070,447   all 2007 reports                         (Report_Count.csv)
  × 17.5%   2024 identity theft share, 1,135,291 / 6,471,708 (Report_Type.csv)
  × 48.6%   2024 share aged 40+
= 91,275  →  91,000  ✓
```

The sister task `legal-hard-17` computes its expected answer the same way (1,070,447 × 3.04% = 32,542). That confirms this is the benchmark's convention and not a lucky match.

### Likely population errors, not yet confirmed

- **`biomedical-easy-2`, `biomedical-hard-1`, `biomedical-hard-5`.** All three questions say "in the study", and the clinical table has a case-exclusion flag. In `easy-2` the agent kept a flagged sample, arguing it "was still analyzed". If the reference drops flagged cases, all three answers move. This is untested, but one check would settle all three.
- **`archeology-hard-9`.** Dropped 19 cities whose rank was "-". A different correlation method (Pearson vs Spearman) would explain the gap equally well.
- **`wildfire-hard-17`.** Averaged the elevation of every station in the RAWS registry, where the question asks about the stations used by the NOAA fire dataset. This is inferred from the size of the gap; the agent's summary cut off before showing whether it filtered.

---

## 2. Entity key: the wrong rule for "same thing"

The unit is right, but rows were collapsed or split on something that isn't a real identifier. The direction of the error shows which way the key failed:

- **Too many** means one entity was split into several: spelling variants, or one record counted once per category.
- **Too few** means different entities were merged: two things that share a name.

### `legal-hard-22`: reproduced (split)

> What is the proportion of all reports who reported identity theft with Bank Account (theft type) and New Accounts (subtype)?

**Expected** 0.0555. **Got** 0.0442.

The agent divided by 1,423,380, the sum over every type/subtype row. One report can list several theft types, so that table has more rows than there are reports. The unit was supposed to be a report, and the agent counted report-and-type pairs.

**Check:**
```
distinct identity theft reports = 1,135,291   (Report_Type.csv)
62,982 / 1,135,291 = 0.05548  →  0.0555  ✓
```

### `environment-hard-16`: split, direction fits

> How many marine beaches (2002–2023) remained safe for the entire time? If there is no data for a beach in a particular year, assume it was safe.

**Expected** 60. **Got** 74.

The agent keyed beaches on `Beach Name` alone across 22 yearly files, which gave 672 distinct names. Suppose the same beach appears under a slightly different name in some years. That variant has no violations in the other years, and the rule "assume safe if missing" means nothing disqualifies it, so it gets counted as a separate safe beach. That inflates the count, and 74 > 60 is the direction you'd expect. Not reproduced.

### `environment-easy-3`: merge, by analogy

> How many beaches had a higher bacterial exceedance rate in 2013 than in 2012?

**Expected** 268. **Got** 267.

This task uses the same name-only key, but the error goes the other way. Two different beaches in different towns that share a name get merged into one, which loses a beach, so 267 < 268 fits. It was filed by analogy with `hard-16` and has not been checked.

Taken together, the two environment tasks show that one bad key can fail in both directions. It splits one beach with several names, and it merges several beaches with one name.

### `archeology-easy-8`: split

> How many unique sources were used in the Roman cities dataset?

**Expected** 52. **Got** 55.

The agent split the bibliography field on `;` and normalized only trailing periods (trace step 13: `TRIM(src, ' .')`). Its own audit at step 24 then listed five tokens that aren't distinct sources: `DGRG?`, `PECS?`, `PEC` (a typo of PECS), `Sear 2006PECS` (two sources with no semicolon between them) and an orphan year `1995`. At step 25 it counted them anyway, *"distinct strings as recorded"*. Merging the three spelling variants gives exactly 52, but 10 different combinations of three fixes from the five also reach 52, so the reference's exact rule isn't recoverable. The error is identified, but not uniquely reproduced.

---

## 3. Grain: the wrong unit of observation

The question counts one kind of thing, such as years or days, while one table row is a different kind of thing, such as a sample step or an incident. Another form of the same mistake is combining quantities from different levels.

### `wildfire-easy-9`: units mismatch

> How many more or fewer fatalities occurred on days with humidity below 30%, compared to the average?

**Expected** −0.0059. **Got** 25.9818.

The agent subtracted a per-record average from a raw total: 26 fatalities − 0.018 fatalities per record. Those are different quantities, so the result is wrong whatever the reference does, which is why the answer is off by three orders of magnitude.

**Check:**
```
low-humidity rate   26 / 2,018  = 0.0129 per record
overall rate       121 / 6,658  = 0.0182 per record
difference                      = −0.0053   (expected −0.0059)
```

Comparing per-fire rates gets −0.0053. The rest of the gap is the humidity boundary: the reference counts fires at exactly 30% (27 deaths across 2,201 fires), which gives −0.0059 exactly. A per-day grain gives −0.0240 and is ruled out. Full walkthrough: [`example-grain-wildfire-easy-9.md`](example-grain-wildfire-easy-9.md).

### `archeology-hard-2`: sample step treated as a year

> Across the years, what percent of years was the wet-dry index increasing?

**Expected** 38.42%. **Got** 50.25%.

The agent compared 5,993 consecutive values spaced 0.5 thousand years apart (4–3000 ky) and counted how often each was higher than the one before. That measures the percent of *samples* that increased, which is a different quantity from the percent of *years*.

**Caveat:** the column the agent used was `Age_ky.3`. The `.3` suffix means the sheet has several `Age_ky` columns, one per measurement, so the agent may also have paired the index with the wrong age column. Not reproduced.

---

## 4. How the three are told apart

Ask three questions in order and stop at the first one that fails:

1. **Is one row the unit the question is about?** Compare the noun in the question ("years", "days", "patients") with what one row of the table actually is. If they differ, it's **grain**.
2. **Are two rows the same thing when they should be?** Look at what the agent grouped or deduplicated on. If it isn't a real identifier (a name, a free-text string, a row per record *and* category), it's **entity key**.
3. **Is the included set the one the question means?** Look for inclusion and exclusion decisions and at what the denominator contains. Phrases like "of all…", "among those who…" and "in the study" point here. If the set is wrong, it's **population**.

**Confirming a diagnosis:** change only the suspected decision and recompute. That means a different denominator for population, a different distinct rule for entity key, or re-aggregating to the question's unit for grain. If the expected answer comes out, the diagnosis is confirmed.

**Caveat:** the three often come together. A wrong key changes the population, and a wrong grain changes what counts as a duplicate. Each task is filed under the first question that fails. When the agent's summary didn't show enough to tell which decision went wrong, I filed it under the likeliest one.

---

## 5. How solid each diagnosis is

| task | sub-type | evidence |
|---|---|---|
| `legal-easy-19` | population | **reproduced exactly** |
| `legal-hard-18` | population | **reproduced exactly** |
| `legal-hard-22` | entity key | **reproduced exactly** |
| `environment-hard-16` | entity key | error visible in the summary, direction fits |
| `archeology-easy-8` | entity key | pinpointed in the trace (steps 13, 24, 25); 52 reachable, but not by a unique fix |
| `wildfire-easy-9` | grain | **reproduced exactly** (with the reference's ≤ 30 boundary) |
| `archeology-hard-2` | grain | error visible in the summary; competing explanation |
| `environment-easy-3` | entity key | by analogy only |
| `biomedical-easy-2` | population | hypothesis |
| `biomedical-hard-1` | population | hypothesis |
| `biomedical-hard-5` | population | hypothesis |
| `archeology-hard-9` | population | hypothesis; competing explanation |
| `wildfire-hard-17` | population | inferred from the size of the gap |

4 reproduced, 3 with the error visible in the agent's own summary, 6 hypotheses. Each sub-type has one reproduced, step-by-step walkthrough: [population](example-population-legal-easy-19.md), [entity key](example-entity-key-legal-hard-22.md), [grain](example-grain-wildfire-easy-9.md). The hypotheses cluster in biomedical, and a single check on the case-exclusion flag would confirm or rule out three of them.

---

## 6. What would have prevented these errors

In every task above the agent decided the unit, the key and the population for itself, and then validated its answer against its own decisions. Nothing outside the agent stated what those choices should be. An output contract written before any SQL runs would make each one an explicit field, checked against the question:

| field | prevents | example |
|---|---|---|
| **unit of analysis** | grain | one row = one year; one row = one report |
| **entity key and its normalization** | entity key | a beach is identified by name *and* town, with spelling variants normalized |
| **population and denominator** | population | reporters who lost money, not all reporters; all 2007 reports, not only identity theft |

This is the argument for the planning module's grounded output contract. Grain and entity key are not caught by checking the SQL. They are only caught if something outside the agent's own reasoning says what the answer is supposed to be about.
