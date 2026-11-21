# 实体 AI 系统 — 设计文档（定稿待审）

> 状态：**仅设计 / 任务卡草案，不含实现**。本文件写在 `/workspace/minecraft-web-replica-tuning/docs/superpowers/specs/`；仓库文件未改动。要落地到 `docs/` 与 `docs/agent/tasks/*.yaml`，需按 AGENTS.md 工作流提交。
>
> 需求来源：用户要求“为 minecraft-web-replica 写一个完整而可扩展的 AI 系统”，已选定方案 A（数据驱动行为树）。

---

## 0. 基线事实（已核实源码）

| 主题 | 现状 | 位置 |
|------|------|------|
| 实体系统 | `Entity` 类 + `EntityManager`，内置猪/羊/僵尸/骷髅 4 种；`Entity` 内置简单状态机 `'idle'\|'walk'`；敌对生物硬编码追击玩家（dist<26）；`EntityType.weight` 为 dead code，生成硬编码 `pig/sheep` | `src/entity/entity.ts:14-35,48-201,223-251,293-310` |
| 实体上下文 | `EntityContext { playerPos, hurtPlayer, daylight, playerDead }`，传入 `Entity.update(dt, world, ctx)` | `src/entity/entity.ts:37-44` |
| 事件系统 | `EventService`（`on/off/emit/once/waitFor/scope/stats`），`GameEvents` 接口支持声明合并扩展；现有事件含 `entity:spawn/despawn/dead/hurt`、`survival:damage/death/respawn/eat` 等 | `src/services/events/EventService.ts`、`src/services/events/GameEvents.ts` |
| 插件系统 | `PluginService`，`register/enable/disable/unload`，权限 `world:write/player:write/save:write/api:emit/blocks:register/time:write/settings:write/plugins:manage`；插件不得 import 引擎内部实现 | `src/services/plugins/PluginService.ts`、`docs/ARCHITECTURE.md:113-164` |
| DI 容器 | `ServiceContainer`（`token/provide/require/optional/has/keys/dispose`），逆序释放 | `src/services/ServiceContainer.ts` |
| 确定性 RNG | `mulberry32(seed)` 在 `src/core/types.ts`，Botany/Generator/Atlas 均已使用；现有 entity AI 的游荡/生成坐标仍用 `Math.random()`（技术债，本轮不动） | `src/core/types.ts:32-40` |
| World 接口 | `getBlock/isSolidAt/surfaceHeight/registry/chunks/dirty`；`CHUNK_SIZE=16`、`WORLD_HEIGHT=80`、`SEA_LEVEL=30` | `src/core/types.ts`、`src/world/world.ts` |
| 主循环 | `main.ts` 组装根，dt 被钳制到 0.05，`entities.update` 在 `playing` 模式推进 | `src/main.ts` |
| 物理 | `moveBody(world, body, dt)` 复用 AABB 碰撞与脱困 | `src/player/physics.ts` |
| 测试 | `test:snapshot` 从 TS 源码现场编译 CJS 快照；`test:logic` 生存状态机+地形；新纯逻辑源文件要进 `scripts/build-test-snapshot.mjs` entries | `scripts/build-test-snapshot.mjs:17-66`、`package.json:37-38` |
| 运行时依赖 | 唯一依赖 three.js，其余全部手写 | `AGENTS.md:3` |

---

## 1. 意图 / Why

现有实体 AI 是“每种生物一个硬编码逻辑分支”写在 `Entity.update()` 里，新增一种生物或新行为必须改 `entity.ts`，违反开闭原则，且无法数据驱动、无法热重载、难以单测。Minecraft 类游戏的生物种类多、行为组合复杂（漫步、追击、攻击、逃跑、繁殖、恐惧、群聚等），需要一套：

