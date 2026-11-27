# 内容体系完善 — 设计文档（定稿）

> 状态：**设计 / 任务卡已落地仓库**，实现按 `docs/superpowers/plans/2026-11-21-content-system-implementation.md` 的 C00–C05 顺序推进。
>
> 需求来源：用户四轮输入 + 三轮 grilling 确认（方案 A1+B1+C1+D1+、动物全部可繁殖、掉落物不进存档、繁殖食物用现有植物且一种生物支持多种、上限以后可能放松、水中"模拟现实掉入"、熔炉明日再议）。

---

## 0. 基线事实（已核实源码）

| 主题 | 现状 | 位置 |
|---|---|---|
| 内置方块 | **141（原基线；合并 v1.7.0 内容植物扩充后为 152） 种**，id 到 **147**；熔炉 `furnace` 是 id=119 的占位方块，**无任何烧炼逻辑** | `src/world/blocks.ts:96-97,425`；`test/terrain-system-check.cjs:96,522` |
| 火把 | 方块已存在，`lightEmission=14`，开局送 8 支；**无配方**，用完断供 | `blocks.ts:221-225`；`main.ts:218,513` |
| 煤矿石 | 方块已存在，当前 `drops` 默认掉落**自身**（整块矿石），无"煤炭"物品 | `blocks.ts:214` |
| 合成 | 8 条配方；UI 直接遍历 `CRAFTING_RECIPES`，新配方自动出现；断言全是结构性，无总数硬编码 | `crafting.ts:58-113`；`ui/crafting.ts:316`；`test/crafting-check.cjs:52-60,303-304` |
| 物品 | `ITEMS` 8 项；新物品需同时加 `ITEMS` 条目 + 图集 tile painter | `survival.ts:34-47` |
| 图集 | 16×16=256 槽，painter 追加在末尾即可保持既有索引；`makeItemGeometry/makeBlockGeometry` 可复用 UV 几何 | `atlas.ts:1465-1499,1613,1624` |
| 生物 | 猪/羊（被动）、僵尸/骷髅（敌对）；`EntityType.weight` 是 **dead code**，生成硬编码 `pig/sheep` | `entity.ts:14-35,223-241,293-310` |
| 交互 | 右键已有 `entityTarget`（`raycast`），`useSelected()` 是放置/种植/进食的唯一入口；十字方块放置要求正下方实心 | `player.ts:430-432,641-667,756` |
| 暂停 | `entities.update` 在 title 也调用；`botany.update` 只在 `mode==='playing'` 调用；dt 被 0.05 钳制，不会切后台后暴涨 | `main.ts:1362-1404`；`engine.ts:133-155` |
| 掉落 | 挖块 `collectDrops` 与实体 `kill` 都直接 `survival.addDrop()` 进背包，世界不可见 | `player.ts:623-634`；`entity.ts:270-280`；`main.ts:777-779` |
| 光照 | `setBlock` 会触发 `light.rebuild()`，方块光能正常传播 | `light.ts:162-169` |
| 水 / 岩浆 | 有液体方块与水中浮力逻辑；**无岩浆**（不存在烧毁分支） | `entity.ts:173-180`；`blocks.ts`/`generator.ts` 无 lava |
| 测试 | 新纯逻辑源文件要进 `scripts/build-test-snapshot.mjs` 的 entries；新测试要在 `package.json` 加 `test:*` 并挂进 `verify` 长链 | `scripts/build-test-snapshot.mjs:17-66`；`package.json:37-38` |

---

## 1. 意图 / Why

当前世界有丰富的方块、植物、群系，但**"玩家能获得什么、这些东西有什么用"这条内容链是断的**：照明用品开局送完就没了；煤矿石挖出来还是矿石；生物只有 4 种且完全不可繁殖；掉落物凭空进背包，没有"打怪→看见掉落→跑过去捡"的反馈闭环。本轮目标是把这些断点接上，让世界里的产出可见、可用、可再生产。

