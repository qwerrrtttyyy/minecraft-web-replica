# AI 系统实施计划（行为树，A00–A09）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 minecraft-web-replica（minecraft-ts）实现一套数据驱动的行为树 AI 系统，使新增 AI 行为或新生物只需新增 JSON 配置与节点实现，无需修改现有 TS 代码；现有 4 种生物（猪/羊/僵尸/骷髅）迁移到行为树 JSON，行为与 v1.4.9 等价。

**Architecture:** 方案 A（数据驱动行为树）。节点基类 `Node`（`tick(ctx): NodeStatus`）+ 复合节点（Selector/Sequence/Parallel/RandomSelector）+ 装饰器（Inverter/Repeater/UntilFail/UntilSuccess）+ 条件节点 + 动作节点，全部通过注入的 `TickContext` 只读接口与世界交互，不 import three / World / DOM。`BehaviorTree.fromJSON` 编译 JSON 配置，`AIService` 作为 `core:ai-system` 插件注册，每帧批量更新并支持分帧；`AIComponent` 挂在 `Entity` 上。

**Tech Stack:** TypeScript（strict，tsc --noEmit 必须 0 error），Vite，运行时唯一依赖 three.js；确定性随机走 `mulberry32`（`src/core/types.ts`）；测试通过 `test:snapshot` 现场编译 CJS 快照，新增 `test:ai` 组挂进 `verify` 长链。

**Spec:** `docs/archive/2026-11/superpowers/specs/2026-11-21-ai-system-design.md`（已批准）

## Global Constraints

- 回归门固定为 `npm run typecheck && npm run test:snapshot && npm run test:ai && npm run test:logic && npm run verify`，提交命令与回归门放在同一条 `&&` 链，evidence 记录真实 exit code。
- 测试纪律：先红后绿；红了先确认"为什么红"；green 之后不改测试迁就实现。
- 范围锁：只改各任务卡 `touch.allow` 内的文件；不新增运行时依赖（唯一依赖仍为 three.js）。
- 确定性：所有随机性走 `mulberry32`，禁止 `Math.random`（既有 entity AI 游荡/生成坐标的 `Math.random()` 技术债不动）。
- 新纯逻辑源文件要进 `scripts/build-test-snapshot.mjs` 的 `entries`；新测试要在 `package.json` 加 `test:*` 并挂进 `verify` 长链。
- 工作流：改前 `npm run typecheck` 基线干净；改完 `npm run test:snapshot` → 相关 `test:*` → `npm run verify` 全绿。
- 方块 id 只追加、不调整；AI 系统不新增方块；图表 tile 不动。
- AI 节点不 import three / World / DOM；副作用经 `TickContext.events` / `TickContext.api` 发送，带插件权限检查。
- AI 状态不进存档；读档后所有 AIComponent 重置为初始状态。

## Review Focus

- JSON 配置非法格式（缺 root / 子节点缺 type / 未知节点类型）：`BehaviorTree.fromJSON` 必须抛错而非静默失败（A05）。
- 同一实体同一节点同一 label 的随机序列必须可复现（`mulberry32(hash(worldSeed, entityId, label))`，A01）。
- `can_reach` 寻路失败必须回退 `Failure`，不能阻塞帧或抛错（A03）。
- 动作节点修改世界（spawn/break/place/hurtPlayer）必须走 `TickContext.api` 权限检查，不得直接调用引擎内部（A04）。
- AIService `disable()` 后所有 AIComponent 停止 tick，`enable()` 后重新 attach 现有实体（A06/A07）。
- 现有 4 种生物行为与 v1.4.9 等价（A08 回归断言，test:logic 全绿）。
- 新生物只需新增 `EntityType` + 行为树 JSON，不改 AI 核心代码（A08 验收）。
- 分帧预算超时不阻塞渲染（A06 `update(dt)` 分帧逻辑）。

---

## File Structure

新建 / 修改文件清单（按任务卡归属）：

