# 内容体系完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Minecraft TS 接上内容产出闭环：煤炭/火把配方、5 种可繁殖被动动物、可见悬浮掉落物，并把所有数值集中到 `tuning.ts`。

**Architecture:** 新增 4 个深模块——`tuning.ts`（唯一数值源）、`dropLogic.ts`（确定性掉落纯逻辑）、`droppedItem.ts`（渲染 + DropManager）、`breeding.ts`（繁殖规则）。现有模块只做薄增：实体注册/喂食钩子/接线。不新增方块 id、不新增运行时依赖、不碰 mesher/worker/存档 schema。

**Tech Stack:** TypeScript 5.6 + three.js 0.170（唯一运行时依赖）；测试为手写 CJS 断言脚本 + tsc 现场编译快照。

**Spec:** `docs/archive/2026-11/superpowers/specs/2026-11-21-content-system-design.md`（与本文同目录树，执行者必须同时阅读）

## Global Constraints

- 方块总数 **141（原基线；合并 v1.7.0 内容植物扩充后为 152）**、id 到 **147**；**本轮不新增方块**，两处断言 `test/terrain-system-check.cjs:96` 与 `:522` 不动。
- 图集 16×16=256 槽；新 painter **只能追加在 `atlas.ts` 既有 painter 之后**（`composter_bottom` 之后），既有 tile 索引不变。
- 新物品掉落名**一律 `item:` 前缀**（与 `item:porkchop` 同口径），否则世界掉落物无法与既有物品合并。
- 随机性：新增散开/加权抽取走 `dropHash(seed, source, index)`，**禁止新增 `Math.random()`**；既有实体 AI 游荡/生成坐标的 `Math.random()` 属技术债，本轮不动。
- `seed` 从 `main.ts` 注入 `DropManager` 构造（= `world.generator.seed`）；`source` 为 `b:x,y,z` / `e:id:serial`，直接 spawn 回退 `d:x,y,z`；`index` = 同次 roll 内材料下标 + manager 内 `spawnSerial`。
- 生成层无 DOM；`tuning.ts` / `dropLogic.ts` / `breeding.ts` 不得 import three / DOM。
- 不新增运行时依赖；唯一依赖仍为 three。
- 版本只在 Task 6 bump 一次；提交信息写"改了什么/为什么"，不要只写 `update`。
- 每卡：改前 `npm run typecheck` 基线干净；改后 `npm run test:snapshot` → 相关 `test:*` → 最终 `npm run verify`。

## Review Focus

- **旧存档与方块 id 漂移**：任何新增方块 id 或重排都会让旧档 `edits` 指向错方块 → Task 2 的 `test:terrain-system` 明确断言总数仍 141（原基线；合并 v1.7.0 内容植物扩充后为 152）、`coal_ore` 仍在原 id。
- **掉落物合并口径**：新动物掉落若漏 `item:` 前缀，牛皮革与既有物品变两种 `mergeKey`、永远不堆叠 → Task 2 断言掉落名前缀，Task 5 断言同类合并/异类不合并。
- **幼崽受击缩放**：`hurt()` 写 `scale=1.14`、`update()` 衰减到 1，幼崽若直接写死 1 会受一次击就变大 → Task 4 断言幼崽受击后目标缩放仍为 `babyScale × 闪光系数`。
- **入水/出水与边界**：水花只在入水首次触发、出水恢复重力、`y<0` 立即消失，错一处就会反复播音效或掉落物穿地 → Task 5 的 `test:drop` 逐项断言。
- **暂停计时**：暂停/标题/死亡时掉落物不应消失；dt 已被 0.05 钳制，不能靠帧累积绕过 → Task 5 断言 `playing=false` 时 `age` 不增长。

---

### Task 1: C00 校验器扩展 + 任务卡落地

**Files:**
- Modify: `docs/agent/validate.py`
- Create: `docs/agent/tasks/C00.yaml` … `C05.yaml`（6 张）
- Spec already landed: `docs/archive/2026-11/superpowers/specs/2026-11-21-content-system-design.md`

**Interfaces:**
- Produces: `validate.py` CHECKS 新增 5 个关键词：`tuning center` / `drop system` / `animal breeding` / `coal torch` / `test:drop`。阶段 A 的谓词只检查关键词出现在任务卡文本中；Tasks 2–5 各自收紧为真实符号检查。