- **可插拔**：新增 AI 行为或新生物只加 JSON 配置 + 节点实现，不改现有 TS 代码；
- **可测试**：行为树节点是纯函数，可脱离 three/DOM 做快照测试；
- **可组合**：条件/动作/装饰器节点像乐高一样组合出复杂行为；
- **确定性**：所有随机性走 `mulberry32`，同种子同序列可复现；
- **与插件系统对齐**：AI 服务作为插件注册，通过事件总线与世界交互，不绕过权限边界。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 一套数据驱动行为树（Behavior Tree）执行器，JSON 配置驱动生物 AI；
- 内置一套通用节点库：条件（can_see_player、distance_lt、health_pct_lt、is_day、is_in_water、has_target 等）、动作（chase_player、flee_from、attack、wander、look_at、wait、emit_event、set_blackboard 等）、装饰器（inverter、repeater、until_fail、until_success）、复合（selector、sequence、parallel）；
- 黑板（Blackboard）实体级键值存储，节点间共享状态；
- 感知系统（Perception）：视线/听觉/距离/区块查询，供条件节点使用；
- AIService 作为可启停插件 `core:ai-system` 注册，每帧批量更新所有带 AI 组件的实体；
- 现有 4 种生物（猪/羊/僵尸/骷髅）迁移到行为树 JSON，行为不变（回归锁死）；
- 新生物只需新增 JSON + 注册 EntityType，无需改 AI 核心代码；
- 确定性：行为树内所有随机选取走 `mulberry32`，种子来源于世界 seed + 实体 ID + 节点标签。

**非目标**
- GOAP / 实用性评分决策（行为树已足够，且更易调试与回归）；
- 群体智能 / 领队追随（可作为后续节点扩展）；
- 导航网格（NavMesh）—— Minecraft 体素世界用区块网格 + A* / Jump Point 足够，首版行为节点内做局部寻路即可；
- AI 决策持久化到存档（AI 状态为运行时临时状态，读档后重置）。

**反目标（做了就算失败）**
- 在行为树节点或感知系统里引入 `Math.random()` → 违反确定性硬规则；
- 让 AI 节点直接 import three / World / DOM 实现 → 无法编译进快照测试，节点必须只依赖注入的 AIContext 接口；
- 修改既有 4 种生物的表现行为（回归不能绿）；
- 新增方块 id 或图表 tile（AI 系统不涉及方块/纹理）。

---

## 3. 约束

- 仅依赖 three.js（运行时）；AI 核心节点与感知系统不依赖 three / DOM / World 具体类，只依赖注入的接口；
- 所有随机性走 `mulberry32(seed)`，种子 = `hash(worldSeed, entityId, nodeLabel)`；
- 方块 id 只追加、不调整；AI 系统不新增方块；
- 插件权限边界：AI 动作节点要修改世界（spawn/break/place/hurtPlayer）须走 `ctx.api` 带权限检查，不得直接调用引擎内部；
- 测试：新纯逻辑源文件（节点库、感知、行为树编译器）要进 `scripts/build-test-snapshot.mjs` entries，并新增 `test:ai` 组挂进 `verify` 长链；
- 主循环预算：AI 更新每帧预算（如 2ms），超时则分帧（实体分批更新），不阻塞渲染。

---

## 4. 方案取舍（Approaches）

已选定 **A（数据驱动行为树）**，下面是完整取舍记录。