## 2. 目标 / 非目标 / 反目标

**目标**
- 5 种被动动物（猪/羊/牛/鸡/兔）+ 3 种敌对保持原样；新增动物有模型、掉落、可繁殖。
- 可见的悬浮掉落物：落地、浮动、自转、靠近拾取、入水缓慢下沉、限时消失。
- 煤炭物品 + 火把配方，打通照明闭环。
- 所有新增/既有数值集中到一张 `tuning.ts`，以后调数值只改一处。

**非目标**
- 熔炉 / 烧炼 / 燃料系统（用户明确"明日再议"）。
- 可驯服、骑乘、繁殖后的基因/品种差异。
- 掉落物持久化到存档。
-  farming 自动化、作物成熟加速联动。

**反目标（做了就算失败）**
- 破坏既有 141（原基线；合并 v1.7.0 内容植物扩充后为 152） 方块 id 与图集索引 → 旧存档 `edits` 错位。
- 既有回归测试需要被改才能绿（新数值必须原样搬入，不偷改既有行为）。
- 在新逻辑里引入 `Math.random()` → 违反确定性硬规则。**范围澄清**：项目硬规则原文只约束**掉落判定**（`docs/PROJECT-EXPERIENCE.md:61-62`：掉落走 `rollDrops()`，禁止在玩家/实体掉落路径再写 `Math.random`）；既有实体 AI 的游荡 / 生成坐标 `Math.random()` 属技术债，**本轮不动**（用户已要求"既有行为不动 / 数值原样搬入"）。本轮新增的散开判定与加权抽取一律用 `dropHash`。
- 把 DOM / three 带进 `dropLogic.ts` 等纯逻辑模块 → 无法编译进快照测试。

## 3. 约束

- 方块 id 只追加；本轮**不新增任何方块**（煤炭是物品、动物和掉落物是实体），方块总数 141（原基线；合并 v1.7.0 内容植物扩充后为 152） 断言不动。
- 图集 tile 只追加在末尾；新增 6 个物品 tile。
- 生成层无 DOM；`dropLogic.ts` / `tuning.ts` / `breeding.ts` 纯数据。
- 随机性走 `dropHash(seed, source, index)` 或现有 `createRng`；不新增运行时依赖（唯一依赖仍为 three）。**裁定**：`seed` 从 `main.ts` 注入 `DropManager` 构造（即 `world.generator.seed`）；`source` 用掉落来源串（`b:x,y,z` / `e:id:serial`，直接 spawn 回退 `d:x,y,z`）；`index` 用一次 roll 内的 materials 下标 + manager 内 `spawnSerial` 组合，保证同种子同来源同序号可复现。实体游荡/生成坐标的既有 `Math.random()` 不在本轮范围。
- Worker / mesher / 快照缓冲契约不动。
- 版本只在最后一张卡 bump 一次。

---

## 4. 方案取舍（Approaches）

| 轴 | 候选 | 取舍 | 选定 |
|---|---|---|---|
| **A 掉落物架构** | A1 独立 `DropManager` + 纯逻辑 `dropLogic.ts`，复用图集几何渲染 | 语义干净、可单测、无新纹理；代价是主循环多一次 update | ✅ **A1** |
| | A2 塞进 `Entity` 体系 | 物品被迫带 hp/攻击/AI 模型，语义混乱，测试难 | 否 |
| | A3 InstancedMesh 批量渲染 | 掉落物 <50 个，过度设计且不易测 | 否 |
| **B 数值落点** | B1 新建 `src/core/tuning.ts` 单一配置表 | 符合"规则进配置表"硬规则；既有值原样搬入 → 回归不动；以后放松一处可改 | ✅ **B1** |
| | B2 就地散改常量 | 下次调数值又要全文搜，且容易误改既有行为 | 否 |
| **C 煤炭范围** | C1 煤矿石直接掉煤炭 + 火把配方，不做熔炉 | 改动小，闭环完整 | ✅ **C1** |
| | C2 加熔炉 + 烧炼 + 燃料 | 新系统（UI/燃料表/状态机/存档），远超本轮；用户明确明日再议 | 否 |
| **D 动物范围** | D1+ 牛/鸡/兔 + 全部 5 种被动可繁殖 | 统一一套繁殖逻辑，避免猪/羊成为孤岛 | ✅ **D1+** |
| | D2 狼/猫可驯服或蜜蜂产蜜 | 另一个量级，非目标 | 否 |

