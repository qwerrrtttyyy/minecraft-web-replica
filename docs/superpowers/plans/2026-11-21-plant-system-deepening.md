# 植物系统深化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Minecraft TS 复刻补全植物生态的四个深化方向：季节/天气代谢、确定性掉落、土壤养分与肥料来源（堆肥桶+动物+骨粉）、插件扩展点，以及生态状态存档持久化。

**Architecture:** 以纯数据模块（`ecology.ts` / `drops.ts` / `compost.ts` / `soil.ts`）承担复杂规则，暴露小接口；`Botany` 作为唯一状态协调者，只增加 3 个公开方法。堆肥等级编码进 block id（110~118），借 `world.edits` 免费持久化。存档用可选字段保持旧档兼容。

**Tech Stack:** TypeScript strict + three.js（唯一运行时依赖）+ Node CJS 快照测试 + Vitest 风格断言脚本。

**Spec:** `docs/superpowers/specs/2026-11-21-plant-system-deepening-design.md`
**任务卡:** `docs/agent/tasks/P00.yaml` … `P06.yaml`

## Global Constraints

- 禁止 `Math.random`（生成与掉落路径）；所有随机走 seed 派生的 mulberry32 或纯哈希。
- 方块 id 只追加，内置 1..109 不变；堆肥桶占 110~118；同步 id 断言与文档。
- atlas 新 painter 只注册在既有纹理之后，既有 64 张 tile 索引不得变化。
- `World` 只读契约不变；不改 mesher / worker / 网格快照缓冲契约。
- 不新增运行时依赖。
- 版本只在 Task 6 bump 一次（`src/core/version.ts`），同 commit 同步 README/CHANGELOG。
- 默认环境（spring/clear）与未记录土壤必须对既有 57 组生态断言逐值中性。
- 每卡：`npm run test:snapshot` 必须先于任何 require 快照的测试。

## Review Focus

- 旧存档缺 `botany`/`dayCount` 字段：必须经 `normalizeSave` 通过校验，植物从 32 能量起步。→ Task 6 `test/services-check.cjs` 旧档用例。
- 恶意/损坏生态存档（NaN、越界、错 id、非数组）：逐条丢弃不抛错、不阻断启动。→ Task 6 `test/plant-energy-check.cjs` 坏档用例。
- 柱状/藤蔓植物中间段被拆：锚点储能必须被清理，不能残留。→ Task 6 断段清理用例。
- 默认 env 下既有生态测试被意外改变：必须逐值等价。→ Task 1 中性等价用例。
- 堆肥填满后继续投放 / 满级取肥：必须拒绝继续填、取肥后回到空等级。→ Task 4 等级闭环用例。

---

### Task 0: 任务卡校验器与实施文档

**Files:**
- Modify: `docs/agent/validate.py`
- Create: `docs/superpowers/specs/2026-11-21-plant-system-deepening-design.md`, `docs/superpowers/plans/2026-11-21-plant-system-deepening.md`, `docs/agent/tasks/P00.yaml` … `P06.yaml`

**Interfaces:**
- Produces: `validate.py` 的 CHECKS 含 6 个新关键词，逐个检查真实源码符号；7 张任务卡可被 `outputs_of` 解析。

- [ ] **Step 1: 写失败测试** — 在 `docs/agent/validate.py` 增加 CHECKS 条目：关键词 `plant env` 检查 `src/world/ecology.ts` 含 `export function seasonAt` 与 `DAYS_PER_SEASON = 6`；`soil nutrient` 检查 `soil.ts` 含 `export function nutrientAt`；`plant save schema` 检查 `save.ts` 含 `botany?:`；`plant drops` 检查 `drops.ts` 含 `export function rollDrops`；`compost bin` 检查 `blocks.ts` 含 `composter`；`plant rule context` 检查 `plantRules.ts` 含 `season()`。此时源码未实现，检查应为 FAIL。
- [ ] **Step 2: 运行验证失败** — Run: `python3 docs/agent/validate.py --strict`，Expected: 输出含 `FAIL` 且 exit code 非 0。
- [ ] **Step 3: 实现检查函数** — 上述 CHECKS 用 `read(rel)` + 子串判定；每个关键词对应一个 lambda；不要改变既有 4 个 CHECKS。
- [ ] **Step 4: 提交文档与校验器** — `git add docs && git commit -m "docs(plant): 落地设计/任务卡并扩展校验器"`。此时 validate 仍因源码未实现而 FAIL，属预期（本分支只在 Task 6 合入）。

### Task 1: 季节与天气代谢基座

**Files:**
- Create: `src/world/ecology.ts`
- Modify: `src/world/botany.ts`, `src/gfx/sky.ts`, `src/main.ts`, `test/plant-energy-check.cjs`

