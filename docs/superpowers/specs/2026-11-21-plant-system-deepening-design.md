# 植物系统深化 — 完整设计与任务卡草案（定稿）

> 状态：**仅设计 / 任务卡，不含实现**。本文件写在 `/root/.opencode/plan/`（Plan mode 允许的唯一位置）；仓库文件未改动。要落地到 `docs/agent/tasks/*.yaml` 与 `docs/`，需切换 agent。
>
> 用户已确认：① P00 采用两阶段收紧；② **6 游戏日 / 季**（`dayLength=600s` → 一季 ≈60 分钟 realtime，一年 240 分钟）；③ 新增**基础确定性掉落系统**，肥料来源 = 动物稀有掉落 + 堆肥桶 + 骨粉（骷髅掉落）；④ 先把全部设计做完再落地。

---

## 0. 基线事实（已核实源码）

| 主题 | 现状 | 位置 |
|---|---|---|
| 能量表 | `Botany.energy: Map<string, PlantEnergyState>`，**纯内存**，key 为锚点 `blockKey(ax,ay,az)`，上限 4096 | `botany.ts:96,103,316-337` |
| 存档 | `SaveData` v2 严格 `validateSave`；`collectSave()` 组装；`normalizeSave` 升级 v1；**无植物/生态字段** | `src/save/save.ts:10-111,148-178`；`main.ts:318-330` |
| 昼夜 | `dayTime∈[0,1]`、`dayLength=600s`、`localTime` 私有、发 `time:change`；**无 dayCount** | `src/gfx/sky.ts:18-22,287-311,403` |
| 代谢 | `energyDelta()` 三分支写死数字；`tick*` 用 `rng()>p` | `botany.ts:377-423,665-855` |
| 扩展点 | `PlantRuleContext` 14 方法；`PlantRuleRegistry` 无优先级排序 | `src/world/plantRules.ts` |
| 插件内容 | `core:botany-expansion`：6 植物 id 92~97 + 3 规则 | `src/plugins/builtin/botanyContent.ts` |
| 采集 | `Botany.harvest()` → `player.harvestPlant()`（空手右键）/ break 结算 | `player.ts:593,667-679` |
| 物品 | `ITEMS`: apple/porkchop/wheat_seeds/sweet_berries/nectar/stick；`plant` 字段声明可种 | `src/player/survival.ts:33-42` |
| **掉落** | `DropSpec{name,chance?,count?}`；方块 `collectDrops` 与实体 `kill` **都用 `Math.random()`**，违反确定性硬规则 | `blocks.ts:11-17`；`player.ts:617-624`；`entity.ts:255-263` |
| **实体** | 猪/羊/僵尸；僵尸夜间生成；`Entity.id` 为模块级递增计数；`NEXT_ID` 重载重置 | `entity.ts:45-48,213-226,303-309` |
| **方块 id** | 内置到 **109**（末位）；92~97 插件预留；`terrain-system-check.cjs:69` 断言 `all.length===103` | `blocks.ts:340-355` |
| **纹理** | tile 索引按 `painters` 插入顺序；注释明确「新增必须放最后，既有 64 张索引不变」 | `atlas.ts:1431-1437` |
| **交互** | 右键优先级：手持方块→放置；手持 item→种植/进食；空手→`tryInteract()`（仅 `crafting_table`）→`harvestPlant()` | `player.ts:628-636,657-663` |
| **存档脏标记** | `World.setBlock` **不发** `block:place` 事件；脏标记由玩家/自动存档插件监听事件驱动 | `world.ts:213-238`；`autosave.ts` |
| 任务卡校验 | CI `python3 docs/agent/validate.py --strict`；未匹配 CHECK 的 output → WARN → exit 2 | `verify.yml:21`；`validate.py:33-59` |
| 版本 | `version.ts` 唯一源；测试断言动态读 package.json（无需改断言） | `survival-smoke.mjs:210-211` |

---

## 1. 深模块划分（接口 / 实现 / 接缝）

> 用「小接口 + 大实现」原则放置接缝：每个新模块用一个纯函数或少数几个方法隐藏全部复杂度，调用方与测试走同一个接缝。