---

## 5. 模块划分（小接口 + 大实现）

| 模块 | 外部接口（小） | 隐藏的实现（大） | 为什么是深模块 |
|---|---|---|---|
| `src/core/tuning.ts`（新） | 导出常量对象：`ANIMALS` / `BREED_FOODS` / `DROPS` / `COAL` / `SURVIVAL_NEW` | 全部数值、权重、时长、上限、食物映射表 | 一处改数值，所有调用方零改动；测试也读它 |
| `src/world/dropLogic.ts`（新） | `scatterOffset`, `advanceWater`, `canPickup`, `mergeKey`, `shouldDespawn` | 确定性散开、水中终端速度、拾取/合并/消失判定 | 纯函数，可脱离 three/DOM 单测；渲染层只问"能不能捡" |
| `src/entity/droppedItem.ts`（新） | `DropManager.spawn / update / clear / onPickup` | 物理碰撞（复用 `moveBody`）、图集几何缓存、浮动自转、入水水花、拾取反馈 | 调用方只传"名字/数量/坐标"，不关心渲染与生命周期 |
| `src/entity/breeding.ts`（新） | `isBreedFood(typeId, material)`, `pickMate(...)`, `tickBreeding(...)` | 食物白名单、求爱状态机、幼崽成长、冷却、上限 | 状态字段挂在 Entity 上，规则集中在此；纯函数部分可测 |
| `src/entity/models.ts`（既有，薄增） | `buildCow / buildChicken / buildRabbit` | 盒装模型 + 腿部动画，沿用现有套路 | 不引入新渲染栈 |
| `Botany` 之外**不改** | — | — | 植物深化成果保持原样 |

---

## 6. 精确契约

### 6.1 `src/core/tuning.ts`

```ts
/** 既有数值原样搬入（键名自定），新内容赋新值；不得偷改既有值 */
export const POPULATION = { targetDay: 6, targetNight: 9, hostileCap: 4, cap: 24 } as const;
export const BREED = {
  loveDuration: 30,      // 秒：求爱状态有效窗口
  cooldown: 120,         // 秒：双亲冷却
  growTime: 120,         // 秒：幼崽长成
  babyScale: 0.55,
  mateRadius: 8,
  feedReach: ENTITY_REACH, // 复用既有常量值
} as const;
export const DROPS = {
  pickupRadius: 1.2,
  pickupDelay: 0.4,
  mergeRadius: 0.8,
  stackLimit: 999,
  lifetime: 300,          // 秒，仅 playing 计时
  scale: 0.28,
  spin: 1.5,              // rad/s
  bobAmp: 0.08,
  bobSpeed: 3,
  waterSink: 0.6,         // 入水终端下沉速度（格/秒）
  scatter: 0.35,          // 生成时水平散开半径
  popSpeed: 2.2,
} as const;
export const BREED_FOODS: Record<string, string[]> = {
  pig:    ['wheat', 'item:apple', 'item:sweet_berries'],
  sheep:  ['item:wheat_seeds', 'tall_grass', 'fern', 'dandelion'],
  cow:    ['wheat', 'tall_grass', 'fern', 'dandelion', 'item:apple'],
  chicken:['item:wheat_seeds', 'item:sweet_berries', 'seagrass'],
  rabbit: ['dandelion', 'poppy', 'tulip_red', 'tulip_orange', 'tulip_white',
           'tulip_pink', 'cornflower', 'bluebell', 'allium', 'azure_bluet',
           'oxeye_daisy', 'lily_of_the_valley', 'sunflower', 'lilac',
           'rose_bush', 'peony', 'dead_bush'],
};
export const ANIMALS = {
  cow:     { width: 0.9, height: 1.4, speed: 0.9,  health: 10, weight: 3, drops: [...] },
  chicken: { width: 0.5, height: 0.7, speed: 1.1,  health: 4,  weight: 2, drops: [...] },
  rabbit:  { width: 0.6, height: 0.6, speed: 1.4,  health: 3,  weight: 2, drops: [...] },
  // 猪/羊的既有数值原样搬入（weight 补 3）
};
export const NEW_ITEMS = { /*  food：beef 7 / rabbit_meat 5 / egg 3；其余不可食 */ };
```