**Interfaces:**
- Produces: `export type Season`, `export type Weather`, `export interface PlantEnv`, `export const DAYS_PER_SEASON = 6`, `export function seasonAt(day: number): Season`, `export function weatherAt(seed: number, day: number): Weather`, `export function modifiers(env: PlantEnv): ModifierSet`；`Botany.update(dt, x, z, daylight, env?)`、`Botany.tickAt(x, y, z, daylight?, env?)`；`Sky.get dayCount()`, `Sky.setTime(dayTime, dayCount)`。

- [ ] **Step 1: 写失败测试** — 在 `test/plant-energy-check.cjs` 末尾新增断言组：`seasonAt(0)==='spring'`、`seasonAt(5)==='spring'`、`seasonAt(6)==='summer'`、`seasonAt(23)==='winter'`、`seasonAt(24)==='spring'`；`weatherAt(seed,day)` 同参两次相等；不传 env 的 `botany.tickAt` 与传默认 env 的结果数值一致。测试 require `./terrain-logic/world/ecology.js`（首次运行模块不存在 → FAIL）。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/plant-energy-check.cjs`，Expected: FAIL，提示找不到 ecology 模块。
- [ ] **Step 3: 实现 ecology.ts** — 按 Interfaces 的签名实现纯函数；倍率表按 spec §2.1 的精确数值；中性默认 spring/clear 全为 1。
- [ ] **Step 4: 接入 Botany** — `update/tickAt` 加可选 env，缓存到 `private env`；`energyDelta` 只对 `delta>0 && !hostile` 乘 `modifiers.solar/hydro/fungal`；所有 `tick*` 的 `rng()>p` 改为 `rng()>Math.min(0.95, p*growth)`；bloom 阈值与采集收益不改。
- [ ] **Step 5: 接入 Sky/main** — Sky 加 `dayCount` getter 与 `setTime`；main 在 `botany.update` 调用处传入 `{day: sky.dayCount, season: seasonAt(sky.dayCount), weather: weatherAt(seed, sky.dayCount)}`。
- [ ] **Step 6: 运行验证通过** — Run: `npm run typecheck && npm run test:snapshot && node test/plant-energy-check.cjs`，Expected: PASS，29+ 组断言全绿。
- [ ] **Step 7: 提交** — `git commit -m "feat(plant): 季节与天气影响代谢（6 日一季）"`。

### Task 2: 确定性掉落系统

**Files:**
- Create: `src/world/drops.ts`
- Modify: `src/world/blocks.ts`, `src/player/player.ts`, `src/entity/entity.ts`, `src/main.ts`, `test/logic-check.cjs`

**Interfaces:**
- Produces: `export interface DropContext { seed: number; source: string; daylight?: number; biome?: string }`；`export function rollDrops(specs: readonly DropSpec[], ctx: DropContext): { name: string; count: number }[]`；`DropSpec` 增 `min?/max?/nightOnly?/biome?`；`Player.collectDrops(def, x, y, z)`；`EntityManager` 构造增加 `seed` 参数。

- [ ] **Step 1: 写失败测试** — 在 `test/logic-check.cjs` 新增：`rollDrops` 同 seed+source 两次结果深等；`chance:0` 永不掉、`chance:1` 必掉；`min:2,max:4` 的 count 落在 [2,4]；`nightOnly` 在 daylight=1 不掉落。首次 require `./terrain-logic/world/drops.js` → FAIL。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/logic-check.cjs`，Expected: FAIL。
- [ ] **Step 3: 实现 drops.ts** — `hash32(seed, source, index)` 用整数运算；chance 用 `hash/2^32`；count 用 `(hash>>>8) % (max-min+1) + min`；条件不满足直接跳过。
- [ ] **Step 4: 迁移两条调用路径** — `player.collectDrops(def,x,y,z)` 用 `world.generator.seed` 与 `source:'b:'+坐标`；`EntityManager` 持 seed、killSerial，kill 时用 `source:'e:'+id+':'+serial`；同步 main.ts 的 `new EntityManager(world, scene, events, seed)` 与 3 处 collectDrops 调用。掉落路径不得再有 `Math.random`。
- [ ] **Step 5: 运行验证通过** — Run: `npm run typecheck && npm run test:snapshot && node test/logic-check.cjs && node test/terrain-system-check.cjs`，Expected: PASS。
- [ ] **Step 6: 提交** — `git commit -m "feat(drops): 掉落判定改为确定性哈希"`.

### Task 3: 土壤养分与施肥