| 文件 | 职责 | 所属任务 |
|------|------|----------|
| `src/ai/Node.ts` | `NodeStatus` 枚举、`TickContext` 接口、抽象 `Node` 类 | A01 |
| `src/ai/Blackboard.ts` | 实体级键值黑板 `get/set/has/del` | A01 |
| `src/ai/AIContext.ts` | 注入容器接口（entity/world/playerPos/daylight/playerDead/rng/events/api/blackboard/dt） | A01 |
| `src/ai/composites.ts` | `Selector` / `Sequence` / `Parallel` / `RandomSelector` | A02 |
| `src/ai/decorators.ts` | `Inverter` / `Repeater` / `UntilFail` / `UntilSuccess` | A02 |
| `src/ai/Perception.ts` | 只读感知视图（canSee/canHear/distance/getNearby/getBlockAt/isUnderSky/isInWater/canReach） | A03 |
| `src/ai/conditions.ts` | 条件节点类（CanSeePlayer / DistanceLt / HealthPctLt / IsDay / IsNight / IsInWater / IsOnGround / HasTarget / TargetInRange / BlackboardEq / CanReach） | A03 |
| `src/ai/actions.ts` | 动作节点类（ChasePlayer / FleeFrom / AttackPlayer / Wander / LookAt / Wait / EmitEvent / SetBlackboard / SpawnEntity / BreakBlock / PlaceBlock / PlaySound） | A04 |
| `src/ai/BehaviorTree.ts` | JSON 编译器 `fromJSON`、`tick(dt)`、`reset()`、运行时树状态 | A05 |
| `src/ai/registry.ts` | `NodeRegistry.register/create` 节点工厂注册表 | A05 |
| `src/ai/AIComponent.ts` | 挂在 Entity 上的 `AIComponent { tree, blackboard, enabled }` | A06 |
| `src/ai/AIService.ts` | `AIService { registerType/attach/update/enable/disable/reloadConfig/dispose }`、分帧预算 | A06 |
| `src/ai/behaviors/pig.json` / `sheep.json` / `zombie.json` / `skeleton.json` | 四种生物行为树 JSON 配置 | A08 |
| `src/entity/entity.ts` | 新增 `aiComponent?: AIComponent` 字段，`update` 中委托 AI 决策 | A07 |
| `src/main.ts` | 构造 `AIService`，注册四种类型，主循环调 `aiService.update(dt)`，接线 spawn/despawn | A06/A07/A08 |
| `test/ai-check.cjs` | `test:ai` 纯逻辑测试（节点状态转换 / 条件 / 动作 / JSON 编译 / RNG 可复现 / 4 种生物等价） | A01–A05 |
| `test/logic-check.cjs` | 现有生物生成/死亡/行为等价回归（A08 新增断言） | A07/A08 |
| `scripts/build-test-snapshot.mjs` | `entries` 数组追加 `src/ai/*.ts` | A01–A05 |
| `package.json` | 新增 `"test:ai"` 脚本，挂进 `verify` 长链 | A01 |
| `docs/agent/validate.py` | `CHECKS` 新增 AI 系统关键词 | A00 |
| `docs/agent/tasks/A0*.yaml` | 九张任务卡 | A00–A09 |
| `docs/archive/2026-11/superpowers/specs/2026-11-21-ai-system-design.md` | 设计文档（已存在，A00 落地确认） | A00 |
| `src/core/version.ts` / `README.md` / `CHANGELOG.md` | 版本 bump 与文档同步 | A09 |
| `src/diagnostics/RuntimeDiagnostics.ts` | AI 实体数 / 运行中行为树数计数（可选） | A09 |

---

## 任务卡清单

以下按执行顺序 A00→A09 串行。每张卡包含：改前基线检查、修改文件、先红后绿测试断言、改后验证命令、预期 exit code。

### Task A00: AI 系统契约校验器 + 设计落地