- `POPULATION` / `DROPS` / `BREED` 的每一项都是**导出常量**，以后放松上限只改一处。
- `BREED_FOODS` 的键是 EntityType id，值是材料标识（方块名 / `item:xxx`），与 `inventoryKeyToMaterial` 同口径；一种生物支持多种。

### 6.2 物品与纹理

- `ITEMS` 新增 6 项：`coal`（煤炭）、`leather`（皮革）、`beef`（生牛肉，food=7）、`feather`（羽毛）、`egg`（鸡蛋，food=3）、`rabbit_meat`（兔肉，food=5）。皮革/羽毛/煤炭不可食、不可种。
- `atlas.ts` 在**全部既有 painter 之后**追加 6 个 painter（与 `fertilizer`/`bone_meal` 同样的末尾追加纪律），索引不变；风格沿用程序化像素。
- `blocks.ts`：`coal_ore` 的 `drops` 改为 `[{ name: 'item:coal', min: 1, max: 2 }]`。
- 新动物掉落（**新物品一律 `item:` 前缀**，与猪的 `item:porkchop` 同口径；否则 `mergeKey` 会把猪皮革和新牛皮革当成两种东西、无法堆叠）：牛 `[{name:'item:leather',min:1,max:2},{name:'item:beef',min:1,max:2}]`；鸡 `[{name:'item:feather',min:1,max:2},{name:'item:egg'}]`；兔 `[{name:'item:rabbit_meat'}]`。猪/羊既有掉落不变。

### 6.3 动物与繁殖

- `models.ts` 增 `buildCow / buildChicken / buildRabbit`，复用 `box/limb/animate` 套路；幼崽用整体缩放，**不新建模型**。
- `Entity` 增 3 个状态字段：`age`（出生后秒数，成体初始化为 `growTime`）、`loveTimer`、`cooldown`。`baby` getter = `age < growTime`。
- **缩放冲突坑**：`hurt()` 会把 `group.scale` 设为 1.14 并在 `update()` 衰减到 1；幼崽的目标缩放必须是 `babyScale × 受击闪光系数`，不能直接写死 1，否则幼崽受一次击就变大。
- `trySpawnNear()` 改为按 `weight` 加权抽取（激活 dead code）：**新抽取用 `dropHash(seed, 'spawn:'+spawnSerial, 0)/2^32` 选类型**，不引入新的 `Math.random`；生成坐标与游荡仍走既有 `Math.random()`（技术债，本轮不动）。夜间敌对分支不变；`cap` 上限同时约束自然生成与繁殖。
- 右键喂食：`useSelected()` 在 `tryCompost()` 之后、`selectedStack()` 判定之前插入——若 `entityTarget` 是可繁殖**成体**且手持材料命中 `BREED_FOODS[typeId]`，则消耗 1 个并返回。喂错材料静默走原流程（可能触发放置/进食），不弹 toast。
- 繁殖流程（Minecraft-lite）：两只同类成体在 30 秒窗口内都被喂 → 找最近的同类求爱伙伴（按实体 id 稳定选择，`mateRadius=8`）→ 生成幼崽于中点附近的合法地面 → 双亲 `cooldown=120`。冷却中再喂静默。
- 求爱期间头顶周期性粉色心形粒子（复用 `particles.burst`，颜色区分），无 toast。
- 幼崽不可繁殖、掉落同成体；`age` 达 `growTime` 后缩放归 1。