| 轴 | 候选 | 取舍 | 选定 |
|----|------|------|------|
| **A1 决策模型** | 行为树（JSON 配置 + 节点代码） | 条件/动作/装饰器解耦，新生物只加 JSON，节点可单测；Minecraft 生物行为天然适合树形组合 | ✅ **A1** |
| | 有限状态机（FSM，每种生物一个类） | 每新增行为都要改/增代码，类爆炸，违反开闭原则 | 否 |
| | GOAP / 实用性评分 | 决策灵活但调试困难，确定性回放和行为回归测试难，性能开销大 | 否（后续可作为装饰器扩展） |
| **A2 节点执行模型** | 同步 tick，每帧从根节点重新开始评估 | 行为树标准做法，状态在节点内保持（running 状态节点下帧继续） | ✅ |
| | 完全事件驱动，无 tick | 难以表达“持续追击”“等待 X 秒”等带时间维度的行为 | 否 |
| **A3 感知接口** | AIContext 注入只读世界视图（距离、视线、方块、附近实体） | 节点不直接 import World，可脱离浏览器单测 | ✅ |
| | 节点直接持有 World 实例 | 违反“节点纯函数、可单测”原则，且与插件权限边界冲突 | 否 |
| **A4 随机性来源** | `mulberry32(hash(worldSeed, entityId, label))` | 确定性，同种子可复现，与项目现有 RNG 口径一致 | ✅ |
| | `Math.random()` | 现有 entity AI 的技术债，新 AI 系统不得引入 | 否 |
| **A5 部署方式** | 作为 `core:ai-system` 插件注册，通过 PluginService 生命周期管理 | 与现有插件系统对齐，可启停、可热重载、权限隔离 | ✅ |
| | 直接在 main.ts 组装根里 new AIService | 绕过插件权限，第三方无法替换或扩展 AI 节点 | 否 |

---

## 5. 模块划分（小接口 + 大实现）

| 模块 | 外部接口（小） | 隐藏的实现（大） | 为什么是深模块 |
|------|----------------|------------------|----------------|
| `src/ai/Blackboard.ts`（新） | `class Blackboard { get/set/has/del(key) }` | 实体级 Map 存储，支持嵌套路径与类型断言 | 调用方只传键值，不关心存储与并发安全 |
| `src/ai/Node.ts`（新） | `enum NodeStatus { Running, Success, Failure }`、`abstract class Node { tick(ctx): NodeStatus }` | 节点基类、子树引用、运行时状态栈 | 调用方只调 `tick()`，不关心状态机转换 |
| `src/ai/composites.ts`（新） | `Selector / Sequence / Parallel / RandomSelector` 类 | 子节点列表、运行中子索引、并发计数器 | 一组组合逻辑，复用于所有生物 AI |
| `src/ai/decorators.ts`（新） | `Inverter / Repeater / UntilFail / UntilSuccess` 类 | 包装单子节点、反转/重复/直到失败/直到成功 | 装饰器不改动子节点实现，只改控制流 |
| `src/ai/conditions.ts`（新） | `CanSeePlayer / DistanceLt / HealthPctLt / IsDay / IsInWater / HasTarget / TargetInRange / BlackboardEq / CanReach` 类 | 每个条件只读 AIContext，返回 Success/Failure | 纯判断，无副作用，可独立单测 |
| `src/ai/actions.ts`（新） | `ChasePlayer / FleeFrom / Attack / Wander / LookAt / Wait / EmitEvent / SetBlackboard / SpawnEntity / BreakBlock / PlaceBlock / PlaySound` 类 | 每个动作通过 AIContext 执行副作用，返回 Success/Failure/Running | 副作用集中在此，业务逻辑不散落 |
| `src/ai/Perception.ts`（新） | `Perception.canSee(entity,target) / canHear(entity,pos,vol) / distance(entity,target) / getNearby(entity,radius,typeFilter) / getBlockAt(entity,x,y,z) / isUnderSky(entity) / isInWater(entity)` | 封装 World/EntityManager/光照查询，提供只读视图 | 节点不直接依赖 World，感知层可替换实现 |
| `src/ai/AIContext.ts`（新） | `interface AIContext { entity, world, playerPos, daylight, playerDead, rng(seedLabel), events, api }` | 注入容器，供节点使用；`rng` 返回确定性随机 | 节点通过接口而非具体类获取能力 |
| `src/ai/BehaviorTree.ts`（新） | `class BehaviorTree { fromJSON(json): Node / tick(dt): NodeStatus / reset() }` | JSON 编译器、节点工厂注册表、运行时树状态 | 调用方只传 JSON，不关心节点构造细节 |
| `src/ai/AIComponent.ts`（新） | `class AIComponent { tree, blackboard, enabled }` | 挂在 Entity 上，持有行为树实例与黑板 | Entity 与 AI 解耦，Entity 可不带 AI |
| `src/ai/AIService.ts`（新） | `class AIService { registerType(typeId, jsonPath) / spawn(entity, typeId) / update(dt) / enable/disable / reloadConfig() }` | 管理所有 AIComponent，每帧批量 tick，分帧预算控制 | 主循环只调 `aiService.update(dt)`，不关心单个实体 AI |
| `src/ai/registry.ts`（新） | `NodeRegistry.register(name, ctor) / create(name, config)` | 节点类型注册表，支持第三方插件注册自定义节点 | 新节点类型只需注册，不改 BehaviorTree 代码 |
| `src/entity/entity.ts`（既有，薄增） | `Entity.aiComponent?: AIComponent`、`Entity.update` 中委托 `aiComponent?.tick(dt)` | 新增可选 AI 字段，不改既有字段与行为 | 现有生物可逐步迁移到行为树，不强制 |