- [ ] **Step 1: 写阶段 A 的 CHECKS**

在 `CHECKS` 列表末尾追加 5 项，谓词形如 `all(k in read(f"docs/agent/tasks/{n}.yaml") for n in ...)`，使当前 `--strict` 不产生 WARN/FAIL。每张卡的 `outputs` 行必须包含对应关键词（C05 用既有 `verify` 关键词）。

- [ ] **Step 2: 写 6 张任务卡**

按 spec §9 的 id / title / description / touch / outputs 原样落盘；`outputs` 文本严格使用 Global Constraints 中的关键词，不要自创同义词。

- [ ] **Step 3: 验证阶段 A**

Run: `python3 docs/agent/validate.py --strict`
Expected: `0 FAIL / 0 WARN`，exit 0。

- [ ] **Step 4: Commit**

```bash
git add docs/agent/validate.py docs/agent/tasks/C0*.yaml docs/archive/2026-11/superpowers/specs/2026-11-21-content-system-design.md
git commit -m "docs(content): 落地内容体系设计与任务卡，扩展契约校验器"
```

---

### Task 2: C01 数值中心 + 物品 / 纹理 / 煤炭火把闭环

**Files:**
- Create: `src/core/tuning.ts`
- Modify: `src/player/survival.ts`, `src/gfx/atlas.ts`, `src/world/blocks.ts`, `src/player/crafting.ts`
- Test: `test/terrain-system-check.cjs`, `test/crafting-check.cjs`, `docs/agent/validate.py`, `docs/TESTING.md`

**Interfaces:**
- Consumes: `rollDrops` / `BlockRegistry.byNameGet`（既有）；`CRAFTING_RECIPES`（既有）。
- Produces: `tuning.ts` 导出 `POPULATION`、`BREED`、`DROPS`、`BREED_FOODS`、`ANIMALS`、`NEW_ITEMS`；`ITEMS` 新增 `coal/leather/beef/feather/egg/rabbit_meat`；火把配方 id `torch_fuel`。

- [ ] **Step 1: 写失败断言**

在 `test/terrain-system-check.cjs` 末尾追加：
```js
ok('煤矿石掉落煤炭（item:coal，1~2）',
  reg.byNameGet('coal_ore').drops.length === 1 &&
  reg.byNameGet('coal_ore').drops[0].name === 'item:coal' &&
  reg.byNameGet('coal_ore').drops[0].min === 1 &&
  reg.byNameGet('coal_ore').drops[0].max === 2);
ok('方块总数 152（141 基线 + 内容植物扩充 11）', reg.all().length === 152);
```
在 `test/crafting-check.cjs` 末尾追加：
```js
ok('煤炭+木棍可合成 4 火把', (() => {
  const r = CRAFTING_RECIPES.find((x) => x.id === 'torch_fuel');
  return !!r && r.result.material === 'torch' && r.result.count === 4 &&
    r.pattern.join('') === 'CS' && r.key.C === 'item:coal' && r.key.S === 'item:stick';
})());
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:snapshot && npm run test:terrain-system && npm run test:crafting`
Expected: FAIL（煤矿石掉落与火把配方尚未改动）。

- [ ] **Step 3: 建 `tuning.ts`**

按 spec §6.1 导出 6 个常量；`DROPS` 全部值取自 `DROPS` 表；`NEW_ITEMS` 中 `beef=7 / rabbit_meat=5 / egg=3`，`coal/leather/feather` 无 `food`。既有数值（种群 6/9/4 等）原样搬入，不得改动。`ANIMALS` 先写牛/鸡/兔三项，猪/羊数值随后在 Task 3 补齐（本任务只要求新动物条目存在）。

- [ ] **Step 4: 接入物品 / 纹理 / 方块 / 配方**

