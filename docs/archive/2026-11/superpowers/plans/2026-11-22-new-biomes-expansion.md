# 11 → 18 群系扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `BIOME_PROFILES` 从 11 个群系扩到 18 个，复用现有方块做出可区分的生态，并让 botany 的 6 个插件植物在新群系连贯分布。

**Architecture:** 全部决策收在 `generator.ts` 一张配置表 + `base()` 一段有序级联里；botany 侧只在 `botanyContent.ts` 的 `spawn` map 加法。不新增方块 id、tile、植物、品系，不改生成阶段顺序。

**Tech Stack:** TypeScript 5.6 strict、three.js 0.170（仅渲染侧）、Node CJS 快照测试（`npm run test:snapshot`）、seed 派生的 Noise。

**Spec:** `docs/superpowers/specs/2026-11-22-new-biomes-expansion-design.md`
**任务卡:** `docs/agent/tasks/N01.yaml`、`N02.yaml`、`N03.yaml`

## Global Constraints

- 群系只在 `BiomeId` union **末尾追加** 7 项；既有 11 项顺序与全部谓词文本不变。
- 地形规则只写进 `BIOME_PROFILES`；`DEFAULT_TERRAIN.treeDensity` 补齐 7 个键。
- `TERRAIN_STAGES = ['columns','ores','trees','decorate']` 契约不变。
- **0 新方块 id / 0 新 tile**：profile 引用的每个方块名必须能在 `BlockRegistry` 解析。
- 生成层无 DOM；禁止 `Math.random`；所有随机走 seed 派生 Noise / rng。
- 不碰 mesher / worker / 存档 / 版本号；不新增运行时依赖。
- 先红后绿；`npm run test:snapshot` 必须先于任何 require 快照的测试。
- 本线不改 `EXPERIMENTS.md` / `CHANGELOG.md` / `validate.py`（合并集成步骤处理）。
- 交付证据记真实 exit code；本机浏览器步骤不可运行，按 spec 降级口径验收。

## Review Focus

- 某个新群系的 profile 引用了未注册方块（如写错 `edelweiss`）→ Task 1 的可解析断言遍历全部 18 个群系。
- 级联插入后旧群系被静默抢占 → Task 2 的"旧谓词逐条等价"测试 + spec 抢占台账。
- 新群系在 seed 777 ±7 区块不可达 → Task 3 的可达性断言；扩半径/加种子而非改阈值。
- `treeDensity` 缺键导致树群系不长树 → Task 1 的 treeDensity 键断言。
- 插件植物 spawn 权重总和越界或 id 被改动 → Task 4 的逐值断言 + id 上限断言。

---

### Task 1: 群系配置表与树密度（N01）

**Files:**
- Modify: `src/world/generator.ts:20-22`（`BiomeId`）、`:58-73`（`treeDensity`）、`:131-327`（`BIOME_PROFILES`）
- Test: `test/terrain-system-check.cjs:190-243`

**Interfaces:**
- Consumes: `BiomeProfile`（`generator.ts:86-129`）、`TreeSpecies`（`trees.ts:9`）。
- Produces: `BiomeId` 末尾 7 个新字面量；18 项 `BIOME_PROFILES`；`DEFAULT_TERRAIN.treeDensity` 7 个新键。配置内容逐值见 spec 的"群系清单"表。