---

## 6. 精确契约

### 6.1 节点状态与基类（`src/ai/Node.ts`）

```ts
export enum NodeStatus { Running = 0, Success = 1, Failure = 2 }

export interface TickContext {
  entity: Readonly<{ id: number; pos: {x,y,z}; type: {id: string} }>;
  world: Readonly<{ getBlock(x,y,z): number; isSolidAt(x,y,z): boolean; surfaceHeight(x,z): number }>;
  playerPos: {x:number;y:number;z:number};
  daylight: number;          // 0~1
  playerDead: boolean;
  rng: (label?: string) => number;   // 0~1 确定性随机
  events: { emit<K>(type: K, payload: GameEvents[K]): void };
  api: any;                  // 按权限裁剪的 CraftAPI 视图
  blackboard: Blackboard;
  dt: number;
}

export abstract class Node {
  abstract tick(ctx: TickContext): NodeStatus;
  reset(): void {}           // 子节点可覆盖，清理 running 状态
}
```

### 6.2 JSON 配置格式（行为树声明）

```json
{
  "root": {
    "type": "selector",
    "name": "zombie_root",
    "children": [
      {
        "type": "sequence",
        "name": "combat",
        "children": [
          {"type":"condition","name":"can_see_player","maxDist":26},
          {"type":"condition","name":"target_in_range","range":1.8},
          {"type":"action","name":"attack_player","damage":3,"cooldown":1.05}
        ]
      },
      {
        "type": "sequence",
        "name": "chase",
        "children": [
          {"type":"condition","name":"can_see_player","maxDist":26},
          {"type":"action","name":"chase_player","speed":1.45,"stopDist":2.2}
        ]
      },
      {
        "type": "action",
        "name":"wander","speed":1.05,"idleMin":1.5,"idleMax":3.5,"walkMin":2,"walkMax":4
      }
    ]
  }
}
```

- `type` 为 `selector/sequence/parallel/randomSelector/inverter/repeater/until_fail/until_success/condition/action`；
- `name` 用于日志与 RNG 种子分隔；
- `children` 仅复合节点有；
- 条件/动作的具体参数由各节点类定义，JSON 透传；
- 同一 `type.id` 的生物共享一棵行为树（编译后缓存），每个实例拥有独立运行时状态与黑板。

### 6.3 内置节点库（条件）

| 节点名 | 参数 | 含义 |
|--------|------|------|
| `can_see_player` | `maxDist` | 到玩家距离 ≤ maxDist 且无实体遮挡（raycast） |
| `can_hear_player` | `maxDist`, `volume` | 基于距离与音量衰减 |
| `distance_lt` | `target`, `dist` | 到指定目标（player/黑板目标）距离 < dist |
| `health_pct_lt` | `pct` | 当前血量 / 最大血量 < pct |
| `is_day` | — | `daylight > 0.55` |
| `is_night` | — | `daylight < 0.35` |
| `is_in_water` | — | 实体脚底方块为液体 |
| `is_on_ground` | — | 实体 `onGround === true` |
| `has_target` | — | 黑板中存在 `target` |
| `target_in_range` | `range` | 黑板目标距离 ≤ range |
| `blackboard_eq` | `key`, `value` | 黑板 `key` 严格等于 `value` |
| `can_reach` | `x,y,z` | A* 局部寻路能到达（首版 8×8×8 贪婪扩展，失败回退 Failure） |