**Files:**
- Create: `docs/agent/tasks/A00.yaml`
- Modify: `docs/agent/validate.py`（`CHECKS` 新增 AI 关键词）
- Modify: `docs/archive/2026-11/superpowers/specs/2026-11-21-ai-system-design.md`（确认定稿，落地到仓库）

**Interfaces:**
- Consumes: 设计文档已批准的内容
- Produces: `validate.py` 能机械检查 AI 系统关键词；`docs/agent/tasks/A00.yaml` 契约可被 `python3 docs/agent/validate.py` 校验

- [ ] **Step 1: 在 `validate.py` `CHECKS` 中追加 AI 系统关键词**

检查关键词：`ai core`、`ai composites`、`ai decorators`、`ai conditions`、`ai actions`、`ai tree`、`ai service`、`ai perception`、`entity integration`、`test:ai`、`任务卡校验器`。

- [ ] **Step 2: 创建 `docs/agent/tasks/A00.yaml`**

输出关键词对应 A00 段落，`touch.allow` 限定 `docs/agent/validate.py`、`docs/agent/tasks/A0*.yaml`、`docs/archive/2026-11/superpowers/specs/2026-11-21-ai-system-design.md`，`deny: [src/**, test/**]`。

- [ ] **Step 3: 运行校验器确认不报错**

Run: `python3 docs/agent/validate.py`
Expected: 0 FAIL/WARN，AI 关键词均被覆盖

- [ ] **Step 4: Commit**

```bash
git add docs/agent/validate.py docs/agent/tasks/A00.yaml docs/archive/2026-11/superpowers/specs/2026-11-21-ai-system-design.md
git commit -m "feat(ai): A00 契约校验器与设计文档落地"
```

**改前基线：** `python3 docs/agent/validate.py` 基线 0 FAIL/WARN。
**改后验证：** `python3 docs/agent/validate.py --strict` 0 FAIL/WARN。
**预期 exit code：** 0。

---

### Task A01: 节点基础（Node / Blackboard / TickContext / 确定性 RNG）

**Files:**
- Create: `src/ai/Node.ts`
- Create: `src/ai/Blackboard.ts`
- Create: `src/ai/AIContext.ts`
- Create: `test/ai-check.cjs`（先写失败测试）
- Modify: `scripts/build-test-snapshot.mjs`（entries 追加三个 TS 源文件）
- Modify: `package.json`（新增 `"test:ai"` 脚本）

**Interfaces:**
- Consumes: `src/core/types.ts` 的 `mulberry32(seed)`。
- Produces:
  - `enum NodeStatus { Running = 0, Success = 1, Failure = 2 }`
  - `interface TickContext { entity, world, playerPos, daylight, playerDead, rng, events, api, blackboard, dt }`
  - `abstract class Node { abstract tick(ctx: TickContext): NodeStatus; reset?(): void }`
  - `class Blackboard { get<T>(key): T; set(key, value): void; has(key): boolean; del(key): void }`
  - `TickContext.rng(label?)` 返回 0~1，底层 `mulberry32(hash(worldSeed, entityId, label))`

- [ ] **Step 1: 写失败测试（先红）**

在 `test/ai-check.cjs` 中写断言：
- `NodeStatus.Running === 0`, `NodeStatus.Success === 1`, `NodeStatus.Failure === 2`
- `Blackboard` set/get/has/del 正常，不存在键返回 undefined
- `TickContext.rng('a')` 与 `TickContext.rng('a')` 同 seed 可复现，不同 label 不同序列

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL（`src/ai/Node.ts` 等未定义，模块找不到）

- [ ] **Step 2: 实现 `src/ai/Node.ts` / `src/ai/Blackboard.ts` / `src/ai/AIContext.ts`**

`TickContext.rng` 内部用 `mulberry32`，种子由 `AIService` 在构造时注入 `worldSeed`，每个实体 `entityId` + `label` 做 hash。

- [ ] **Step 3: 运行测试通过（后绿）**

Run: `npm run test:snapshot && npm run test:ai`
Expected: PASS

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 0 error，exit code 0