- [ ] **Step 1: 写失败测试** — 在 `test/terrain-system-check.cjs` 把 `biomes` 数组（:190-191）从 11 项扩到 18 项，并把标题改为"全部 18 个群系"；新增断言：`['jungle','snowy_tundra','mushroom_grove','bamboo_grove','dark_forest','birch_forest','snowy_taiga'].every(b => !!BIOME_PROFILES[b])`；`['jungle','mushroom_grove','dark_forest','birch_forest','snowy_taiga'].every(b => DEFAULT_TERRAIN.treeDensity[b] > 0)`；`BIOME_PROFILES.snowy_tundra.surface === 'snow'`；`BIOME_PROFILES.bamboo_grove.plants.some(p => p.name === 'bamboo')`；`BIOME_PROFILES.birch_forest.trees.every(t => t.species === 'birch')`。此时源码未实现 → FAIL。
- [ ] **Step 2: 确认 RED** — Run: `npm run test:snapshot && node test/terrain-system-check.cjs`；Expected: FAIL，提示新群系 profile 不存在。
- [ ] **Step 3: 实现配置表** — 按 spec 表把 7 项追加进 `BiomeId` 与 `BIOME_PROFILES`；所有 `plants`/`trees`/`flowerBeds.plants`/`cavePlants` 名字必须已在 `blocks.ts` 注册；权重总和 ≤1；在 `DEFAULT_TERRAIN.treeDensity` 补 7 个键（雪原与竹林为 0，其余按 spec 值）。
- [ ] **Step 4: 确认 GREEN** — Run: `npm run typecheck && npm run test:snapshot && node test/terrain-system-check.cjs`；Expected: PASS，配置表断言全绿（可达性断言此时仍 FAIL，属预期，由 Task 3 修复）。
- [ ] **Step 5: Commit** — `git add src/world/generator.ts test/terrain-system-check.cjs && git commit -m "feat(biome): 新增 7 个群系配置与树密度（复用现有方块）"`。

### Task 2: 级联插入与旧域保护（N01）

**Files:**
- Modify: `src/world/generator.ts:597-632`（`base()` 级联）
- Test: `test/terrain-system-check.cjs`（新增断言组）

**Interfaces:**
- Consumes: Task 1 的 18 项 `BiomeId` / profile；`t`、`m`、`alt`、`height` 局部变量。
- Produces: 18 条有序级联；`biomeAt(x,z): BiomeId` 签名不变；spec 的抢占台账在代码注释中留一份。

- [ ] **Step 1: 写失败测试** — 在 `test/terrain-system-check.cjs` 新增断言组："旧 11 条谓词文本不变"：从 `generator.ts` 读源码，断言 11 条旧条件字符串逐条出现且相对顺序不变；"新规则顺序"：断言 `snowy_tundra` 出现在 `taiga` 之前、`dark_forest`/`birch_forest` 出现在 `forest` 之前。此时 FAIL。
- [ ] **Step 2: 确认 RED** — Run: `node test/terrain-system-check.cjs`；Expected: FAIL。
- [ ] **Step 3: 插入新规则** — 按 spec 的流程 5/6 与 11–15 插入 5+5 条 `else if`，条件逐字照抄；紧邻处写注释标明抢占对象（见 spec 台账）；旧 11 条一字不改。
- [ ] **Step 4: 确认 GREEN + 无回归** — Run: `npm run typecheck && npm run test:snapshot && node test/terrain-system-check.cjs && npm run test:mesher`；Expected: 断言组全 PASS（可达性仍可能 FAIL，留给 Task 3），`test:mesher` 61 项绿。
- [ ] **Step 5: Commit** — `git add src/world/generator.ts test/terrain-system-check.cjs && git commit -m "feat(biome): 在气候级联末尾追加 7 个群系判定并记录抢占"`。

### Task 3: 可达性与验收门（N01 / N03）

**Files:**
- Test: `test/terrain-system-check.cjs:244-252`
- Modify（仅当扩半径）: `test/terrain-system-check.cjs` 的循环边界与测试名

**Interfaces:**
- Consumes: Task 2 的 `DefaultGenerator(777, reg).biomeAt`。
- Produces: 18 群系可达断言；若需扩半径，实际半径/种子写入测试名与任务卡 N03 的 outputs。

- [ ] **Step 1: 写失败测试** — 把 `:244-252` 的断言集合从 `['mesa','swamp','savanna','cherry']` 改为全部 18 个群系名；测试名改为"seed 777 的 ±7 区块内 18 个群系都有地表实例"。Expected: FAIL（若已有新群系不可达）。
- [ ] **Step 2: 确认 RED** — Run: `node test/terrain-system-check.cjs`；Expected: FAIL 并指出缺失的群系名。
- [ ] **Step 3: 处理不可达** — 仅当 FAIL 时：先把采样半径从 ±112 扩到 ±192（±12 区块），仍不足再加 seed 2026/1234 的第二个循环；**禁止改气候阈值或级联条件**；在测试名里写明实际半径/种子。
- [ ] **Step 4: 确认 GREEN** — Run: `npm run test:snapshot && node test/terrain-system-check.cjs && npm run test:mesher && npm run test:mobile`；Expected: 全 PASS。
- [ ] **Step 5: Commit** — `git add test/terrain-system-check.cjs && git commit -m "test(biome): 18 群系可达性断言与必要的采样半径扩展"`。