**Files:**
- Create: `src/world/soil.ts`
- Modify: `src/world/plantTraits.ts`, `src/world/botany.ts`, `src/player/survival.ts`, `src/player/player.ts`, `src/gfx/atlas.ts`, `test/plant-energy-check.cjs`

**Interfaces:**
- Produces: `nutrientAt(x,y,z): number`（未跟踪返回 100）、`consume(x,y,z,n)`, `enrich(x,y,z,n)`, `returnToSoil(x,y,z,n)`；`PlantTrait.growthNutrient?`；`Botany.enrichSoil(x,y,z,delta): void`；`ITEMS.fertilizer`, `ITEMS.bone_meal`。

- [ ] **Step 1: 写失败测试** — `test/plant-energy-check.cjs` 新增：未跟踪土壤养分 100；`consume` 后降低；`enrich` 封顶 100；把某植物能量设高、土壤养分设为 0 后 `tickAt` 不生长；`enrichSoil(+35)` 后恢复生长。首次 require `./terrain-logic/world/soil.js` → FAIL。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/plant-energy-check.cjs`，Expected: FAIL。
- [ ] **Step 3: 实现 soil.ts** — Map + `blockKey`，大小上限 1024；纯函数式加减；懒初始化返回 100。
- [ ] **Step 4: 接入 Botany** — `grow()` 成功写入后扣 `trait.growthNutrient ?? ceil(growthCost/3)`，失败不扣；`decay()` / `harvest('break')` 归还一半；公开 `enrichSoil`；发 `plant:soil` 事件；F3 `BotanyStats` 增 `soilAvg` 可选字段。
- [ ] **Step 5: 接入物品与交互** — `ITEMS` 加 fertilizer/bone_meal + atlas 末尾两个 tile painter；`player.useSelected` 手持这两类物品右键目标时调用 `enrichSoil`（fertilizer +35；bone_meal +55 且对目标植物 `setEnergy` +15）并消耗物品；空手采集优先级不变。
- [ ] **Step 6: 运行验证通过** — Run: `npm run typecheck && npm run test:snapshot && node test/plant-energy-check.cjs && node test/botany-check.cjs`，Expected: PASS（29+ / 28 组）。
- [ ] **Step 7: 提交** — `git commit -m "feat(soil): 土壤养分与两种肥料"`.

### Task 4: 堆肥桶与肥料掉落来源

**Files:**
- Create: `src/world/compost.ts`
- Modify: `src/world/blocks.ts`, `src/gfx/atlas.ts`, `src/player/player.ts`, `src/plugins/builtin/autosave.ts`, `src/entity/entity.ts`, `src/entity/models.ts`, `src/main.ts`, `test/terrain-system-check.cjs`

**Interfaces:**
- Produces: `levelOf(id: BlockId): number`, `nextId(id: BlockId, itemKey: string): BlockId | null`, `harvestOf(id: BlockId): string | null`；方块 `composter`(110) / `composter_1..7`(111..117) / `composter_ready`(118)；`buildSkeleton`；`skeleton` 实体类型。

- [ ] **Step 1: 写失败测试** — `test/terrain-system-check.cjs` 新增：9 个 composter 方块 id 为 110..118 且 `drops` 为 self；`levelOf(110)==0`、`levelOf(118)==8`；`nextId(118,'item:apple')===null`；`harvestOf(118)==='item:fertilizer'`；猪/羊 drops 含 `item:fertilizer`；`entities.getType('skeleton')` 非 undefined。首次 require `./terrain-logic/world/compost.js` → FAIL。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/terrain-system-check.cjs`，Expected: FAIL。
- [ ] **Step 3: 实现 compost.ts 与方块/纹理** — `COMPOST_VALUES` 表 + 3 个纯函数；`blocks.ts` 末尾追加 9 个方块；`atlas.ts` 末尾追加 `composter_top/side/bottom/ready_top` 四个 painter；同步 `all.length` 103→112。
- [ ] **Step 4: 接入交互与脏标记** — `player` 手持可堆肥物右键 composter → `world.setBlock(nextId)`、消耗物品、emit `compost:change`；空手右键 ready → 回空等级 + 给肥料 + emit；`autosave.ts` 的 dirtyEvents 加 `compost:change`。同步更新 `GameEvents` 事件类型定义。
- [ ] **Step 5: 接入掉落来源** — 猪/羊 drops 加 fertilizer(0.12)；`models.ts` 加 `buildSkeleton`（复用 zombie 结构改白骨配色）；实体表加 skeleton(75% bone_meal)；夜间 hostile 生成按 0.5 选 zombie/skeleton。
- [ ] **Step 6: 运行验证通过** — Run: `npm run typecheck && npm run test:snapshot && node test/terrain-system-check.cjs && node test/services-check.cjs`，Expected: PASS。
- [ ] **Step 7: 提交** — `git commit -m "feat(compost): 堆肥桶与肥料掉落来源"`.