| 模块 | 外部接口（小） | 隐藏的实现（大） | 为什么是深模块 |
|---|---|---|---|
| `src/world/ecology.ts`（新） | `seasonAt(day)`, `weatherAt(seed,day)`, `modifiers(env)` | 6 日/季的历法、哈希天气、三代谢×两天气倍率表、中性默认 | 一处改历法，所有调用方零改动；纯函数天然可测 |
| `src/world/drops.ts`（新） | `rollDrops(specs, ctx)` | 确定性哈希、chance、数量区间、昼夜/群系条件、来源串 | 一个函数替代散落两处的 `Math.random`；调用方只传规格与来源 |
| `src/world/compost.ts`（新） | `levelOf(id)`, `nextId(id, itemKey)`, `harvestOf(id)` | 9 个 block id 的等级编码、可堆肥物品表、满级判定 | 等级状态**免费**借 `world.edits` 持久化，无需新 Map / 存档字段 / 清理逻辑 |
| `src/world/soil.ts`（新） | `nutrientAt/consume/enrich/returnToSoil` | 懒初始化中性值、上限钳制、上限淘汰 | 调用方只知「养分够不够 / 加减多少」 |
| `Botany`（既有，薄增） | `+enrichSoil`, `+serializeEcology`, `+restoreEcology`；`update/tickAt` 加可选 `env` | 三份状态的协调、bloom/根系/生长全部既有逻辑 | 只对既有大模块加 3 个方法，不给外部暴露内部 Map |

**删除测试**：删掉 `drops.ts`，确定性 roll / 条件 / 区间会在玩家与实体两处重新出现 →  earn its keep。删掉 `compost.ts`，等级编码与可堆肥表会散进 `player.ts` → 同理。

### 1.1 不变量

- `World` 只读契约不变；`PixelWorldData` 不涉及；`BIOME_IDS` 不动。
- 生成层无 DOM；新模块全是纯数据/纯函数，能被 tsc 编译进 `test/terrain-logic/`。
- **禁止新增 Math.random**：`drops.ts` 用纯哈希；同时把玩家/实体既有掉落 roll 迁过来（mob  wander/spawn 的 Math.random 列为后续清理，不在本轮）。
- 不碰 mesher / worker / 快照缓冲契约；不新增运行时依赖（唯一依赖仍为 three）。
- **方块 id 只追加**：堆肥桶占用 **110~118**（9 个），同步 `terrain-system-check.cjs` 的 `all.length` 断言（103 → 112）与 `docs/TESTING.md`、`README.md` 方块数。
- **tile 只追加**：新 painter 注册在 `atlas.ts:1434` 之后，既有 64 张索引不变。
- **版本只 bump 一次**，在最后一张卡 P07，同 commit 同步 README/CHANGELOG（断言已动态化）。

### 1.2 存档模型（可选字段，旧档兼容）

```ts
interface PlantSaveV1 {
  v: 1;
  /** [锚点x, 锚点y, 锚点z, blockId, energy 0..100, bloomed 0|1] */
  plants: [number, number, number, number, number, 0 | 1][];
  /** [土壤x, 土壤y, 土壤z, nutrient 0..100] */
  soil: [number, number, number, number][];
}
SaveData.botany?: PlantSaveV1;
SaveData.dayCount?: number;   // old 缺省 0
SaveData.compost?: never;      // 堆肥等级走 world.edits，不进存档
```

- 上限 `SAVE_PLANTS_LIMIT=1024`、`SAVE_SOIL_LIMIT=1024`；Botany 内部仍 4096。
- 恢复校验：整数坐标、id 存在、trait 存在、`getBlock(anchor)===id`、数值 0~100、`bloomed∈{0,1}`；任一失败**丢弃该条不抛错**。
- 天气不存档：`weatherAt(seed, dayCount)` 纯推导，回档一致。
- 堆肥不存档：等级即 block id，已在 `world.edits` 差分里。

### 1.3 兼容 / 默认中性（现有 57 组生态回归一字不改仍绿）