- [ ] **Step 5: Commit**

```bash
git add src/ai/Node.ts src/ai/Blackboard.ts src/ai/AIContext.ts test/ai-check.cjs scripts/build-test-snapshot.mjs package.json
git commit -m "feat(ai): A01 节点基础与确定性 RNG"
```

**改前基线：** `npm run typecheck` 0 error；`test:ai` 不存在。
**改后验证：** `npm run test:snapshot && npm run test:ai && npm run typecheck` 全绿。
**预期 exit code：** 全部 0。

---

### Task A02: 复合节点与装饰器

**Files:**
- Create: `src/ai/composites.ts`
- Create: `src/ai/decorators.ts`
- Modify: `test/ai-check.cjs`（追加断言）

**Interfaces:**
- Consumes: `Node`、`NodeStatus`、`TickContext`（来自 A01）。
- Produces:
  - `class Selector extends Node`：子节点失败则下一个，成功即短路返回 Success；全部失败返回 Failure。
  - `class Sequence extends Node`：子节点失败即 Failure；全部成功返回 Success；Running 子节点下帧继续。
  - `class Parallel extends Node`：并发 tick 全部子节点，成功/失败计数达阈值返回对应状态。
  - `class RandomSelector extends Node`：按 `ctx.rng` 随机打乱子节点顺序后按 Selector 逻辑。
  - `class Inverter extends Node`：反转子节点 Success/Failure，Running 保持。
  - `class Repeater extends Node`：子节点 Success/Failure 后重置并重新 tick，返回 Running。
  - `class UntilFail extends Node`：子节点成功时继续 Running，失败后返回 Success。
  - `class UntilSuccess extends Node`：子节点失败时继续 Running，成功后返回 Failure。

- [ ] **Step 1: 写失败测试**

在 `test/ai-check.cjs` 追加：Selector 短路、Sequence 全成功/任一失败、Inverter 反转、UntilFail 直到失败等断言。

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL（新类未定义）

- [ ] **Step 2: 实现 `src/ai/composites.ts` / `src/ai/decorators.ts`**

- [ ] **Step 3: 运行测试通过**

Run: `npm run test:snapshot && npm run test:ai`
Expected: PASS

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 0 error

- [ ] **Step 5: Commit**

```bash
git add src/ai/composites.ts src/ai/decorators.ts test/ai-check.cjs
git commit -m "feat(ai): A02 复合节点与装饰器"
```

**预期 exit code：** 全部 0。

---

### Task A03: 条件节点库

**Files:**
- Create: `src/ai/Perception.ts`
- Create: `src/ai/conditions.ts`
- Modify: `test/ai-check.cjs`（追加断言）

**Interfaces:**
- Consumes: `Node`、`NodeStatus`、`TickContext`（A01）；`World` 只读接口（`getBlock/isSolidAt/surfaceHeight`）。
- Produces:
  - `class Perception`：`canSee(entity,target)`、`canHear(entity,pos,volume)`、`distance(entity,target)`、`getNearby(entity,radius,typeFilter)`、`getBlockAt(entity,x,y,z)`、`isUnderSky(entity)`、`isInWater(entity)`、`canReach(x,y,z)`（8×8×8 贪婪扩展，失败回退 false）。
  - 条件节点类：`CanSeePlayer` / `DistanceLt` / `HealthPctLt` / `IsDay` / `IsNight` / `IsInWater` / `IsOnGround` / `HasTarget` / `TargetInRange` / `BlackboardEq` / `CanReach`，每个 `tick(ctx)` 只返回 Success/Failure，无副作用。

- [ ] **Step 1: 写失败测试**

条件节点边界断言：`distance_lt` 边界等于/不等于、`is_day` daylight 0.55 边界、`can_see_player` 视距内/外、`can_reach` 不可达点。

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL

- [ ] **Step 2: 实现 `src/ai/Perception.ts` / `src/ai/conditions.ts`**