### Task 4: botany 生态联动（N02）

**Files:**
- Modify: `src/plugins/builtin/botanyContent.ts:50-128`（各植物 `spawn` map）
- Test: `test/botany-rules-check.cjs`

**Interfaces:**
- Consumes: Task 1 的 7 个新 `BiomeId`；`ExpansionPlant.spawn: Partial<Record<BiomeId, number>>`。
- Produces: 6 个植物在新群系的 spawn 权重（逐值见 spec 表）；`EXPANSION_PLANTS.length === 6`、id 上限仍 164。

- [ ] **Step 1: 写失败测试** — 在 `test/botany-rules-check.cjs` 新增断言：按 spec 表逐项断言 `EXPANSION_PLANTS.find(p => p.name === ...).spawn[biome] === weight`；断言 `EXPANSION_PLANTS.every(p => p.id <= 164)` 且 `length === 6`。Expected: FAIL。
- [ ] **Step 2: 确认 RED** — Run: `npm run test:snapshot && node test/botany-rules-check.cjs`；Expected: FAIL。
- [ ] **Step 3: 补权重** — 只在 6 个 `spawn` 对象里追加 spec 表中的键/值；不改 `trait`、`id`、`nearWater`、`waterPlant`、`EXPANSION_RULES`。
- [ ] **Step 4: 确认 GREEN + 无回归** — Run: `npm run typecheck && npm run test:snapshot && node test/botany-rules-check.cjs && npm run test:botany && npm run test:plant-energy && npm run test:crossbreed`；Expected: 全 PASS。
- [ ] **Step 5: Commit** — `git add src/plugins/builtin/botanyContent.ts test/botany-rules-check.cjs && git commit -m "feat(botany): 6 个插件植物接入 7 个新群系 spawn 权重"`。

### Task 5: 群系线验收（N03）

**Files:** 无源码改动（只跑命令、写 evidence）
**Interfaces:** Consumes: Task 1–4 的全部产出。

- [ ] **Step 1: 跑 Node 全门** — Run: `npm run verify:node`；Expected: 全 PASS（该脚本由移动端线 M01 添加；若尚未合入，按 spec 列出的 Node-only 命令链逐条跑）。
- [ ] **Step 2: 跑完整 verify 并记录阻塞** — Run: `npm run verify`；Expected: exit 1，卡在 `test:smoke` 的 `Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.`；evidence 记录真实退出码与错误行。
- [ ] **Step 3: 写任务卡 N03 outputs** — 在 `docs/agent/tasks/N03.yaml` 的 outputs 写入实际验收命令与结果；`validate.py` 的 CHECKS 由集成步骤补关键词后须 0 FAIL/WARN。
- [ ] **Step 4: Commit** — `git add docs/agent/tasks/N03.yaml && git commit -m "docs(biome): 群系线验收 evidence"`。

## Self-Review Notes

- Spec 覆盖：群系清单 → Task 1；级联/抢占台账 → Task 2；可达性 → Task 3；botany 联动 → Task 4；验收与浏览器阻塞 → Task 5。
- 任务独立：Task 1 是配置前提；Task 2/3 依赖 Task 1；Task 4 依赖 Task 1 的 BiomeId，与 Task 2/3 不冲突；Task 5 纯验证。
- 类型一致：`BiomeId`、`BIOME_PROFILES`、`DEFAULT_TERRAIN.treeDensity`、`ExpansionPlant.spawn` 全程同名。
- 比例：spec 给出精确配置值与规则，plan 只指定改哪里、断言什么、跑什么，不重写算法。
- 已知边界：可达性是否需扩半径必须实测；浏览器步骤在本机不可执行，不把它写成失败条件。