`survival.ts`：`ITEMS` 加 6 项，`tile` 与键名同名，`food` 取 `NEW_ITEMS`。
`atlas.ts`：在 `this.painters.set('composter_bottom', ...)` 之后追加 6 个 painter（`coal/leather/beef/feather/egg/rabbit_meat`），风格沿用程序化像素、16×16。
`blocks.ts`：`coal_ore` 的 `drops` 改为 `[{ name: 'item:coal', min: 1, max: 2 }]`。
`crafting.ts`：在 `CRAFTING_RECIPES` 末尾追加 spec §6.5 的火把配方（id `torch_fuel`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run typecheck && npm run test:snapshot && npm run test:terrain-system && npm run test:crafting`
Expected: 全 PASS，方块总数断言仍 141（原基线；合并 v1.7.0 内容植物扩充后为 152）。

- [ ] **Step 6: 收紧校验器关键词**

把 `tuning center` 谓词改为检查 `src/core/tuning.ts` 含 `export const BREED_FOODS` / `export const DROPS` / `export const POPULATION`；把 `coal torch` 改为检查 `blocks.ts` 含 `item:coal` 且 `crafting.ts` 含 `material: 'torch'`。
Run: `python3 docs/agent/validate.py --strict` → 0 FAIL / 0 WARN。

- [ ] **Step 7: Commit**

```bash
git add src/core/tuning.ts src/player/survival.ts src/gfx/atlas.ts src/world/blocks.ts src/player/crafting.ts test/terrain-system-check.cjs test/crafting-check.cjs docs/agent/validate.py docs/TESTING.md
git commit -m "feat(content): 集中数值并打通煤矿石→煤炭→火把闭环"
```

---

### Task 3: C02 三种新动物 + 按权重生成

**Files:**
- Modify: `src/entity/models.ts`, `src/entity/entity.ts`, `src/core/tuning.ts`
- Test: `test/terrain-system-check.cjs`

**Interfaces:**
- Consumes: `ANIMALS`（Task 2）、`BlockRegistry`（既有）。
- Produces: `buildCow / buildChicken / buildRabbit` from `models.ts`；`EntityManager` 注册 id `cow/chicken/rabbit`；`trySpawnNear` 按 weight 加权抽取（用 `dropHash`）。

- [ ] **Step 1: 写失败断言**

在 `test/terrain-system-check.cjs` 末尾追加：
```js
ok('五种被动动物全部注册', ['pig','sheep','cow','chicken','rabbit']
  .every((id) => !!mobs.getType(id)));
ok('新动物掉落名带 item: 前缀',
  ['cow','chicken','rabbit'].every((id) =>
    mobs.getType(id).drops.every((d) => d.name.startsWith('item:'))));
```
（`mobs` 复用该文件已有的 `EntityManager` 实例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:snapshot && npm run test:terrain-system`
Expected: FAIL（新动物未注册）。

- [ ] **Step 3: 补模型与注册**

`models.ts` 增 `buildCow / buildChicken / buildRabbit`，复用 `box/limb` 与既有 `animate` 形态；`entity.ts` 按 `ANIMALS` 注册三种类型，drops 用 `item:` 前缀。

- [ ] **Step 4: 激活 weight**

`trySpawnNear()` 的 `typeId ?? (Math.random() < 0.55 ? 'pig' : 'sheep')` 改为：`typeId` 优先；否则用 `dropHash(this.seed, 'spawn:' + this.spawnSerial++, 0) / 2^32` 在被动动物权重表上择一。EntityManager 增 `private spawnSerial = 0`。生成坐标与游荡仍用既有 `Math.random()`（不要改）。`POPULATION.cap` 同时约束自然生成。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run typecheck && npm run test:snapshot && npm run test:terrain-system`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/entity/models.ts src/entity/entity.ts src/core/tuning.ts test/terrain-system-check.cjs
git commit -m "feat(content): 新增牛鸡兔并激活按权重生成"
```

---

### Task 4: C03 繁殖系统

**Files:**
- Create: `src/entity/breeding.ts`
- Modify: `src/entity/entity.ts`, `src/player/player.ts`, `src/main.ts`
- Test: `test/terrain-system-check.cjs`, `docs/agent/validate.py`

**Interfaces:**
- Consumes: `BREED_FOODS` / `BREED` / `POPULATION`（Task 2），`entityTarget`（`player.ts:432`）。
- Produces: `isBreedFood(typeId, material): boolean`；`pickMate(self, others, radius): candidate | null`；`canBreed(a, b): boolean`；`Entity` 增 `age / loveTimer / cooldown` 字段与 `baby` getter；`EntityManager.feed(e, material): boolean`。