### 6.4 掉落物系统

**纯逻辑 `dropLogic.ts`**（无 three / DOM，可进快照测试）
- `scatterOffset(seed, source, index)`：用 `dropHash` 生成确定性散开偏移与弹出初速，禁止 `Math.random`。
- `advanceWater(vy, vx, vz, dt)`：入水时 vy 趋向 `-waterSink`、水平速度按 exp 衰减；出水后交回重力。
- `canPickup(drop, playerPos)`：距离 ≤ `pickupRadius` 且 `age ≥ pickupDelay`。
- `mergeKey(a, b)`：同材料键且距离 ≤ `mergeRadius`（材料键 = 方块名 / `item:xxx` 统一串）。
- `shouldDespawn(drop)`：`age ≥ lifetime` 或 `y < 0`。

**渲染 / 生命周期 `droppedItem.ts`**
- `DroppedItem` 持 `{ name, count, pos, vel, age, wasInWater, mesh }`；`DropManager` 构造注入 `seed` 并维护 `spawnSerial`；`spawn(name,count,x,y,z,source)` 的 `source` 由调用方传掉落来源串（`b:x,y,z` / `e:id:serial`），散开偏移用 `scatterOffset(seed, `${source}#${spawnSerial++}`, index)`，`index` 为同次 roll 内的材料下标。material 共享一份 `MeshBasicMaterial({ map: atlas.texture, vertexColors:true, alphaTest:0.5, side:DoubleSide })`；几何按 tile 名缓存（`makeItemGeometry` / `makeBlockGeometry`），拾取/消失只 `scene.remove`，不 dispose 共享资源。
- 每帧：`moveBody(world, this, dt)` 做落地摩擦与碰撞（复用既有物理，不重写 AABB）；`position.y += sin(age*bobSpeed)*bobAmp`；`rotation.y += spin*dt`。
- 入水首次触发水花粒子 + 音效；出水恢复重力。掉出 y<0 立即移除。
- 拾取（仅 `mode==='playing'` 推进 age）：触发 `onPickup(name,count)` → `survival.addDrop()`；粒子 + `sound.click`。同类在 `spawn` 时先尝试 0.8 格内合并（上限 999）。
- 创造模式不产生掉落物：由调用方检查 `survival.isSurvival`（`collectDrops` 已有该守卫；`entities.onDrop` 接线处需补）。
- `clear()` 在 `newWorld` / 返回标题 / 死亡重生时调用。

**接线点**
- `player.collectDrops()`：由 `survival.addDrop` 改为 `dropManager.spawn(...)`；`bonus`/堆肥收取等纯 UI 结算仍直接 `addDrop`。
- `EntityManager.kill()`：`onDrop` 保持签名，主装配 `main.ts:777` 改为 `dropManager.spawn(name,count,e.pos...)`（需要把坐标带出，签名改为 `(name,count,x,y,z)`）。
- `falling.onPlantDrop` 已走 `player.collectDrops`，自动接入。

### 6.5 煤炭 / 火把 / 配方

- `CRAFTING_RECIPES` 新增 1 条：`pattern: ['C','S']`, `key: { C:'item:coal', S:'item:stick' }`, `result: { material:'torch', count:4 }`。1×2 竖排，2×2 个人合成格放得下。
- 火把方块定义不变（`lightEmission=14`，放置要求下方实心）；`setBlock` 会自动重建方块光，无需额外接线。
- 熔炉（id=119）本轮保持占位不动，不做烧炼。

### 6.6 接线点汇总

