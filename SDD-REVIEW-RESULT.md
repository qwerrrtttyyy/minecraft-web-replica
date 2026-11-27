# BIOME line review — Tasks 1–4 (90ccd6c..812c725)

Reviewer: task reviewer (parallel content round, BIOME line)
Scope: Tasks 1–4 only. Commits `4ab3cc0` → `ffa24e2` → `d766b39` → `812c725` (base `90ccd6c`).
Method: static review of `git diff -U10 90ccd6c..812c725` (773 lines), per-commit file scope,
brief, binding spec, and targeted source reads at HEAD. **No files edited; full test suite not re-run**
(implementer's report carries test evidence).

Inputs used:
- Implementer report: the original `/tmp/opencode/biome-report.md` (read in full before the tmp cleanup;
  `SDD-REPORT.md` was not present at review time, so its claims are cross-checked against git/diff).
- Review package: regenerated to `SDD-REVIEW.txt` via the prescribed git command (773 lines).
- Brief: `docs/superpowers/plans/2026-11-22-new-biomes-expansion.md`.
- Spec: `docs/superpowers/specs/2026-11-22-new-biomes-expansion-design.md`.

---

## Overall verdict

**Spec compliance: ✅ PASS** (all hard constraints and all precise config/table values are honored;
1 Important functional interaction caveat noted below).

**Findings: Critical 0 / Important 1 / Minor 2.** Nothing blocks merge of Tasks 1–4 on spec grounds.
The Important item is a pre-existing plugin rule that neutralizes 2 of the 22 mandated botany weights;
the implementer flagged it and was explicitly told not to change it, so it needs an owner/spec decision.

Per-commit scope is clean:

| Commit | Files touched | Within declared scope |
|---|---|---|
| `4ab3cc0` (T1) | `src/world/generator.ts`, `test/terrain-system-check.cjs` | ✅ |
| `ffa24e2` (T2) | `src/world/generator.ts`, `test/terrain-system-check.cjs` | ✅ |
| `d766b39` (T3) | `test/terrain-system-check.cjs` only (no source change) | ✅ |
| `812c725` (T4) | `src/plugins/builtin/botanyContent.ts`, `test/botany-rules-check.cjs` | ✅ |

---

## (a) Spec compliance — requirement-by-requirement mapping

| # | Requirement (global constraint / spec clause) | Verdict | Diff / source evidence |
|---|---|---|---|
| 1 | Append exactly 7 `BiomeId`s at END of union; total 18; existing 11 never reordered | ✅ | `src/world/generator.ts:20-25`: existing `ocean..cherry` lines byte-identical; added `\| 'jungle' \| 'snowy_tundra' \| 'mushroom_grove' \| 'bamboo_grove' \| 'dark_forest' \| 'birch_forest' \| 'snowy_taiga'` at line 24-25 — exact spec order (spec:59). Test `terrain-system-check.cjs:195-214` mirrors the 18-name order and asserts length 18. |
| 2 | ZERO new block ids / atlas tiles; every referenced name registered | ✅ | Diff touches no `blocks.ts`/`atlas.ts`/`trees.ts`. All 22 referenced new names (`bamboo`, `tall_fern`, `vine`, `fern`, `moss_carpet`, `snowdrop`, `edelweiss`, `snow_lily`, `red_mushroom`, `brown_mushroom`, `glow_moss`, `glow_fern`, `moonflower`, `glow_cordyceps`, `ivy`, `sugar_cane`, `tall_grass`, `azure_bluet`, `lily_of_the_valley`, `lingonberry_bush`, `oak`/`birch`/`spruce` species) verified present in `src/world/blocks.ts` at HEAD. `terrain-system-check.cjs` asserts every `plants`/`trees`/`flowerBeds.plants`/`cavePlants` name resolves via `reg.byNameGet` (report: GREEN). |
| 3 | 11 existing cascade predicate strings + relative order byte-identical | ✅ | `generator.ts:728-760` cascade. Test `terrain-system-check.cjs:272-289` lists all 11 exact substrings and asserts presence + monotonic index order. Spot-checked all 11 against the diff's context lines — no text change (e.g. `t < 0.3) biome = 'taiga'` at line 738, `m > 0.56) biome = 'forest'` at line 755, `else biome = 'plains'` at line 756). |
| 4 | 7 new rules inserted exactly where spec lists them | ✅ | `generator.ts:734-753`: snowy_tundra (:734), snowy_taiga (:736) before taiga; jungle (:745), bamboo_grove (:747), mushroom_grove (:749), dark_forest (:751), birch_forest (:752) before savanna (:754). Every predicate compared character-for-character with spec rules 5,6,11–15 (spec:83-93) — exact match, including `SEA_LEVEL + 12/16/20/24` offsets. Test asserts preemption positions (`terrain-system-check.cjs:292-315`). |
| 5 | Capture ledger documented | ✅ | `generator.ts:716-725` in-code table listing all 7 new rules, the dispossessed old biome, and reason — mirrors spec:98-109. Test checks ledger presence (`terrain-system-check.cjs:317-318`). |
| 6 | `TERRAIN_STAGES` unchanged; no DOM; no `Math.random` | ✅ | `TERRAIN_STAGES = ['columns','ores','trees','decorate']` appears as unchanged context; stage assertion exists (`terrain-system-check.cjs:252-256`). No `document`/`window` import and no `Math.random` anywhere in the 4-file diff. |
| 7 | Reachability seed 777; widen radius/seed only, never alter thresholds/cascade; record it | ✅ | Diff changes only sampling bounds: `terrain-system-check.cjs:323-331` (±112→±192, seed 777, test name records radius/seed) and R 7→12 for sections 3b/3c-2 (`:369`, `:450`). **Zero** changes to climate thresholds, jitter, or cascade conditions. No threshold weakening: performance assertion unchanged at `terrain-system-check.cjs:414` (`ms < 15000`, still 225 chunks — section 3's R was *not* widened). |
| 8 | Profile config values match spec table exactly | ✅ | `generator.ts:336-441`. Spot-checked all 7 × (surface/filler, 5 plants + weights, tree species + weights, treeDensity): jungle (:336-342, density :75), snowy_tundra (:344-357), mushroom_grove (:359-374), bamboo_grove (:376-384), dark_forest (:386-400), birch_forest (:402-410), snowy_taiga (:412-440) — all match spec:63-69. |
| 9 | FlowerBeds / cavePlants / caneChance additions per spec:71 | ✅ | snowy_tundra flowerBeds snowdrop/edelweiss/snow_lily (.5/.3/.2=1.0, :353-357); snowy_taiga flowerBeds snowdrop/lingonberry (.6/.4=1.0, :425-429); cavePlants in mushroom_grove/dark_forest/snowy_taiga use forest's exact 4-item table .37/.22/.15/.26=1.0 (:367-371, :395-399, :431-435), `caveChance: 0.06` = forest's value (:235); caneChance jungle .03 / bamboo .04 (:341, :383); all other clay/cactus 0. Spec left `chance`/`radius`/`caveChance` numerically free; implementer chose .1/r2 and .06 and documented it — acceptable. |
| 10 | Botany: only spawn weights for the 6 existing plants (159..164), no new ids/traits/rules | ✅ | `botanyContent.ts:52-135`: only `spawn` objects changed; `trait`, `id`, `nearWater`, `waterPlant`, `paint`, `lightEmission`, and `EXPANSION_RULES` unchanged in the diff. All **22** spec weights verified value-by-value, e.g. thistle (:58-61), cattail (:74-76), glow_mushroom (:88-91), frost_bloom (:105), ember_fern (:118-120), moonlotus (:133-135). Test asserts exact values, id sequence `159..164`, length 6 (`botany-rules-check.cjs:352-374`). Sums per new biome all < `SPAWN_ROLL_CEILING = 0.04` (max jungle .031). |
| 11 | Forbidden files untouched | ✅ | `git diff --stat` = 4 files only: `botanyContent.ts`, `generator.ts`, `botany-rules-check.cjs`, `terrain-system-check.cjs`. No `package.json`, `mesher.ts`, `meshTypes.ts`, `validate.py`, `EXPERIMENTS.md`, `CHANGELOG.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`. |
| 12 | Test updates are legitimate expansions, not watering down | ✅ | Domain widened only to biomes that the spec profiles actually configure (`fern` → jungle/dark_forest/birch_forest/snowy_taiga; `birch_log` → birch_forest/dark_forest; `spruce_log` → snowy_taiga; `podzol` → snowy_taiga; `sugar_cane` in bamboo_grove as plain surface plant; `glow_moss` dual cave/surface in mushroom_grove). All map 1:1 to spec profile entries; no assertion was deleted or loosened. |
| 13 | Pre-existing timing assertion not "fixed" | ✅ | Diff context at `terrain-system-check.cjs:414` keeps `ms < 15000` and R=7 for the perf section; report records baseline failure as environment-only. |
| 14 | Red→green discipline / evidence | ⚠️ Cannot verify from diff | Report documents RED/GREEN per task with exit codes, but the full suite was not re-run by this reviewer per instructions. To confirm: after `npm run test:snapshot`, run `node test/terrain-system-check.cjs` and `node test/botany-rules-check.cjs` and check the reported 100/54 assertion counts and exit codes; also check `.agent/evidence` / task-card outputs at Task 5. |

---

## (b) Task quality findings

### Critical — 0

No build-breaking or hard-constraint-violating defect found.

### Important — 1

**I1. `frost_bloom`'s two new snowy-biome spawn weights are nullified by a pre-existing decay rule.**
- Location: `src/plugins/builtin/botanyContent.ts:105` (new weights `snowy_tundra: 0.014, snowy_taiga: 0.008`) interacting with `src/plugins/builtin/botanyContent.ts:231-240` (`core:botany-expansion:frostline`: `const alpine = ctx.biome(...) === 'alpine'; if (alpine && nearSurface) return false; return ctx.write(..., 0, 'decay')`).
- Impact: the spec goal "`6 个既有插件植物在新群系里有合理 spawn 权重` / botany 在新群系连贯分布" is not achieved for this plant — it spawns in the two snowy biomes and is then decayed on its next random tick (`EXPANSION_RULES` are unchanged by this diff, so the behavior is fully active). Also produces avoidable spawn→decay block churn.
- Context: pre-existing rule, present before this line; the implementer explicitly flagged it ("pre-existing rule interaction I was explicitly told not to modify"). The diff itself is spec-compliant — this is an interaction the spec did not account for.
- Concrete fix (requires owner/spec sign-off because Task 4 was scoped to `spawn` only): extend the frostline habitat predicate at `:236` to treat snowy biomes as valid, e.g. `const habitat = ['alpine','snowy_tundra','snowy_taiga'].includes(ctx.biome(ctx.x, ctx.z)); if (habitat && nearSurface) return false;`, and add a regression in `test/botany-rules-check.cjs` asserting no decay for frost_bloom in `snowy_tundra`. Alternative: if the rule must stay, drop the two weights and amend the spec's botany table accordingly. Do **not** just weaken the decay rule's threshold.

### Minor — 2

**M1. Implementer report miscounts the new botany weights as 21; the spec/diff contain 22.**
- Location: report, Task 4 section ("21 new key/value pairs", "assertions for all 21 weights") vs `botanyContent.ts:52-135` and spec:124-129 (5+3+5+2+4+3 = 22). The test at `botany-rules-check.cjs:352-367` in fact covers all 22, so this is a report-only inaccuracy, not a code defect.
- Concrete fix: correct the count in the report / `SDD-REPORT.md` to 22 before it is used as handoff evidence.

**M2. Reachability resolution is recorded in the test name but not yet in the spec/N03 outputs.**
- Location: `test/terrain-system-check.cjs:323` records "seed 777 的 ±12 区块" — correct. Spec:116 asks for the actual radius/seed in "测试名与 spec"; plan Task 5 asks for N03.yaml outputs.
- Impact: tracking/audit gap only; no code behavior. Implementer says the N03 copy is pending Task 5.
- Concrete fix: in Task 5, write "seed 777, ±12 chunks (±192, step 4)" into `docs/agent/tasks/N03.yaml` outputs and add a one-line note to the spec's reachability section; keep validate.py unchanged (integration step handles CHECKS).

### Notes (not findings)

- New snowy flowerBeds use decimal weights summing to 1.0 (.5/.3/.2, .6/.4) while all pre-existing flowerBeds use integer relative weights (e.g. forest 3/2/2/2/2/1/1). Generation normalizes by `flowerBedTotal` (`generator.ts:618,1192-1197`), so both yield identical relative distributions — no behavioral difference. Spec:71's "≤1" wording is satisfied either way.
- The source-text predicate assertions (`terrain-system-check.cjs:272-318`) are intentionally brittle to reformatting of `generator.ts`; that is the intended cost of enforcing "byte-identical old predicates" without a separate golden file.

---

## ⚠️ Cannot verify from diff (and what would confirm)

1. **Actual test exit codes / assertion counts** (report claims 100 terrain-system, 54 botany, 61 mesher, plus snapshot/typecheck green). Confirm: `npm run test:snapshot && node test/terrain-system-check.cjs && node test/botany-rules-check.cjs && npm run test:mesher` on the target machine and check real exit codes.
2. **All 18 biomes truly reachable at seed 777 ±12** (report diagnostic: ±160 showed 16, ±192 showed all 18 with snowy_tundra=39 cells). Confirm: the assertion at `terrain-system-check.cjs:323-331` passing in the run above; optionally log the `seen` set.
3. **No new DOM dependency globally** — verified only that the diff adds none. Confirm: repo-wide grep for `document`/`window` under `src/world/` returns only the known export boundary (`src/app/export-json.ts`).
4. **`frost_bloom` decay in practice** — confirmed statically from `EXPANSION_RULES` at `botanyContent.ts:231-240`; a botany-rules regression that ticks a snowy-biome frost_bloom would confirm the churn quantitatively.
5. **Full `npm run verify` / browser smoke** — Task 5, out of scope; known environment has no Chromium (`test:smoke` failure expected and must be recorded, not fixed).
6. **Flaky timing assertion stability** — pre-existing `ms < 15000` at `terrain-system-check.cjs:414`; must not be weakened. Confirm by re-running on the slow machine and recording the real number.