### 6.4 内置节点库（动作）

| 节点名 | 参数 | 含义 |
|--------|------|------|
| `chase_player` | `speed`, `stopDist` | 面向玩家并向前移动，距离 ≤ stopDist 时停止 |
| `flee_from` | `target`, `speed`, `minDist` | 远离目标直到距离 ≥ minDist |
| `attack_player` | `damage`, `cooldown` | 若冷却结束且在攻击距离，调用 `hurtPlayer`，返回 Success（Running 期间持续面向） |
| `wander` | `speed`, `idleMin/Max`, `walkMin/Max` | 随机朝向与走停（替代现有 `Entity.state='idle\|walk'`） |
| `look_at` | `target`, `duration` | 在 duration 秒内面向目标 |
| `wait` | `seconds` | 等待指定时间后返回 Success |
| `emit_event` | `event`, `payload` | 通过 `events.emit` 发送游戏事件 |
| `set_blackboard` | `key`, `value` | 写黑板，供后续条件节点读取 |
| `spawn_entity` | `typeId`, `offset`, `chance` | 在偏移处生成实体（需 `world:write` 权限） |
| `break_block` | `x,y,z` | 破坏方块（需 `world:write` 权限） |
| `place_block` | `x,y,z`, `blockId` | 放置方块（需 `world:write` 权限） |
| `play_sound` | `sound`, `volume` | 播放音效（通过 `api.audio`） |

### 6.5 AIService 接口

```ts
export class AIService implements Disposable {
  constructor(world, events, api, seed: number);
  /** 注册一种生物的 AI：json 为行为树配置（对象或已解析 JSON） */
  registerType(typeId: string, json: object): void;
  /** 为已存在的 Entity 挂载 AI（spawn 时调用） */
  attach(entity: Entity, typeId: string): void;
  /** 每帧调用，分帧更新所有 AIComponent */
  update(dt: number): void;
  enable(): void; disable(): void;
  /** 重新加载某类型的 JSON 配置（热重载，不影响运行中实例的运行时状态） */
  reloadConfig(typeId: string, json: object): void;
  dispose(): void;
}
```

### 6.6 确定性 RNG 契约

- `TickContext.rng(label?)` 返回 0~1 浮点，底层 `mulberry32(hash(worldSeed, entityId, label || 'default'))`；
- 同一实体同一节点同一 label 的随机序列可复现；
- 所有内置节点（wander 朝向、randomSelector 子节点选择等）必须通过 `ctx.rng` 而非 `Math.random`。

### 6.7 集成点（main.ts / EntityManager）

- `EntityManager` 构造时注入 `AIService`；
- `EntityManager.spawn()` 创建 Entity 后，若该类型已注册 AI，则 `aiService.attach(entity, typeId)`；
- `Entity.update(dt, world, ctx)` 中：若 `this.aiComponent` 存在且启用，先执行 `aiComponent.tick(dt)` 得到决策，再将决策（速度/朝向/攻击等）应用到物理与动画；
- 现有 4 种生物的行为树 JSON 与原硬编码行为等价（回归锁死）：
  - 猪/羊：`wander` + 随机转向（保持原 `timer` 逻辑）；
  - 僵尸/骷髅：`can_see_player → chase_player → attack_player`，否则 `wander`；
- `EntityManager.despawn()` / `kill()` 时 `aiComponent` 随实体一并释放（黑板清空，运行时状态重置）。

---

## 7. 存档与生命周期

- AI 状态（黑板、行为树运行时节点状态）不进存档：读档后所有 AIComponent 重置为初始状态；
- AIService `disable()` 时清空所有 AIComponent，`enable()` 时重新 attach 现有实体；
- 插件 `core:ai-system` 默认启用；第三方插件可通过 `api:emit` + `blocks:register` 权限注册自定义节点或新增生物 AI JSON。

---

## 8. 测试与验收