`canReach` 失败返回 false（节点返回 Failure），不抛错。

- [ ] **Step 3: 运行测试通过**

Run: `npm run test:snapshot && npm run test:ai`
Expected: PASS

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 0 error

- [ ] **Step 5: Commit**

```bash
git add src/ai/Perception.ts src/ai/conditions.ts test/ai-check.cjs
git commit -m "feat(ai): A03 条件节点库与感知视图"
```

**预期 exit code：** 全部 0。

---

### Task A04: 动作节点库

**Files:**
- Create: `src/ai/actions.ts`
- Modify: `test/ai-check.cjs`（追加断言）

**Interfaces:**
- Consumes: `Node`、`NodeStatus`、`TickContext`（A01）；`TickContext.events.emit`、`TickContext.api`（按权限裁剪）。
- Produces: 动作节点类：
  - `ChasePlayer(speed, stopDist)`：面向玩家并移动，距离 ≤ stopDist 返回 Success，否则 Running。
  - `FleeFrom(target, speed, minDist)`：远离目标直到 ≥ minDist 返回 Success。
  - `AttackPlayer(damage, cooldown)`：冷却结束且在攻击距离调用 `ctx.events.emit('survival:damage', ...)`，返回 Success；否则 Running。
  - `Wander(speed, idleMin/Max, walkMin/Max)`：随机朝向与走停。
  - `LookAt(target, duration)`：duration 秒内面向目标，返回 Success。
  - `Wait(seconds)`：等待后返回 Success。
  - `EmitEvent(event, payload)`：`ctx.events.emit`，返回 Success。
  - `SetBlackboard(key, value)`：写黑板，返回 Success。
  - `SpawnEntity(typeId, offset, chance)`：经 `ctx.api` 带 `world:write` 权限生成实体。
  - `BreakBlock(x,y,z)` / `PlaceBlock(x,y,z,blockId)`：经 `ctx.api` 带 `world:write` 权限。
  - `PlaySound(sound, volume)`：经 `ctx.api.audio`。

- [ ] **Step 1: 写失败测试**

动作节点状态转换断言：`Wait` 超时返回 Success、`SetBlackboard` 写入后 `BlackboardEq` 命中、`EmitEvent` 触发事件。

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL

- [ ] **Step 2: 实现 `src/ai/actions.ts`**

副作用全部经 `TickContext.events` / `TickContext.api`，不直接 import World/three。

- [ ] **Step 3: 运行测试通过**

Run: `npm run test:snapshot && npm run test:ai`
Expected: PASS

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 0 error

- [ ] **Step 5: Commit**

```bash
git add src/ai/actions.ts test/ai-check.cjs
git commit -m "feat(ai): A04 动作节点库"
```

**预期 exit code：** 全部 0。

---

### Task A05: 行为树编译器与节点注册表

**Files:**
- Create: `src/ai/BehaviorTree.ts`
- Create: `src/ai/registry.ts`
- Modify: `test/ai-check.cjs`（追加断言）

**Interfaces:**
- Consumes: 所有节点类（A01–A04）；`NodeRegistry`。
- Produces:
  - `class NodeRegistry { register(name, ctor): void; create(name, config): Node }`：支持第三方插件注册自定义节点。
  - `class BehaviorTree { static fromJSON(json): BehaviorTree; tick(dt): NodeStatus; reset(): void }`：JSON 编译器，非法 JSON（缺 root / 未知 type / 子节点缺 type）抛错。
  - `reloadConfig(typeId, json)`：重新编译某类型行为树，不影响运行中实例的运行时状态。

- [ ] **Step 1: 写失败测试**

`BehaviorTree.fromJSON` 合法 JSON 构建成功；非法 JSON 抛错；`tick()` 返回正确状态；`reset()` 清理运行时状态。

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL

- [ ] **Step 2: 实现 `src/ai/BehaviorTree.ts` / `src/ai/registry.ts`**

- [ ] **Step 3: 运行测试通过**