- `env` 可选参数：不传时 spring/clear，倍率全 1、概率不变。
- 土壤懒初始化：未记录土壤 `nutrientAt()` 返回 100。
- 旧存档缺 `botany`/`dayCount` → 跳过恢复、day=0。
- `DropSpec` 新增字段全可选；未填时 `rollDrops` 行为等价于旧 `chance/count` 语义（但确定性化）。

---

## 2. 新子系统的精确契约

### 2.1 季节 / 天气（P02 之前置 P01）

- `DAYS_PER_SEASON = 6`，`DAYS_PER_YEAR = 24`；`seasonAt(day) = ['spring','summer','autumn','winter'][Math.floor((day%24)/6)]`。
- `weatherAt(seed, day)`：整数哈希 `(seed ^ Math.imul(day, 0x9e3779b1)) >>> 0`，`< 0.25` → `'rain'`，否则 `'clear'`。
- `modifiers(env)` 返回 `{ growth, solar, hydro, fungal, soil }`：
  - spring `{growth:1.3, solar:1, hydro:1, fungal:1, soil:1}`
  - summer `{growth:1.15, solar:1.15, hydro:0.9, fungal:0.9, soil:1}`
  - autumn `{growth:0.85, solar:0.9, hydro:1, fungal:1.1, soil:1}`
  - winter `{growth:0.7, solar:0.55, hydro:0.7, fungal:1.25, soil:0.8}`
  - rain 叠加 `{hydro:×1.25, solar:×0.8, soil:×1.2}`；clear 中性。
- 应用点：`energyDelta` 只把倍率乘到**正向蓄能**（hostile 枯死不被季节削弱，避免「冬天救活洞穴仙人掌」）；`tick*` 概率 `min(0.95, p*growth)`；**bloom 阈值与采集收益不动**，避免连锁改采集测试。
- `Sky` 增 `get dayCount() = Math.floor(localTime/dayLength)` 与 `setTime(dayTime, dayCount)`（回填 `localTime`）。`main.ts` 组 env 传入 `botany.update(dt,x,z,daylight,env)`。

### 2.2 确定性掉落系统（P02）

```ts
// src/world/drops.ts
export interface DropContext {
  seed: number;
  /** 'b:x,y,z'（方块）或 'e:<entityId>:<killSerial>'（实体） */
  source: string;
  daylight?: number;   // 供 nightOnly
  biome?: string;      // 供 biome 条件
}
export function rollDrops(specs: readonly DropSpec[], ctx: DropContext): { name: string; count: number }[];
```

- `DropSpec` 扩展全可选字段：`min?/max?`（count 区间）、`nightOnly?`（`daylight<0.3`）、`biome?`（字符串）。原 `chance`/`count` 保留。
- roll = `hash32(seed, source, specIndex)`；`chance` 用 `roll/2^32 < chance`；`count = min + (hash >>> 8) % (max-min+1)`。
- 迁移：
  - `player.collectDrops(def, x, y, z)`（签名加坐标，3 处调用同步）→ `rollDrops(def.drops, {seed: world.generator.seed, source:'b:'+[x,y,z], daylight, biome})`。
  - `EntityManager` 持 `seed`（构造参数，main 从 `world.generator.seed` 传）与 `killSerial++` → `rollDrops(type.drops, {seed, source:'e:'+id+':'+killSerial})`。
- 测试：同 seed+source 顺序无关且可复现；chance 边界；count 区间；nightOnly/biome；旧两字段语义等价。

### 2.3 土壤养分 + 施肥（P03）

- `MAX=100`、懒初始化返回 100；`growthNutrient?: number` 加到 `PlantTrait`，缺省 `ceil(growthCost/3)`。
- `grow()` 与能量同语义：写入成功才扣，失败不扣；`decay()` / `harvest('break')` 归还 `growthNutrient/2`（封顶 100）。
- `item:fertilizer`（堆肥/动物掉落）：右键土壤/植物 → `enrichSoil(+35)`；`item:bone_meal`（骷髅掉落）：右键 → `enrichSoil(+55)` 且对目标植物 `+15` 能量（可直接推过 bloom 阈值，强效但一次性）。
- 新事件 `plant:soil`（养分变化，含 x/y/z/delta）；`Botany.enrichSoil(x,y,z,delta)` 公开方法供 player 与规则上下文共用。
- F3 `BotanyStats` 追加可选 `soilAvg`。