- [ ] **Step 1: 写失败断言**

在 `test/terrain-system-check.cjs` 末尾追加：
```js
ok('兔子吃蒲公英与所有花朵，不吃煤炭',
  isBreedFood('rabbit', 'dandelion') && isBreedFood('rabbit', 'poppy') &&
  !isBreedFood('rabbit', 'item:coal'));
ok('牛吃小麦不吃种子',
  isBreedFood('cow', 'wheat') && !isBreedFood('cow', 'item:wheat_seeds'));
```
另加幼崽缩放断言：喂两只成体后生成幼崽，`hurt(1)` 后 `model.group.scale.x` 不得回到 1（应≈`babyScale`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:snapshot && npm run test:terrain-system`
Expected: FAIL（`breeding.ts` 尚未创建）。

- [ ] **Step 3: 实现 `breeding.ts`**

按 spec §6.3 写纯函数：`isBreedFood` 查 `BREED_FOODS`；`pickMate` 在 `mateRadius` 内按实体 id 升序选第一个 `loveTimer>0 && cooldown<=0 && !baby` 的同类；`canBreed` 要求双方成体、均处于求爱、冷却结束。

- [ ] **Step 4: Entity 状态与缩放**

`Entity` 增 `age`（成体初始 = `BREED.growTime`）、`loveTimer=0`、`cooldown=0`、`get baby()`。`update()` 中：非 playing 不推进这些计时（由 EntityManager 传 `playing`）；`age += dt`；`loveTimer/cooldown` 递减；目标缩放 = `(baby ? BREED.babyScale : 1) * (受击闪光中 ? 1.14 : 1)`，**替换**现有写死 1 的衰减逻辑，避免幼崽受击变大。

- [ ] **Step 5: 喂食与繁殖接线**

`player.ts` 的 `useSelected()` 在 `tryCompost()` 之后插入：若 `entityTarget` 为可繁殖成体且手持材料命中 `isBreedFood(typeId, material)` → `entities.feed(target, material)`、消耗 1 个并返回；喂错静默走原流程。
`EntityManager.feed()`：设 `loveTimer=BREED.loveDuration`；`updateBreeding(dt)`：求爱双方靠近 → 在中点附近合法地面生成幼崽（复用 `trySpawnNear` 的草方块判定，不合法退回父方附近一格），双亲 `cooldown=BREED.cooldown`；全局 `POPULATION.cap` 满时拒绝并静默。求爱期间复用 `particles.burst` 发粉色心形粒子（颜色由 builder 选协调值）。`main.ts` 把粒子实例传给 EntityManager 或走既有事件通道。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run typecheck && npm run test:snapshot && npm run test:terrain-system`
Expected: 全 PASS，幼崽受击缩放断言通过。

- [ ] **Step 7: 收紧校验器并 Commit**

把 `animal breeding` 谓词改为检查 `breeding.ts` 含 `export function isBreedFood` 且 `entity.ts` 含 `'cow'` / `'chicken'` / `'rabbit'`。
```bash
git add src/entity/breeding.ts src/entity/entity.ts src/player/player.ts src/main.ts test/terrain-system-check.cjs docs/agent/validate.py
git commit -m "feat(content): 五种被动动物可繁殖，含幼崽成长与求爱反馈"
```

---

### Task 5: C04 可见悬浮掉落物

**Files:**
- Create: `src/world/dropLogic.ts`, `src/entity/droppedItem.ts`, `test/drop-check.cjs`
- Modify: `src/player/player.ts`, `src/entity/entity.ts`, `src/main.ts`, `src/core/tuning.ts`（如需补值）, `scripts/build-test-snapshot.mjs`, `package.json`, `docs/agent/validate.py`, `docs/TESTING.md`