Run: `npm run test:snapshot && npm run test:ai`
Expected: PASS

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 0 error

- [ ] **Step 5: Commit**

```bash
git add src/ai/BehaviorTree.ts src/ai/registry.ts test/ai-check.cjs
git commit -m "feat(ai): A05 行为树编译器与节点注册表"
```

**预期 exit code：** 全部 0。

---

### Task A06: AIService 与主循环集成

**Files:**
- Create: `src/ai/AIComponent.ts`
- Create: `src/ai/AIService.ts`
- Modify: `src/main.ts`（构造 AIService，主循环调 `aiService.update(dt)`）

**Interfaces:**
- Consumes: `BehaviorTree`、`NodeRegistry`、`AIComponent`、`World`、`EventService`、`CraftAPI`、世界 seed。
- Produces:
  - `class AIComponent { tree: BehaviorTree; blackboard: Blackboard; enabled: boolean }`
  - `class AIService implements Disposable`：
    - `constructor(world, events, api, seed: number)`
    - `registerType(typeId: string, json: object): void`
    - `attach(entity: Entity, typeId: string): void`
    - `update(dt: number): void`：分帧更新所有 AIComponent，每帧预算（如 2ms），超时下帧继续。
    - `enable()/disable()`：启停所有 AI tick。
    - `reloadConfig(typeId, json: object): void`
    - `dispose(): void`

- [ ] **Step 1: 写失败测试**

`AIService.registerType` + `attach` 后 `update(dt)` 能驱动行为树 tick；`disable()` 后不再 tick；`reloadConfig` 不影响运行中实例。

Run: `npm run test:snapshot && npm run test:ai`
Expected: FAIL

- [ ] **Step 2: 实现 `src/ai/AIComponent.ts` / `src/ai/AIService.ts`**

分帧：每帧累计 dt，超过预算则中断，下帧从中断点继续。

- [ ] **Step 3: 接线 main.ts**

在组装根构造 `AIService`，注入 seed；主循环 `playing` 模式下每帧调 `aiService.update(dt)`。

- [ ] **Step 4: 运行测试与类型检查**

Run: `npm run test:snapshot && npm run test:ai && npm run typecheck`
Expected: 全绿，0 error

- [ ] **Step 5: Commit**

```bash
git add src/ai/AIComponent.ts src/ai/AIService.ts src/main.ts test/ai-check.cjs
git commit -m "feat(ai): A06 AIService 与主循环集成"
```

**预期 exit code：** 全部 0。

---

### Task A07: 实体系统集成（attach/despawn/kill）

**Files:**
- Modify: `src/entity/entity.ts`（新增 `aiComponent?: AIComponent`，`update` 委托 AI 决策）
- Modify: `src/main.ts`（spawn 时 attach，despawn/kill 时释放）

**Interfaces:**
- Consumes: `AIService`、`AIComponent`（来自 A06）；`EntityManager`（现有）。
- Produces:
  - `Entity.aiComponent?: AIComponent` 可选字段。
  - `Entity.update(dt, world, ctx)`：若 `aiComponent` 存在且启用，先 `aiComponent.tick(dt)` 得到决策（速度/朝向/攻击意图），再应用到物理与动画；若无 AIComponent，保持原硬编码行为（A08 前的过渡）。
  - `EntityManager.spawn()`：创建 Entity 后，若该类型已在 AIService 注册，则 `aiService.attach(entity, typeId)`。
  - `EntityManager.despawn()` / `kill()`：释放对应 `AIComponent`（黑板清空，运行时状态重置）。

- [ ] **Step 1: 写失败测试**

在 `test/logic-check.cjs` 追加：spawn 猪后 `entity.aiComponent` 不为 null；despawn 后 AIComponent 被释放；Entity.update 委托 AI 后速度/朝向由行为树决定。

Run: `npm run test:snapshot && npm run test:logic`
Expected: FAIL（`aiComponent` 字段未定义）