### 2.4 堆肥桶（P04）

- 9 个方块 id（**110 空 → 111..117 fill1..7 → 118 ready**），名字 `composter` / `composter_1..7` / `composter_ready`，共用 tile `composter_top/side/bottom`，ready 额外 `composter_ready_top`（**4 个新 tile painter，注册在末尾**）。solid=true, opaque=true, hardness=1.2, sound='wood'。
- `COMPOST_VALUES`：`item:wheat_seeds`/`item:apple`/`tall_grass`/`fern`/`dead_bush`/`oak_leaves` 等 = 1；`wheat`/`item:sweet_berries` = 2。`nextId` 满级返回 `null`（拒绝继续填）。
- 右键流程（`player.ts`）：
  - 手持可堆肥 item/block + 准星命中任意 composter 等级 → `world.setBlock(nextId)`、消耗 1 个物品、emit `compost:change`。
  - 空手 + `composter_ready` → `setBlock(composter)`、`survival.addDrop('item:fertilizer',1)`、emit `compost:change`。
  - 新事件 `compost:change` **必须加入 `autosave.ts` 的 dirtyEvents**（因为 `World.setBlock` 不发 `block:place`）。
- 持久化：等级即 block id → 天然进 `world.edits`；坏档/旧档无需迁移。

### 2.5 掉落来源与骨粉（P04）

- 猪：`+{name:'item:fertilizer', chance:0.12}`；羊：`+{name:'item:fertilizer', chance:0.12}`。
- 僵尸：保持 `item:apple 0.35` 不变。
- **新增骷髅** `skeleton`：hostile, health=12, damage=2, `burnInDay:true`, `drops:[{name:'item:bone_meal', chance:0.75}]`；`buildSkeleton` 复用 zombie 骨架改白骨配色（`models.ts` 新增 painter）；夜间生成逻辑由 `wantZombie` 扩为 `wantHostile`，按 0.5 概率选 zombie/skeleton。
- `ITEMS` 新增 `fertilizer`（tile `fertilizer`）与 `bone_meal`（tile `bone_meal`）；两者不可进食、不可种植。
- 反馈：采集/堆肥/施肥用既有 `particles.burst` + `sound.click`，不引入新渲染通道。

### 2.6 扩展点增强（P05）

- `PlantRuleContext` 增 `day()/season()/weather()/soil(x,y,z)/enrichSoil(x,y,z,delta)`，`Botany.ruleContext` 用 P01/P03 状态实现。
- `PlantRule` 增 `priority?: number`；`ruleFor` 按 `(priority, id)` 双键排序；`list()` 暴露 priority。
- 内置 `core:botany-expansion` 加一条演示规则（雨天给 hydro 植物小幅 boost），沿用「深夜+蓄能+低概率」三重门槛，避免脏标记刷屏。
- 权限不变（`botany:register`）；README 扩展示例补新方法。

### 2.7 持久化（P06）

- `Botany.serializeEcology()` / `restoreEcology(data): number`（返回恢复条数）；恢复时逐条校验、去重（同锚点保留最后一条）、分别截断。
- 修复旧 bug：`block:break/place` 订阅除删精确 key 外，按当前方块 `anchorOf()` 再删一次锚点 key，防止柱状/藤蔓中间段被拆后残留储能。
- `SaveData` 加可选 `botany`/`dayCount`；`validateSave` 严格但可选；`normalizeSave` 旧档缺省；`collectSave` 内联 `serializeEcology()`；启动路径在 `ensureChunk` 之后 `restoreEcology(saved.botany)` + `sky.setTime(...)`。
- `RuntimeDiagnostics` 新增恢复状态数量/数值合法性检查 + `test/diagnostics-check.cjs` 注入回归（硬规则 13）。
- **版本 bump（唯一一次）** + 同 commit README/CHANGELOG。