**Interfaces:**
- Consumes: `DROPS`（Task 2）、`dropHash`（既有）、`atlas.makeItemGeometry/makeBlockGeometry`（既有）、`moveBody`（既有）。
- Produces:
  - `dropLogic.ts`: `scatterOffset(seed, source, index): {dx,dz,vx,vz,vy}`；`canPickup(drop, playerPos): boolean`；`mergeKey(name, count): string`；`dropsMerge(a, b): boolean`；`shouldDespawn(drop): boolean`；`advanceWater(vel, dt, inWater): {vx,vy,vz}`。
  - `droppedItem.ts`: `class DroppedItem`；`class DropManager` 构造 `{ scene, atlas, seed, world, onPickup }`，方法 `spawn(name,count,x,y,z,source)`、`update(dt, playerPos, playing)`、`clear()`、`readonly items`。
  - `Player.dropManager: DropManager | null`；`EntityManager.onDrop` 签名改为 `(name,count,x,y,z,source) => void`。

- [ ] **Step 1: 写 `test/drop-check.cjs` 的全部失败断言**

纯逻辑，require `./logic/world/dropLogic.js`；覆盖 Review Focus 四项 + spec §8 六组：
```js
ok('同 seed+source+index 散开可复现',
  deepEqual(scatterOffset(7,'b:1,2,3',0), scatterOffset(7,'b:1,2,3',0)));
ok('拾取半径与延迟边界', canPickup({x:0,y:0,z:0,age:0.4},{x:1.19,y:0,z:0}) &&
  !canPickup({x:0,y:0,z:0,age:0.39},{x:1.19,y:0,z:0}) &&
  !canPickup({x:0,y:0,z:0,age:1},{x:1.21,y:0,z:0}));
ok('同类合并异类不合并', mergeKey('item:beef',2) === mergeKey('item:beef',3) &&
  mergeKey('item:beef',2) !== mergeKey('item:porkchop',2));
ok('超时与掉出世界消失', shouldDespawn({age:300,y:5}) && shouldDespawn({age:1,y:-1}) &&
  !shouldDespawn({age:299,y:5}));
ok('入水终端下沉与水平衰减', advanceWater({vx:1,vy:-20,vz:0},0.05,true).vy === -DROPS.waterSink);
ok('出水恢复重力', advanceWater({vx:1,vy:-0.6,vz:0},0.05,false).vy < -0.6);
```
并补一条"暂停不推进 age"：在 `DropManager.update(dt, pos, false)` 后 items[0].age 不变。

- [ ] **Step 2: 跑测试确认失败**

在 `package.json` 加 `"test:drop"` 脚本、把 `src/world/dropLogic.ts` 加进 `scripts/build-test-snapshot.mjs` 的 entries。
Run: `npm run test:snapshot && npm run test:drop`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `dropLogic.ts`**

纯函数，不得 import three/DOM；散开/抽取一律 `dropHash`。`advanceWater` 入水返回 `vy=-waterSink` 且水平速度乘 `exp(-8*dt)`；出水返回 `vy -= 24*dt`（不 clamp，交回 `moveBody` 处理落地）。

- [ ] **Step 4: 实现 `droppedItem.ts`**

`DropManager` 构造注入 seed/scene/atlas/world/onPickup；`spawn` 按 `scatterOffset` 给初速，先尝试 0.8 格内 `dropsMerge` 合并（上限 999）；几何按材料键缓存（block 用 `makeBlockGeometry`，item 用 `makeItemGeometry`），共享 `MeshBasicMaterial({ map: atlas.texture, vertexColors:true, alphaTest:0.5, side:DoubleSide })`。
`update`：仅 `playing` 时推进 `age`；`moveBody(world, item, dt)` 碰撞；浮动 + 自转；入水首次触发一次水花粒子 + 点击音效（`wasInWater` 去抖）；`canPickup` 命中 → `onPickup(name,count)` + 粒子 + `sound.click`；`shouldDespawn` 命中 → `scene.remove`，不 dispose 共享资源。`clear()` 移除全部。

- [ ] **Step 5: 接线**