**新增测试组 `test:ai`**（`test/ai-check.cjs`，require 快照 `./logic/ai/Node.js`、`./logic/ai/composites.js`、`./logic/ai/conditions.js`、`./logic/ai/actions.js`、`./logic/ai/BehaviorTree.js`）：

- `NodeStatus` 枚举值正确；
- `Selector`：子节点失败则下一个，成功即短路；
- `Sequence`：全成功才成功，任一失败即失败；
- `Inverter`：反转子节点状态；
- `UntilFail`：子节点成功时继续 Running，失败后返回 Success；
- 条件节点 `can_see_player` / `distance_lt` / `health_pct_lt` / `is_day` / `is_in_water` 边界断言；
- 动作节点 `set_blackboard` / `wait` / `wander` 状态转换；
- `BehaviorTree.fromJSON` 合法 JSON 构建成功，非法 JSON 抛错；
- `mulberry32` 随机性：同 seed 可复现，不同 seed 不同；
- 现有 4 种生物 JSON 行为树与原硬编码行为等价（逐类型回归断言）。

**既有测试同步**：无需修改（现有 entity 行为不变）；`test:logic` 覆盖现有生物生成与死亡。

**package.json / scripts**：加 `"test:ai"`，并在 `verify` 链 `test:snapshot` 之后追加 `&& npm run test:ai`；`scripts/build-test-snapshot.mjs` entries 加 `src/ai/Node.ts`、`src/ai/composites.ts`、`src/ai/decorators.ts`、`src/ai/conditions.ts`、`src/ai/actions.ts`、`src/ai/BehaviorTree.ts`、`src/ai/Blackboard.ts`、`src/ai/Perception.ts`、`src/ai/AIContext.ts`。

**回归门**：`npm run typecheck && npm run test:snapshot && npm run test:ai && npm run test:logic && npm run verify`（最终 verify 100% PASS）。

---

## 9. 任务卡草案（A00 → A08）

> 每张卡 outputs 关键词对应 A00 将加入 `validate.py` 的 CHECK。

### A00 AI 系统契约校验器 + 设计落地
```yaml
id: A00
title: AI 系统契约校验器与设计文档落地
description: docs/agent/validate.py 为 AI 系统 outputs 补机械检查；写入设计文档。
touch: { allow: [docs/agent/validate.py, docs/agent/tasks/A0*.yaml, docs/superpowers/specs/2026-11-21-ai-system-design.md], deny: [src/**, test/**] }
outputs:
  - ai core: src/ai/Node.ts / Blackboard.ts / TickContext 存在且导出 NodeStatus
  - ai composites: Selector / Sequence / Parallel / RandomSelector 存在
  - ai decorators: Inverter / Repeater / UntilFail / UntilSuccess 存在
  - ai conditions: CanSeePlayer / DistanceLt / HealthPctLt / IsDay / IsInWater / HasTarget 存在
  - ai actions: ChasePlayer / ChasePlayer / Attack / Wander / Wait / EmitEvent / SetBlackboard 存在
  - ai tree: BehaviorTree.fromJSON 与 JSON 配置格式存在
  - ai service: AIService.registerType / attach / update / enable / disable / reloadConfig 存在
  - ai perception: Perception 只读视图存在
  - entity integration: Entity.aiComponent 可选字段，update 委托 AIComponent
  - test:ai: package.json 声明 test:ai 且 verify 链包含它
  - 任务卡校验器: CHECKS 覆盖上述关键词
```

### A01 节点基础（Node / Blackboard / TickContext / 确定性 RNG）
```yaml
id: A01
title: 行为树节点基础与确定性随机
description: 新建 src/ai/Node.ts、src/ai/Blackboard.ts、src/ai/AIContext.ts；TickContext.rng 走 mulberry32(seed, entityId, label)。
touch: { allow: [src/ai/Node.ts, src/ai/Blackboard.ts, src/ai/AIContext.ts, test/ai-check.cjs, scripts/build-test-snapshot.mjs, package.json, docs/TESTING.md], deny: [src/entity/entity.ts, src/world/mesher.ts] }
outputs:
  - ai core: NodeStatus / Node / Blackboard / TickContext / mulberry32 RNG 单测全绿
```