---

## 3. 任务卡（P00 → P06，依赖顺序）

> 每张卡 outputs 的关键词都对应 P00 将要新增的 `validate.py` CHECK。

### P00 任务卡校验器扩展（两阶段收紧）

```yaml
id: P00
title: 任务卡校验器扩展（植物深化七卡）
description: |
  docs/agent/validate.py 的 CHECKS 目前只覆盖视觉回归。CI 用 --strict，
  未匹配关键词的 output 会 WARN → exit 2。本卡为 P01~P06 每条 output
  补机械检查（文件/符号/脚本存在），并分两阶段：
  阶段A（本卡）：检查只认「卡文件存在 + 关键词出现」→ 单卡 PR 可绿；
  阶段B（各实现卡完成时）：把对应检查收紧为「符号/行为真实存在」。
touch: { allow: [docs/agent/validate.py, docs/agent/tasks/P0*.yaml], deny: [src/**, test/**] }
outputs:
  - plant env: ecology.ts 导出 seasonAt/weatherAt 且 DAYS_PER_SEASON=6
  - soil nutrient: soil.ts 导出 nutrientAt/enrich
  - plant save schema: save.ts 含 botany/dayCount 可选字段校验
  - plant drops: drops.ts 导出 rollDrops 且玩家/实体调用已迁移
  - compost bin: blocks.ts 含 composter 110~118 且 atlas 含 composter tile
  - plant rule context: plantRules.ts 含 day/season/weather/soil 方法
  - 任务卡校验器: CHECKS 含上述六个关键词且两阶段均可机械判定
```

### P01 季节与天气代谢基座

```yaml
id: P01
title: 季节 / 天气影响代谢（6 日一季）
description: |
  新增 ecology.ts（历法 + 天气哈希 + 倍率表）；Botany.update/tickAt 加可选 env；
  energyDelta 倍率只作用正向蓄能；tick* 概率乘 growth 并封顶 0.95；
  Sky 加 dayCount getter 与 setTime；main 组 env 传入。
  测试：历法边界(0/5/6/23/24)、天气确定性、中性 env 逐值等价、倍率生效。
touch:
  allow: [src/world/ecology.ts, src/world/botany.ts, src/gfx/sky.ts, src/main.ts,
          test/plant-energy-check.cjs, test/visual-check.mjs, docs/ARCHITECTURE.md, docs/TESTING.md]
  deny: [src/save/save.ts, src/world/mesher.ts]
outputs:
  - plant env: DAYS_PER_SEASON=6 且默认 env 与旧行为逐值相等
  - verify: npm run typecheck && npm run test:snapshot && npm run test:plant-energy 全绿
```

### P02 确定性掉落系统

```yaml
id: P02
title: 基础掉落系统（确定性 roll）
description: |
  新增 drops.ts：rollDrops(specs, ctx) 纯函数 + hash32；
  DropSpec 增 min/max/nightOnly/biome 可选字段；
  player.collectDrops(def,x,y,z) 与 EntityManager.kill 迁入 rollDrops，
  消除掉落路径的 Math.random；EntityManager 接 seed 与 killSerial。
  测试：复现性 / chance 边界 / count 区间 / 条件过滤 / 旧双字段等价。
touch:
  allow: [src/world/drops.ts, src/world/blocks.ts, src/player/player.ts,
          src/entity/entity.ts, src/main.ts, test/logic-check.cjs,
          test/terrain-system-check.cjs, docs/TESTING.md]
  deny: [src/save/save.ts, src/world/mesher.ts]
outputs:
  - plant drops: 掉落 roll 为纯哈希且玩家/实体两条路径均已迁移
  - verify: npm run typecheck && npm run test:snapshot && npm run test:logic && npm run test:terrain-system 全绿
```

### P03 土壤养分 + 肥料使用