`player.ts`：`collectDrops()` 把 `survival.addDrop` 改为 `this.dropManager?.spawn(name,count,x,y,z,source)`；`bonus`/堆肥收取仍直接 `addDrop`。
`entity.ts`：`kill()` 的 `onDrop` 调用改为携带 `e.pos.x/y/z` 与 `e:id:serial` 来源串。
`main.ts`：构造 `DropManager`（seed = `world.generator.seed`）；`entities.onDrop` 在 `survival.isSurvival` 守卫下调 `drops.spawn(...)`；`player.dropManager = drops`；`startGame`/`newWorld`/返回标题/重生时 `drops.clear()`。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run typecheck && npm run test:snapshot && npm run test:drop && npm run test:logic && npm run test:terrain-system`
Expected: 全 PASS。

- [ ] **Step 7: 收紧校验器并 Commit**

`drop system` 谓词改为检查 `dropLogic.ts` 含 `export function scatterOffset` 且 `droppedItem.ts` 含 `export class DropManager`；`test:drop` 谓词改为检查脚本存在且 `verify` 链包含 `npm run test:drop`。
```bash
git add src/world/dropLogic.ts src/entity/droppedItem.ts test/drop-check.cjs src/player/player.ts src/entity/entity.ts src/main.ts scripts/build-test-snapshot.mjs package.json docs/agent/validate.py docs/TESTING.md
git commit -m "feat(content): 可见悬浮掉落物，确定性散开与拾取合并"
```

---

### Task 6: C05 收尾 / 诊断 / 版本 bump

**Files:**
- Modify: `src/core/version.ts`, `package.json`, `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/PROJECT-EXPERIENCE.md`, `docs/agent/RUNBOOK.md`, `docs/TESTING.md`（可选：`src/diagnostics/RuntimeDiagnostics.ts` + `test/diagnostics-check.cjs`）

**Interfaces:**
- Consumes: 前 5 个 Task 的全部产出。

- [ ] **Step 1: 同步文档**

`README.md` / `CHANGELOG.md` 说明新动物、繁殖、掉落物、煤炭火把；`ARCHITECTURE.md` / `PROJECT-EXPERIENCE.md` / `RUNBOOK.md` / `TESTING.md` 补 4 个新模块、新测试组、确定性范围澄清（只管掉落）、图集末尾追加纪律。

- [ ] **Step 2: 可选诊断计数**

若加 F3 掉落物计数：在 `RuntimeDiagnostics.ts` 加只读计数，并在 `test/diagnostics-check.cjs` 补一条注入式回归（硬规则 13）。不扩展则跳过本步，不单独开卡。

- [ ] **Step 3: 版本 bump（唯一一次）**

`src/core/version.ts` 的 `VERSION` 从 `1.5.2-beta.1` 推进到下一个 beta；`package.json` 同步；确认 README/CHANGELOG 与之自洽。`RELEASE` 不动。

- [ ] **Step 4: 全量验收**

Run: `npm run verify && python3 docs/agent/validate.py --strict`
Expected: `verify` 100% PASS；`validate.py --strict` 0 FAIL / 0 WARN。

- [ ] **Step 5: Commit**

```bash
git add src/core/version.ts package.json README.md CHANGELOG.md docs/ARCHITECTURE.md docs/PROJECT-EXPERIENCE.md docs/agent/RUNBOOK.md docs/TESTING.md
git commit -m "release(content): 内容体系完善收敛并全量验收"
```

---

## Self-Review

- **Spec coverage**：§6.1 tuning（T2）、§6.2 物品纹理与煤矿石（T2）、§6.3 动物与繁殖（T3/T4）、§6.4 掉落物（T5）、§6.5 配方（T2）、§6.6 接线（T3/T4/T5）、§7 存档不持久化（T5 接线 + 验收清单）、§8 测试（T2/T5）、§9 任务卡（T1）、§11 验收清单（T6）——全覆盖，无悬空需求。
- **Step scan**：每个测试步骤给出具体断言值；每个实现步骤给出导出符号与文件；无"TBD/适当处理"；算法细节（散开哈希、入水衰减）在 spec 已定，未展开成代码誊写。
- **Type consistency**：`DropManager` 构造参数与 `spawn/update/clear` 在 T5 Interfaces 定义、`T5 Step 5` 接线一致；`onDrop` 签名在 T5 统一为 6 参；`EntityManager.feed` 在 T4 定义并使用；`isBreedFood` 在 T4 定义、T4 Step 1 测试、T4 Step 5 使用，名称一致。
- **Review Focus**：5 项均已映射到具体任务的测试步骤（T2 两项、T4 一项、T5 两项）。
- **Proportion**：plan 围绕 6 张任务卡与精确接口展开，未重复实现代码；与 spec 的篇幅比例合理。