| 文件 | 改动 |
|---|---|
| `src/core/tuning.ts` | 新建（全部数值） |
| `src/world/dropLogic.ts` | 新建（纯逻辑） |
| `src/entity/droppedItem.ts` | 新建（渲染 + DropManager） |
| `src/entity/breeding.ts` | 新建（繁殖规则） |
| `src/entity/entity.ts` | 新动物注册、weight 加权生成、繁殖状态字段、喂食/繁殖接线 |
| `src/entity/models.ts` | 3 个新模型 |
| `src/player/player.ts` | `collectDrops` 改 spawn；`useSelected` 加喂食分支 |
| `src/player/survival.ts` | `ITEMS` 加 6 项 |
| `src/player/crafting.ts` | 加火把配方 |
| `src/gfx/atlas.ts` | 末尾追加 6 个 painter |
| `src/world/blocks.ts` | `coal_ore.drops` 改煤炭 |
| `src/main.ts` | DropManager 构造/接线/clear；`entities.onDrop` 带坐标 |
| `package.json` / `scripts/build-test-snapshot.mjs` / `docs/agent/validate.py` | 测试入口 / entries / CHECKS |

---

## 7. 存档与生命周期

- 掉落物**不进存档**：`SaveData` 不加字段；`newWorld` / 返回标题 / 重生时 `dropManager.clear()`。
- 繁殖状态（age/loveTimer/cooldown）也不进存档：读档后全部按成体处理（age=growTime），符合"临时状态"定位。
- 世界种子不变；**掉落散开**与**新加权类型抽取**的可复现性由 `dropHash(seed, source, index)` 保证（参数来源见 §3 与 §6.4）；既有实体 AI 的随机游荡 / 生成坐标仍为 `Math.random()`，不承诺跨会话复现，本轮不动。

## 8. 测试与验收

**新增测试组 `test:drop`**（`test/drop-check.cjs`，require 快照 `./logic/world/dropLogic.js`）：
- `scatterOffset` 同 seed+source 可复现；
- `canPickup` 半径 / 延迟边界；
- `mergeKey` 同键近距离合并、异键不合并；
- `shouldDespawn` 超时与 y<0；
- `advanceWater` 终端下沉与水平衰减；
- 新动物 `BREED_FOODS` 命中 / 未命中、权重和、上限数值。

**既有测试的同步**：
- `test/terrain-system-check.cjs`：方块总数仍 141（原基线；合并 v1.7.0 内容植物扩充后为 152）（不动），新增 `coal_ore.drops === item:coal` 断言。
- `test/crafting-check.cjs`：结构已覆盖新配方，补一条"火把配方可合成 + 材料组"断言。
- `test/botany-rules-check.cjs`：方块总数断言不动。
- `package.json`：加 `"test:drop"`，并在 `verify` 链 `test:snapshot` 之后追加 `&& npm run test:drop`。
- `scripts/build-test-snapshot.mjs`：entries 加 `src/world/dropLogic.ts`（必要时加 `src/core/tuning.ts` 与 `src/entity/breeding.ts` 的纯逻辑部分）。
- `docs/agent/validate.py`：CHECKS 新增本轮关键词（见任务卡 C00）。

**回归门**：`npm run typecheck && npm run test:snapshot && npm run test:drop && npm run test:crafting && npm run test:terrain-system && npm run verify`（最终 verify 100% PASS）。

## 9. 任务卡草案（C00 → C05）

> 每张卡 outputs 关键词对应 C00 将加入 `validate.py` 的 CHECK。