```yaml
id: P03
title: 土壤养分与施肥（第二资源）
description: |
  新增 soil.ts（懒初始化 100 / 上限 1024）；PlantTrait 增 growthNutrient；
  grow 成功才扣、decay/break 归还；Botany.enrichSoil 公开；
  ITEMS 增 fertilizer/bone_meal；player 右键施肥（bone_meal 额外 +15 能量）；
  plant:soil 事件；F3 增 soilAvg。
  测试：耗尽阻断、归还、两种肥料效果、懒初始化中性、上限淘汰。
touch:
  allow: [src/world/soil.ts, src/world/plantTraits.ts, src/world/botany.ts,
          src/player/survival.ts, src/player/player.ts, src/gfx/atlas.ts, src/main.ts,
          test/plant-energy-check.cjs, docs/TESTING.md]
  deny: [src/save/save.ts]
outputs:
  - soil nutrient: 养分懒初始化中性、耗尽阻断生长、两种肥料可测
  - verify: npm run typecheck && npm run test:snapshot && npm run test:plant-energy && npm run test:botany 全绿
```

### P04 堆肥桶 + 动物 / 骷髅掉落来源

```yaml
id: P04
title: 堆肥桶与肥料掉落来源
description: |
  blocks.ts 追加 composter 110~118（含 drops=self）；atlas.ts 末尾追加 4 个 painter；
  compost.ts 提供 levelOf/nextId/harvestOf 与 COMPOST_VALUES；
  player 右键填桶 / 空手取肥；compost:change 加入 autosave dirtyEvents；
  猪/羊加 item:fertilizer 稀有掉落；models.ts 加 buildSkeleton；
  实体表加 skeleton 并接入夜间 hostile 生成。
  同步 terrain-system-check.cjs 的 all.length 103→112 与 README 方块数。
  测试：等级编码 / 满级拒绝 / 物品消耗 / 取肥 / 骷髅掉落 / 脏标记事件。
touch:
  allow: [src/world/compost.ts, src/world/blocks.ts, src/gfx/atlas.ts, src/player/player.ts,
          src/plugins/builtin/autosave.ts, src/entity/entity.ts, src/entity/models.ts,
          src/main.ts, test/terrain-system-check.cjs, test/services-check.cjs,
          test/visual-check.mjs, README.md, docs/TESTING.md]
  deny: [src/world/mesher.ts, src/save/save.ts]
outputs:
  - compost bin: composter 占用 110~118 且等级走 world.edits 持久化
  - plant drops: 猪/羊掉肥料、骷髅掉骨粉且夜间可生成
  - verify: npm run typecheck && npm run test:snapshot && npm run test:terrain-system && npm run test:services && npm run test:visual 全绿
```

### P05 插件扩展点增强

```yaml
id: P05
title: 植物规则上下文与优先级
description: |
  PlantRuleContext 增 day/season/weather/soil/enrichSoil；
  PlantRule 增 priority，ruleFor 按 (priority,id) 双键排序、list 暴露；
  内置 botany-expansion 加雨天 boost 演示规则；README 补扩展示例。
  测试：新上下文可读、排序确定、enrichSoil 生效、按 owner 注销仍有效。
touch:
  allow: [src/world/plantRules.ts, src/world/botany.ts, src/api/CraftAPI.ts,
          src/plugins/builtin/botanyContent.ts, test/botany-rules-check.cjs,
          docs/ARCHITECTURE.md, README.md]
  deny: [src/save/save.ts]
outputs:
  - plant rule context: 上下文暴露 day/season/weather/soil 且优先级双键排序确定
  - verify: npm run typecheck && npm run test:snapshot && npm run test:botany-rules 全绿
```

### P06 生态状态存档持久化 + 收尾 bump