### A02 复合节点与装饰器
```yaml
id: A02
title: Selector / Sequence / Parallel / 以及 Inverter / Repeater / UntilFail / UntilSuccess
description: 新建 src/ai/composites.ts、src/ai/decorators.ts；状态机 Running/Success/Failure 正确转换。
touch: { allow: [src/ai/composites.ts, src/ai/decorators.ts, test/ai-check.cjs], deny: [src/world/mesher.ts] }
outputs:
  - ai composites: 四类复合节点状态转换全绿
```

### A03 条件节点库
```yaml
id: A03
title: 条件节点：can_see_player / distance_lt / health_pct_lt / is_day / is_night / is_in_water / has_target / target_in_range / blackboard_eq / can_reach
description: 新建 src/ai/conditions.ts、src/ai/Perception.ts；条件只读 AIContext，无副作用。
touch: { allow: [src/ai/conditions.ts, src/ai/Perception.ts, test/ai-check.cjs], deny: [src/world/mesher.ts] }
outputs:
  - ai conditions: 九类条件节点边界断言全绿
```

### A04 动作节点库
```yaml
id: A04
title: 动作节点：chase_player / flee_from / attack_player / wander / look_at / wait / emit_event / set_blackboard / spawn_entity / break_block / place_block / play_sound
description: 新建 src/ai/actions.ts；副作用经 AIContext.events / api 发送，带权限检查。
touch: { allow: [src/ai/actions.ts, test/ai-check.cjs], deny: [src/world/mesher.ts] }
outputs:
  - ai actions: 十二类动作节点状态转换与副作用断言全绿
```

### A05 行为树编译器与节点注册表
```yaml
id: A05
title: BehaviorTree.fromJSON 与 NodeRegistry
description: 新建 src/ai/BehaviorTree.ts、src/ai/registry.ts；JSON 编译、节点工厂注册、热重载 reloadConfig。
touch: { allow: [src/ai/BehaviorTree.ts, src/ai/registry.ts, test/ai-check.cjs], deny: [src/world/mesher.ts] }
outputs:
  - ai tree: JSON 编译成功/失败断言；reloadConfig 热重载不影响运行中实例
```

### A06 AIService 与主循环集成
```yaml
id: A06
title: AIService 批量更新与分帧
description: 新建 src/ai/AIService.ts、src/ai/AIComponent.ts；主循环每帧调 aiService.update(dt)，分帧预算控制。
touch: { allow: [src/ai/AIService.ts, src/ai/AIComponent.ts, src/main.ts], deny: [src/world/mesher.ts] }
outputs:
  - ai service: 批量 tick / 分帧 / enable-disable 生命周期全绿
```

### A07 实体系统集成（attach/despawn/kill）
```yaml
id: A07
title: EntityManager 与 AIService 接线
description: spawn 时按类型 attach AI；despawn/kill 时释放 AIComponent；Entity.update 委托 AIComponent 决策。
touch: { allow: [src/entity/entity.ts, src/main.ts, test/logic-check.cjs, docs/TESTING.md], deny: [src/world/mesher.ts] }
outputs:
  - entity integration: 生物 spawn/despawn/kill 时 AIComponent 正确创建与释放
```

### A08 现有 4 种生物迁移行为树 JSON + 回归
```yaml
id: A08
title: 猪/羊/僵尸/骷髅迁移行为树 JSON，行为不变
description: 为 4 种生物写行为树 JSON（保持原 wander/追击/攻击/日灼行为），注册到 AIService，原硬编码 AI 分支可保留作为 fallback 或逐步移除。
touch: { allow: [src/ai/*.json（新建 ai/behaviors/ 目录）, src/entity/entity.ts, src/main.ts, test/logic-check.cjs, docs/TESTING.md], deny: [src/world/mesher.ts] }
outputs:
  - ai behavior: 四种生物行为与 v1.4.9 原表现等价，test:logic 全绿
```