### Task 5: 插件扩展点增强

**Files:**
- Modify: `src/world/plantRules.ts`, `src/world/botany.ts`, `src/api/CraftAPI.ts`, `src/plugins/builtin/botanyContent.ts`, `test/botany-rules-check.cjs`

**Interfaces:**
- Consumes: Task 1 的 `PlantEnv`/`seasonAt`/`weatherAt`、Task 3 的 `nutrientAt`/`enrichSoil`。
- Produces: `PlantRuleContext` 增 `day()/season()/weather()/soil(x,y,z)/enrichSoil(x,y,z,delta)`；`PlantRule.priority?`；`ruleFor` 双键排序。

- [ ] **Step 1: 写失败测试** — `test/botany-rules-check.cjs` 新增：注册两条同 priority 规则，`listRules`/内部序按 id 字典序；规则内读 `ctx.day()/season()/weather()/soil()` 有值；`ctx.enrichSoil` 改变养分；`unregisterRules(owner)` 后规则失效。Expected: FAIL（方法未定义）。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/botany-rules-check.cjs`，Expected: FAIL。
- [ ] **Step 3: 实现上下文与优先级** — `plantRules.ts` 接口加字段；`PlantRuleRegistry.ruleFor` 结果按 `(priority, id)` 排序；`list()` 带 priority；`Botany.ruleContext` 补 5 个方法，全部委托既有状态/纯函数。
- [ ] **Step 4: 演示规则与文档** — `botanyContent.ts` 加雨天 boost 规则（深夜+蓄能+低概率三重门槛）；README/CraftAPI 示例补新方法。
- [ ] **Step 5: 运行验证通过** — Run: `npm run typecheck && npm run test:snapshot && node test/botany-rules-check.cjs`，Expected: PASS。
- [ ] **Step 6: 提交** — `git commit -m "feat(plugins): 植物规则上下文与优先级"`.

### Task 6: 生态状态存档持久化 + 版本 bump

**Files:**
- Modify: `src/world/botany.ts`, `src/save/save.ts`, `src/main.ts`, `src/core/version.ts`, `src/diagnostics/RuntimeDiagnostics.ts`, `test/plant-energy-check.cjs`, `test/services-check.cjs`, `test/diagnostics-check.cjs`, `package.json`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1/3/4/5 的全部状态与模块。
- Produces: `PlantSaveV1`, `Botany.serializeEcology(): PlantSaveV1`, `Botany.restoreEcology(data: unknown): number`; `SaveData.botany?`, `SaveData.dayCount?`.

- [ ] **Step 1: 写失败测试** — 在 `test/plant-energy-check.cjs` 新增：设置能量/bloom/土壤养分后 serialize→新 Botany restore，数值一致；损坏条目（NaN/错 id/坐标非整数）被丢弃；>1024 条被截断；柱状中间段拆除后锚点能量被清理。在 `test/services-check.cjs` 新增：旧档缺字段仍通过 validateSave；非法 botany 字段被 normalizeSave 拒绝或清洗。Expected: FAIL。
- [ ] **Step 2: 运行验证失败** — Run: `npm run test:snapshot && node test/plant-energy-check.cjs && node test/services-check.cjs`，Expected: FAIL。
- [ ] **Step 3: 实现序列化/恢复** — PlantSaveV1 紧凑元组；恢复逐条校验坐标/id/trait/数值范围、同锚点去重、分别截断 1024；返回恢复条数；不抛错。修复 `block:break/place` 订阅：按当前方块 `anchorOf()` 额外删除锚点 key。
- [ ] **Step 4: 存档契约与启动路径** — `SaveData` 加可选字段；`validateSave` 严格校验但可选；`normalizeSave` 旧档缺省；`collectSave` 内联 serializeEcology；启动在 ensureChunk 后 restore + `sky.setTime(dayTime, dayCount)`。
- [ ] **Step 5: 诊断与文档** — `RuntimeDiagnostics` 加恢复状态数量/数值检查 + `diagnostics-check.cjs` 注入回归；README/CHANGELOG/ARCHITECTURE/PROJECT-EXPERIENCE/TESTING 同步；`VERSION` bump 一次（1.5.1 → 1.6.0）并同 commit 同步 package.json/README 版本行。
- [ ] **Step 6: 全量验证通过** — Run: `npm run verify`，Expected: 100% PASS（含 `python3 docs/agent/validate.py --strict` 0 FAIL/WARN）。
- [ ] **Step 7: 提交** — `git commit -m "feat(plant): 生态状态持久化并发布 1.6.0"`.