### C00 校验器扩展 + 设计落地
```yaml
id: C00
title: 内容体系契约校验器扩展
description: docs/agent/validate.py 为本轮 outputs 补机械检查；写入设计文档；分两阶段（A 关键词存在 / B 随实现卡收紧为符号真实存在）。
touch: { allow: [docs/agent/validate.py, docs/agent/tasks/C0*.yaml, docs/superpowers/specs/2026-11-21-content-system-design.md], deny: [src/**, test/**] }
outputs:
  - tuning center: tuning.ts 存在且导出 BREED_FOODS / DROPS / POPULATION
  - drop system: dropLogic.ts 与 droppedItem.ts 存在且 DropManager 暴露 spawn/update/clear
  - animal breeding: entity.ts 含五种被动且 breeding.ts 含 isBreedFood
  - coal torch: 煤矿石掉落 item:coal 且配方表含 torch
  - test:drop: package.json 声明 test:drop 且 verify 链包含它
  - 任务卡校验器: CHECKS 覆盖上述五个关键词
```

### C01 数值中心 + 物品 / 纹理 / 煤炭火把
```yaml
id: C01
title: tuning.ts 与煤炭火把闭环
description: 新建 tuning.ts（既有值原样搬入）；ITEMS 加 6 项 + 图集末尾 6 个 painter；coal_ore.drops 改 item:coal；加火把配方（煤+棍→4）。
touch: { allow: [src/core/tuning.ts, src/player/survival.ts, src/player/crafting.ts, src/gfx/atlas.ts, src/world/blocks.ts, test/terrain-system-check.cjs, test/crafting-check.cjs, docs/TESTING.md], deny: [src/world/mesher.ts] }
outputs:
  - tuning center: 既有数值原样、新数值集中，test:crafting 与 test:terrain-system 全绿
  - coal torch: 煤矿石掉煤炭、火把配方可合成
```

### C02 动物扩充 + 生成权重
```yaml
id: C02
title: 三种新动物与按权重生成
description: models.ts 增 buildCow/buildChicken/buildRabbit；EntityManager 注册三种动物；trySpawnNear 改为按 weight 加权抽取（激活 dead code）；cap 约束自然生成。
touch: { allow: [src/entity/models.ts, src/entity/entity.ts, src/core/tuning.ts, test/logic-check.cjs, docs/TESTING.md], deny: [src/world/mesher.ts] }
outputs:
  - animal breeding: 五种被动动物注册完成且生成按权重确定
  - verify: npm run typecheck && npm run test:snapshot && npm run test:logic 全绿
```

### C03 繁殖系统
```yaml
id: C03
title: 喂食 / 求爱 / 幼崽 / 上限
description: breeding.ts 规则 + Entity 三状态字段 + 幼崽缩放修正 + useSelected 喂食分支 + 心形粒子 + 全局上限 24。喂错静默。
touch: { allow: [src/entity/breeding.ts, src/entity/entity.ts, src/player/player.ts, src/core/tuning.ts, src/main.ts, test/logic-check.cjs, docs/TESTING.md], deny: [src/save/save.ts] }
outputs:
  - animal breeding: 两只喂食后可繁殖、幼崽成长、冷却与上限可测
  - verify: npm run typecheck && npm run test:snapshot && npm run test:logic 全绿
```

### C04 掉落物系统
```yaml
id: C04
title: 可见悬浮掉落物
description: dropLogic.ts 纯逻辑 + droppedItem.ts 渲染与 DropManager；接入 player.collectDrops / entities.onDrop / falling；入水水花与缓慢下沉、拾取反馈、合并、消失、clear。
touch: { allow: [src/world/dropLogic.ts, src/entity/droppedItem.ts, src/player/player.ts, src/entity/entity.ts, src/main.ts, src/core/tuning.ts, test/drop-check.cjs, scripts/build-test-snapshot.mjs, package.json, docs/TESTING.md], deny: [src/world/mesher.ts, src/save/save.ts] }
outputs:
  - drop system: 掉落物可见、可拾取、入水缓慢下沉、超时消失、不进存档
  - test:drop: 六组纯逻辑断言全绿，verify 链包含 test:drop
```