- [ ] **Step 2: 实现 `src/entity/entity.ts` 修改与 main.ts 接线**

- [ ] **Step 3: 运行测试与类型检查**

Run: `npm run test:snapshot && npm run test:logic && npm run typecheck`
Expected: 全绿，0 error

- [ ] **Step 4: Commit**

```bash
git add src/entity/entity.ts src/main.ts test/logic-check.cjs
git commit -m "feat(ai): A07 实体系统与 AIService 接线"
```

**预期 exit code：** 全部 0。

---

### Task A08: 现有 4 种生物迁移行为树 JSON + 行为等价回归

**Files:**
- Create: `src/ai/behaviors/pig.json` / `sheep.json` / `zombie.json` / `skeleton.json`
- Modify: `src/main.ts`（在 AIService 注册四种类型的 JSON）
- Modify: `test/logic-check.cjs`（追加行为等价回归断言）

**Interfaces:**
- Consumes: `AIService.registerType(typeId, json)`（A06）；`EntityType` 注册（现有 `src/entity/entity.ts`）。
- Produces: 四种生物行为树 JSON，行为与 v1.4.9 等价：
  - 猪/羊：`wander` + 随机转向（保持原 `timer` 逻辑）。
  - 僵尸/骷髅：`can_see_player → chase_player → attack_player`，否则 `wander`；白天灼烧保留在 `Entity.update` 中（不改既有血量逻辑）。

- [ ] **Step 1: 写失败测试（行为等价回归）**

在 `test/logic-check.cjs` 追加：僵尸看到玩家（dist<26）后追击；距离≤1.8 且冷却结束时攻击；白天灼烧掉血；猪/羊随机漫步；行为与 v1.4.9 原表现一致。

Run: `npm run test:snapshot && npm run test:logic`
Expected: FAIL（JSON 未注册，行为树未生效）

- [ ] **Step 2: 创建四个行为树 JSON 并在 main.ts 注册**

- [ ] **Step 3: 运行测试与类型检查**

Run: `npm run test:snapshot && npm run test:logic && npm run typecheck`
Expected: 全绿，0 error；行为等价断言通过。

- [ ] **Step 4: Commit**

```bash
git add src/ai/behaviors/pig.json src/ai/behaviors/sheep.json src/ai/behaviors/zombie.json src/ai/behaviors/skeleton.json src/main.ts test/logic-check.cjs
git commit -m "feat(ai): A08 四种生物迁移行为树 JSON，行为等价回归"
```

**预期 exit code：** 全部 0。

---

### Task A09: 收尾 / 诊断 / 版本 bump

**Files:**
- Modify: `src/diagnostics/RuntimeDiagnostics.ts`（AI 实体数 / 运行中行为树数计数，可选）
- Modify: `src/core/version.ts`（VERSION bump）
- Modify: `package.json` / `README.md` / `CHANGELOG.md`（版本同步）
- Modify: `docs/ARCHITECTURE.md` / `docs/PROJECT-EXPERIENCE.md` / `docs/agent/RUNBOOK.md` / `docs/TESTING.md`（文档同步）
- Modify: `docs/agent/validate.py`（最终 `--strict` 确认）

**Interfaces:**
- Consumes: `AIService` 统计信息（实体数、运行中行为树数）。
- Produces: F3 诊断行显示 AI 计数；`npm run verify` 100% PASS；`python3 docs/agent/validate.py --strict` 0 FAIL/WARN。

- [ ] **Step 1: 补运行时诊断计数（可选）**

在 `RuntimeDiagnostics.ts` 新增 AI 实体数与运行中行为树数检查。

- [ ] **Step 2: 文档同步与版本 bump**

`src/core/version.ts` VERSION bump；`README.md` / `CHANGELOG.md` 记录 AI 系统；`docs/ARCHITECTURE.md` 增加 AI 系统分层说明。

- [ ] **Step 3: 最终回归门**

Run: `npm run typecheck && npm run test:snapshot && npm run test:ai && npm run test:logic && npm run verify`
Expected: 100% PASS，exit code 0