```yaml
id: P06
title: 植物生态状态存档持久化
description: |
  Botany 新增 serializeEcology/restoreEcology（校验/去重/截断）；
  修复 block:break/place 只删精确 key 导致柱状锚点残留；
  SaveData 加可选 botany/dayCount，validateSave/normalizeSave/collectSave 同步；
  启动路径恢复后 sky.setTime 回填；
  RuntimeDiagnostics 加恢复状态检查 + 注入回归；
  VERSION bump（唯一一次）同 commit 同步 README/CHANGELOG。
touch:
  allow: [src/world/botany.ts, src/save/save.ts, src/main.ts, src/core/version.ts,
          src/diagnostics/RuntimeDiagnostics.ts, test/plant-energy-check.cjs,
          test/services-check.cjs, test/diagnostics-check.cjs, package.json,
          README.md, CHANGELOG.md, docs/ARCHITECTURE.md, docs/PROJECT-EXPERIENCE.md, docs/TESTING.md]
  deny: [src/world/mesher.ts, src/gfx/**]
outputs:
  - plant save schema: 可选字段严格校验、旧档兼容、round-trip 与坏档隔离可测
  - verify: npm run verify 100% PASS
```

---

## 4. 执行顺序与回归门

```
P00（两阶段收紧，先 A 后随实现卡收紧 B）
  ↓
P01 环境模型      → typecheck, snapshot, test:plant-energy
  ↓
P02 掉落系统      → + test:logic, test:terrain-system
  ↓
P03 土壤肥料      → + test:botany
  ↓
P04 堆肥桶/来源   → + test:services, test:visual
  ↓
P05 扩展点        → + test:botany-rules
  ↓
P06 持久化        → npm run verify（唯一验收入口，100% PASS）
```

每卡：改前 `typecheck` 基线干净；改后 `test:snapshot → 相关 test:* → verify`；提交信息写「改了什么/为什么」。合并纪律沿用 RUNBOOK：一次只合一个 PR、合完立刻 verify、WIP 不上 main、版本只在 P06 bump。

---

## 5. 验收清单（跨卡）

- [ ] 默认 env 下，现有 `test:botany` / `test:plant-energy` 既有断言**一字未改**仍全绿。
- [ ] `DAYS_PER_SEASON=6`；`seasonAt` 在 day=0/5/6/23/24 边界正确；`weatherAt(seed,day)` 可复现；无新增 `Math.random`。
- [ ] 掉落 roll 同 seed+source 顺序无关、可复现；chance 边界与 count 区间正确；两条掉落路径都已迁移。
- [ ] 猪/羊有稀有肥料掉落、骷髅掉骨粉且夜间可生成；堆肥桶 110~118 填/取闭环，`compost:change` 触发存档脏标记。
- [ ] 两种肥料效果有区分（fertilizer +35 养分 / bone_meal +55 养分且 +15 能量）。
- [ ] 旧档（无 `botany`/`dayCount`）经 `normalizeSave` 仍通过 `validateSave`；恶意字段被丢弃不抛错。
- [ ] 存档往返后锚点能量、bloomed、土壤养分、dayCount 数值一致；柱状中间段被拆后锚点能量被清理。
- [ ] 插件规则能读 day/season/weather/soil；同优先级按 id 稳定排序；按 owner 注销仍有效。
- [ ] `python3 docs/agent/validate.py --strict` 0 FAIL / 0 WARN；`npm run verify` 100% PASS。
- [ ] 未触碰 mesher/worker/快照缓冲；未新增运行时依赖；未重排既有 block id / tile 索引。

---

## 6. 明确不做 / 后续

- **杂交繁育系统**：用户本轮未选，不做。
- **视觉季相变色 / 雨天粒子**：涉及受控实验流程与 worker 数据解耦，列为后续独立实验卡。
- **天气联网**：仅用 `weatherAt(seed,day)` 确定性伪天气。
- **mob 游荡/生成的 Math.random 清理**：本轮只清理掉落路径，其余列为技术债。
- **肥料数值平衡**：本设计给出默认（0.12 掉落率、+35/+55 养分），上线后可用数值实验卡调整，不阻塞本轮。

## 7. 落地前置确认（切换 agent 时）

1. 任务卡写入仓库 `docs/agent/tasks/P00.yaml` … `P06.yaml`（7 张），并由 P00 同步扩展 `validate.py`。
2. 实现按 P00→P06 顺序，一次一 PR、合完即 verify。
3. 本设计已覆盖用户四轮输入；如无新输入，切 agent 后即可按卡实施。