### C05 收尾 / 诊断 / 版本 bump
```yaml
id: C05
title: 收尾与版本收敛
description: 补运行时诊断计数（可选）、文档同步（ARCHITECTURE/EXPERIENCE/RUNBOOK/README/CHANGELOG）、VERSION bump 一次、python3 docs/agent/validate.py --strict 0 FAIL/WARN、npm run verify 100% PASS。
touch: { allow: [src/diagnostics/RuntimeDiagnostics.ts, src/core/version.ts, package.json, README.md, CHANGELOG.md, docs/ARCHITECTURE.md, docs/PROJECT-EXPERIENCE.md, docs/agent/RUNBOOK.md, docs/TESTING.md, docs/agent/validate.py], deny: [src/world/mesher.ts, src/gfx/**] }
outputs:
  - verify: npm run verify 100% PASS 且 validate.py --strict 0 FAIL/WARN
```

---

## 10. 执行顺序与回归门

```
C00（两阶段收紧）
  ↓
C01 数值/物品/煤炭火把 → typecheck, snapshot, test:crafting, test:terrain-system
  ↓
C02 动物/权重         → + test:logic
  ↓
C03 繁殖              → + test:logic
  ↓
C04 掉落物            → + test:drop
  ↓
C05 收尾 bump         → npm run verify（100% PASS）
```

每卡：改前 `typecheck` 基线干净；改后先红后绿，green 之后不改测试迁就实现；提交信息写"改了什么/为什么"。合并纪律沿用 RUNBOOK：一次一 PR、合完立刻 verify、WIP 不上 main、版本只在 C05 bump。

## 11. 验收清单（跨卡）

- [ ] `tuning.ts` 既有数值逐项与原源码一致（可用 diff 或断言核对），新数值全部来自本文。
- [ ] 方块总数仍 141（原基线；合并 v1.7.0 内容植物扩充后为 152），图集既有 tile 索引不变，`validate.py --strict` 0 FAIL/WARN。
- [ ] 煤矿石掉 `item:coal`；煤炭+木棍可合成 4 火把；火把光正常传播。
- [ ] 五种被动动物均可繁殖；喂错材料静默；求爱/冷却/成长/上限数值与 `tuning.ts` 一致；幼崽受击不变大。
- [ ] 掉落物可见、浮动自转、可拾取、可合并、限时消失、入水缓慢下沉、掉出世界消失、不进存档；散开与加权抽取可复现、无新增 `Math.random`（既有 AI 游荡/生成坐标的 `Math.random()` 不在本轮）；新动物掉落名全部带 `item:` 前缀、与既有物品可合并。
- [ ] `test:drop` 纳入 `verify`；`npm run verify` 100% PASS。
- [ ] 未触碰 mesher/worker/快照缓冲；未新增运行时依赖；未新增方块 id。

## 12. 明确不做 / 后续

- **熔炉 / 烧炼 / 燃料**：用户"明日再议"，本轮保持 id=119 占位。
- **驯服 / 骑乘 / 品种差异 / 自动农场**：非目标。
- **掉落物存档**：本轮明确不持久化。
- **画面受控实验**：心形粒子/水花属于既有粒子系统的颜色复用，若后续要改视觉表现再走 `EXPERIMENTS.md` 流程。
- **繁殖数值平衡**：`tuning.ts` 给出默认值，上线后可用数值实验卡调整，不阻塞本轮。

## 13. 留给 builder 的决定（已声明为调用，不阻塞）

- 繁殖幼崽生成点的合法性检查复用 `trySpawnNear` 的地面判定（草方块 + 上方空气 + `h>31`），若中点不合法则退回父方附近一格。
- 掉落物几何缓存键用材料标识统一串；`makeBlockGeometry` 与 `makeItemGeometry` 的选取按 `materialToStack` 的 kind 判定。
- F3 诊断是否显示掉落物数量为可选增强；若加，随 C05 一并做，不单独开卡。
- 心形粒子/水花的具体颜色值由 builder 按现有粒子 API 选一个协调值，不改变行为契约。