Run: `python3 docs/agent/validate.py --strict`
Expected: 0 FAIL/WARN，exit code 0

- [ ] **Step 4: Commit**

```bash
git add src/diagnostics/RuntimeDiagnostics.ts src/core/version.ts package.json README.md CHANGELOG.md docs/ARCHITECTURE.md docs/PROJECT-EXPERIENCE.md docs/agent/RUNBOOK.md docs/TESTING.md docs/agent/validate.py
git commit -m "feat(ai): A09 收尾、诊断计数、版本 bump"
```

**预期 exit code：** 全部 0。

---

## 回归门汇总命令

```bash
npm run typecheck && npm run test:snapshot && npm run test:ai && npm run test:logic && npm run verify && python3 docs/agent/validate.py --strict
```

最终要求：`npm run verify` 100% PASS，`validate.py --strict` 0 FAIL/WARN，所有 exit code 为 0，并在提交信息中记录真实 exit code。

---

## 风险点与回滚建议

| 风险 | 可能性 | 影响 | 缓解 / 回滚 |
|------|--------|------|-------------|
| A08 四种生物行为与 v1.4.9 不完全等价（漫步频率/追击距离/攻击冷却微差） | 中 | test:logic 回归断言失败 | 保留 `Entity.update` 原硬编码行为作为 fallback；JSON 行为树与原逻辑并行，先跑等价断言，不等价时先保留原代码，再迭代 JSON |
| `canReach` 8×8×8 贪婪扩展在复杂地形下误判 | 低 | 条件节点返回 Failure，生物不按预期移动 | `canReach` 失败回退 `Failure`，不阻塞帧；后续可换 A* |
| 分帧预算导致 AI 更新延迟，手感变差 | 低 | 生物反应略滞后 | 预算可调（默认 2ms），可在 `?aiBudget=N` 覆盖；不阻塞渲染 |
| `TickContext.rng` 种子碰撞导致不同实体随机序列相同 | 低 | 多个生物行为同步 | 种子 = `hash(worldSeed, entityId, label)`，entityId 全局唯一，碰撞概率极低 |

任务卡是串行依赖的（A00→A01→…→A09），每张卡独立可提交、独立 verify。若某张卡卡住，可回滚到上一张卡的提交点，不影响已合并的代码。

---

## Self-Review

1. **Spec coverage:** 设计文档 §5 模块划分的所有模块（Node/Blackboard/composites/decorators/conditions/actions/Perception/BehaviorTree/registry/AIComponent/AIService）均有对应任务卡（A01–A06）；实体集成（A07）；4 种生物迁移（A08）；收尾（A09）；校验器（A00）。无缺口。
2. **Step scan:** 每步都有明确的文件、签名、测试断言和预期输出，无 "TBD"/"handle edge cases" 等不决策行。
3. **Type consistency:** `Node`/`NodeStatus`/`TickContext` 在 A01 定义，A02–A06 复用；`AIService.registerType/attach/update` 在 A06 定义，A07/A08 调用；签名一致。
4. **Review Focus:** 9 条失败模式均已对应到具体任务卡的测试断言。
5. **Proportion:** 计划文档长度与设计文档相当，未展开成代码抄录，代码块仅为精确签名与测试断言。

---

**Plan complete and saved to `docs/archive/2026-11/superpowers/plans/2026-11-21-ai-system-implementation.md`.**

请审阅此计划。计划是否如你所期待？如无调整，你可选择执行方式：

- **Subagent-driven** - 每张任务卡由一个新子按计划实施，并在下一张开始前由一个新 reviewer 校验，最后整个分支再做一次整体审查。最彻底；每个任务和每个审查都消耗新的上下文。
- **Native** - 我在此会话中自己逐条执行每张任务卡，最后由一个新 reviewer 对整个分支做一次审查。最快、最省上下文；只有最后才有独立审查。

**Does the plan capture what you want, and which approach should we use?**