### A09 收尾 / 诊断 / 版本 bump
```yaml
id: A09
title: 收尾与版本收敛
description: 运行时诊断计数（AI 实体数、运行中行为树数）、文档同步（ARCHITECTURE/RUNBOOK/TESTING/README/CHANGELOG）、VERSION bump、python3 docs/agent/validate.py --strict 0 FAIL/WARN、npm run verify 100% PASS。
touch: { allow: [src/diagnostics/RuntimeDiagnostics.ts, src/core/version.ts, package.json, README.md, CHANGELOG.md, docs/ARCHITECTURE.md, docs/PROJECT-EXPERIENCE.md, docs/agent/RUNBOOK.md, docs/TESTING.md, docs/agent/validate.py], deny: [src/world/mesher.ts] }
outputs:
  - verify: npm run verify 100% PASS 且 validate.py --strict 0 FAIL/WARN
```

---

## 10. 执行顺序与回归门

```
A00（两阶段收紧）
  ↓
A01 节点基础          → typecheck, snapshot, test:ai
  ↓
A02 复合与装饰器      → + test:ai
  ↓
A03 条件节点          → + test:ai
  ↓
A04 动作节点          → + test:ai
  ↓
A05 行为树编译器      → + test:ai
  ↓
A06 AIService 集成    → + test:ai
  ↓
A07 实体系统接线      → + test:logic
  ↓
A08 4 种生物迁移 JSON → + test:logic，行为等价回归
  ↓
A09 收尾 bump         → npm run verify（100% PASS）
```

每卡：改前 `typecheck` 基线干净；改后先红后绿，green 之后不改测试迁就实现；提交信息写“改了什么/为什么”。合并纪律沿用 RUNBOOK：一次一 PR、合完立刻 verify、WIP 不上 main、版本只在 A09 bump。

---

## 11. 验收清单（跨卡）

- [ ] `src/ai/` 下所有节点只依赖 TickContext 接口，不 import three / World / DOM；
- [ ] 所有随机性走 `mulberry32`，无新增 `Math.random`（既有 entity AI 游荡/生成坐标的 `Math.random()` 不在本轮，保持技术债原样）；
- [ ] 方块 id 总数不变，无新增方块/纹理；
- [ ] 现有 4 种生物行为与 v1.4.9 等价（test:logic 全绿）；
- [ ] 新生物只需新增 EntityType + 行为树 JSON，不改 AI 核心代码；
- [ ] AIService 可启停、可热重载 JSON、可分帧更新；
- [ ] `test:ai` 纳入 `verify`；`npm run verify` 100% PASS；
- [ ] `python3 docs/agent/validate.py --strict` 0 FAIL/WARN；
- [ ] 未触碰 mesher/worker/快照缓冲；未新增运行时依赖。

---

## 12. 明确不做 / 后续

- **NavMesh 寻路**：首版 `can_reach` 用 8×8×8 贪婪扩展，失败回退 Failure；后续如需可换 A* / Jump Point；
- **群体智能 / 领队追随**：作为后续装饰器节点扩展；
- **GOAP / 实用性评分**：不在本轮；
- **AI 状态存档**：运行时临时状态，读档后重置；
- **画面受控实验**：AI 不涉及渲染通道，不走 EXPERIMENTS.md。

---

## 13. 留给 builder 的决定（已声明为调用，不阻塞）

- 行为树 JSON 文件放在 `src/ai/behaviors/*.json`，由 AIService `registerType(typeId, json)` 注册；是否预编译进打包产物或运行时读取，由 builder 选；
- `Entity.update` 中 AI 决策输出（速度/朝向/攻击）如何与既有物理 `moveBody` 和腿部动画 `model.animate` 耦合，由 builder 按既有套路实现；
- F3 诊断是否显示 AI 实体数与运行中行为树数，随 A09 一并做，不单独开卡；
- `can_reach` 局部寻路的最大扩展半径与步长，由 builder 选默认值（建议 8 格，失败回退 Failure）。