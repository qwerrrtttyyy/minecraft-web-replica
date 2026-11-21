# Minecraft TS 架构说明（v1.4.9）

> 目标：把**插件**与**事件**相关的 API 从 `main.ts` 中彻底独立为服务，形成可替换、
> 可测试、有生命周期的架构分层；同时修复实测暴露的缺陷并补齐工程化闭环。

---

## 1. 旧架构的问题（v1.1.2）

| 问题 | 具体表现 |
|---|---|
| 事件总线是"裸类" | `core/events.ts` 只有 63 行 `Map<string, Set<Handler>>`，无归属、无错误隔离、无生命周期；8 个模块直接 `import`，`main.ts` 里 11 处 `events.on(...)` 与状态机、UI 混在一起 |
| 扩展 API 不是"插件" | `window.CraftAPI` 是 boot() 末尾手工拼出的 22 个闭包函数，没有 id、版本、依赖、权限、启停，注册后无法回收订阅 |
| 组装根是上帝函数 | `main.ts` 800 行同时承担依赖构造、存档、状态机、事件接线、UI 反馈、系统注册，任何横切逻辑都得改它 |
| 依赖靠闭包传递 | 运行期对象全是 `boot()` 局部变量，插件/测试无法访问或替换 |
| 版本四处漂移 | 包名 1.1.2，`package.json` / `CraftAPI.version` / F3 面板都是 1.1.0 |
| 测试产物手工同步 | `test/logic` 与 `test/terrain-logic` 是编译快照，无自动生成，审查报告 v1.1.0 提过、两轮未落地 |

一句话：**"扩展点"只是几个全局函数，不是可治理的服务。**

---

## 2. 新分层

```
                       ┌──────────────────────────────┐
                       │  main.ts  (组装根 / composition root) │
                       │  建服务 → 注入依赖 → 启插件 → 启动循环  │
                       └───────────────┬──────────────┘
                                       │ provide / require
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
┌───────────────┐            ┌────────────────┐            ┌────────────────┐
│ ServiceContainer│◄─────────│  EventService  │◄───────────│ PluginService  │
│  类型化 DI     │  register │  事件服务       │  scope/emit│  插件服务       │
│  逆序 dispose  │           │  EventChannel  │            │  权限 / 生命周期│
└───────┬───────┘            └───────┬────────┘            └───────┬────────┘
        │                            │ 事件                        │ setup(ctx)
        ▼                            ▼                            ▼
┌───────────────┐            ┌────────────────┐            ┌────────────────┐
│ api/ CraftAPI │  薄门面     │ world/player/  │            │ plugins/builtin│
│ (旧 22 项兼容)│◄───────────│ gfx/entity/ui  │            │  + 第三方插件  │
└───────────────┘            └────────────────┘            └────────────────┘
```

**依赖方向单向**：`main → services → 业务模块`；`api/` 只做适配；插件只依赖
`PluginContext`，不 import 引擎内部实现。`core/events.ts` 保留为兼容垫片（再导出），
源码中的 6 个业务模块已迁移到 `services/events`。

### 目录职责

| 路径 | 职责 |
|---|---|
| `src/core/` | 引擎内核：主循环、类型常量、唯一版本源；`events.ts` 仅兼容再导出 |
| `src/services/ServiceContainer.ts` | `token<T>()` 类型化令牌、`provide/require/optional/has/keys/dispose` |
| `src/services/events/` | `GameEvents` 契约、`EventService` 实现、`EventChannel` 命名空间作用域 |
| `src/services/plugins/` | `PluginContext` 契约、`PluginService` 实现与 `scopeAPI` 权限裁剪 |
| `src/api/` | `CraftAPI` 门面：旧 22 项 + 新增 `plugins` / `events` 命名空间 |
| `src/plugins/builtin/` | 默认启用的内置插件；`deps.ts` 定义 `TOKENS.BuiltinDeps` 契约 |
| `src/plugins/example/` | 插件开发示例（不默认启用） |
| `src/diagnostics/` | 运行时诊断组：只读快照检查、F3 / CraftAPI 报告、每 10 秒自动采样 |
| `src/player/crafting.ts` | 合成规则：配方表与网格匹配（纯逻辑，不依赖 DOM / three） |
| `src/ui/crafting.ts` | 合成界面：3×3 网格、结果槽、背包区与配方列表（经 `CraftingHost` 回调取放） |

---

## 3. 三大服务契约

### 3.1 ServiceContainer

```ts
const TOKENS = {
  Events:      token<EventService>('events'),
  Plugins:     token<PluginService>('plugins'),
  CraftAPI:    token<CraftAPI>('api'),
  BuiltinDeps: token<BuiltinDeps>('builtin-deps'),
};

container.provide(TOKENS.Events, new EventService());
const ev = container.require(TOKENS.Events);   // 未注册直接抛错，组装期暴露接线错误
container.dispose();                            // 逆序调用各服务 dispose()
```

- 禁止重复注册（避免静默覆盖）。
- 类型安全靠 `ServiceToken<T>` 的幽灵字段，运行时只是一个字符串 key。
- `dispose()` 逆序释放：插件服务先于事件服务销毁，不会留下悬挂订阅。

### 3.2 EventService

`on/off/emit` 签名与旧 `EventBus` 完全一致，业务模块零行为改动即可迁移；新增能力：

| 能力 | 说明 |
|---|---|
| 错误隔离 | 单个订阅者抛错只上报 `setErrorHandler`，不阻断同事件其他订阅者或整帧逻辑 |
| `once` / `waitFor` | 一次性订阅与 Promise 等待，支持插件异步启动编排 |
| `scope(ns)` → `EventChannel` | 命名空间订阅作用域，`dispose()` 一键撤销全部订阅 |
| `onAny` | 全局观测钩子，供调试面板 / 事件回放 / 审计 |
| `stats()` | `{ emitted, subscribers, channels }`，测试可直接断言 |
| 递归深度保护 | 深度 > 16 拦截并上报，防止两个插件互相 emit 死循环 |
| `dispose()` | 纳入容器统一生命周期 |

新增事件：`chunk:unloaded`、`stream:backpressure`、`service:ready`、
`plugin:registered` / `plugin:enabled` / `plugin:disabled` / `plugin:error`。

自定义事件用声明合并追加：

```ts
declare module './services/events/GameEvents' {
  interface GameEvents { 'my:thing': { value: number } }
}
```

### 3.3 PluginService

```ts
interface PluginDefinition {
  manifest: {
    id: string;                    // 建议 作者:名称，正则校验
    version?: string;
    description?: string;
    dependencies?: string[];       // enable 时递归先启用，循环依赖拦截
    permissions?: PluginPermission[];
  };
  setup(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}
```

`PluginContext` 提供：`id`、`events`（EventChannel）、`services`（容器）、
`api`（按权限裁剪的 CraftAPI 视图）、`log`、`onDispose(fn)`。

**生命周期**：

```
register ──► registered ──► enable ──► [递归启用依赖] ──► setup(ctx)
                                          │                   │
                                     失败 ▼                成功 ▼
                                      failed ◄─────────── enabled
                                          │                   │
                                          └──── disable ──────► disabled
                                                    │
                                              (teardown + 订阅清理)
```

| 权限 | 放行能力 |
|---|---|
| `world:write` | `world.setBlock` / `tnt.ignite` / `entities.spawn` |
| `player:write` | `player.teleport` / `setFly` / `break` / `place` / `setCamera`；`survival.setMode` / `respawn` / `give` / `damage` / `heal` |
| `save:write` | `save.import` / `setProvider` |
| `api:emit` | `CraftAPI.emit`、`ctx.events.emit`、`api.events.scope(...).emit` |
| `blocks:register` | `registerBlock` / `registerTile` / `registerEntity` / `setGenerator` / `blocks.register` |
| `time:write` | `time.set` / `time.setDayLength` |
| `settings:write` | `settings.renderDistance` / `sensitivity` / `fov` / `sound` |
| `plugins:manage` | `plugins.register` / `enable` / `disable` / `unload`（`list` 只读） |

未声明的写能力在插件上下文里会抛错（读能力默认全开）。写入口集中登记在
`PluginService.ts` 的 `WRITE_CAPABILITIES` 表中，新增能力时同步维护该表，避免
「加了写入口忘了加拦截」。初始化失败被隔离为 `failed` 并发出 `plugin:error`，
**不会拖垮启动流程**。

**权限边界**：`api:emit` 同时约束 `ctx.events` 与 `api.events.scope()` 派生的子通道；
`api.on / off`、`api.events.waitFor / onAny` 都归属插件通道，停用时一并清理。
manifest 在 `register` 时做防御性拷贝，`list() / get()` 返回的也是副本，插件无法
改写自己的 `permissions`。`ctx.services` 与 `ctx.api.engine` 仍是受信内部对象，
权限是护栏不是沙箱。

**停用级联**：`disable(A)` 会先递归停用所有依赖 A 的下游插件（依赖方先 teardown），
避免出现「B 仍 enabled 但它依赖的 A 已停用」的悬浮依赖。

---

## 4. 插件开发示例

```js
CraftAPI.plugins.register({
  manifest: {
    id: 'demo:ore-notify',
    version: '1.0.0',
    description: '挖到矿石时提示',
    permissions: ['api:emit'],
  },
  setup(ctx) {
    // 订阅归属本插件，disable 时自动撤销
    ctx.events.on('block:break', ({ block }) => {
      const def = ctx.api.blocks.get(block);
      if (def.name.includes('ore')) ctx.log('挖到矿石：', def.label);
    });
    ctx.onDispose(() => ctx.log('已清理'));
    return () => ctx.log('teardown');   // 二者都会执行
  },
});
await CraftAPI.plugins.enable('demo:ore-notify');
CraftAPI.plugins.list();       // [{ manifest, state: 'enabled' }]
CraftAPI.plugins.disable('demo:ore-notify');
CraftAPI.plugins.unload('demo:ore-notify');
```

内置插件就是同一套契约：

| 插件 | 订阅 | 职责 |
|---|---|---|
| `core:autosave` | `block:break/place/ignite`、`player:move`、`inventory:change`、`hotbar:select`、`explosion`、`survival:*` | 标记存档脏 / 死亡立即落盘 |
| `core:hud-feedback` | `hotbar:select`、`inventory:change`、`save:done`、`survival:damage/death`、`entity:hurt` | HUD 更新、音效、触感、死亡状态机回调 |

`main.ts` 只把 boot() 的局部依赖打包成 `BuiltinDeps` 注册进容器，插件通过
`ctx.services.require(TOKENS.BuiltinDeps)` 取用，不再依赖 main 的作用域。

---

## 5. 从 v1.1.2 迁移

| 旧写法 | 新写法 |
|---|---|
| `import { EventBus } from '../core/events'` | `import { EventService } from '../services/events'`（垫片仍可用） |
| `const events = new EventBus()` | `const { container, events, plugins } = createServices()` |
| `import { createCraftAPI } from './api'` | `import { createCraftAPI } from './api'`（现为目录，签名不变） |
| `events.on(...)` 散落在 boot() | 抽成 `PluginDefinition`，由 `PluginService` 注册/启用 |
| `version: '1.1.0'` 硬编码 | `import { VERSION } from './core/version'` |
| 手工维护 `test/logic/*.js` | `npm run test:snapshot` 从源码现场编译 |

`window.CraftAPI` 旧 22 项与 `window.__mc` 全部保持兼容（`__mc` 另加
`services` / `events` / `plugins` / `api` 便于调试）。

---

## 6. 缺陷修复原理

### 6.1 幽灵区块竞态（P1，实测复现）

v1.1.2 时序：

```
initialLoad():  生成 chunk ──► remesh ──► world.dirty.clear()   ← 无差别清空
主循环 update(): ensureChunk() ──► dirty.add(key)               ← 被 clear 抹掉
结果：chunk.generated=true，meshes 里没有它，dirty 也没有它 → 永久空洞
```

实测 `chunks=114 / mesh=89 / dirty=0` 持续 20 秒不自愈，一次采样差集含
151,749 个实心体素。修复三重保险：

1. `initialLoad()` 删除 `dirty.clear()`，只删自己 remesh 过的 key，并清理半径外残留；
2. 预载期间 `loading=true`，`update()` 直接让开，杜绝并发消费；
3. `update()` 每帧兜底扫描 `world.chunks`：视距内「已生成但无网格」一律重新入队
   （用 `Chunk.cx/cz`，不做字符串 split），**任何路径漏标脏都能自愈**。

### 6.2 流式加载背压与卸载

- dirty 积压 ≥ `BACKLOG_LIMIT=24` 时暂停生成并发出 `stream:backpressure`，
  优先把已有队列网格化，避免传送后 3~4 秒的队列堆积。
- 卸载从「遍历 `meshes`」改为「遍历 `world.chunks`」，生成了却没网格化的区块
  同样释放，堵住内存泄漏；发出 `chunk:unloaded` 便于观测。

### 6.3 Pointer Lock

`requestPointerLock()` 在现代浏览器返回 Promise，无用户手势 / iframe 下会 reject。
v1.1.2 未捕获，冒出 `NotAllowedError` 页面异常；`lockFailed` / `dragging` 是死代码，
注释承诺的拖拽降级根本没实现。现在 `.catch()` 转入降级，`mousemove` 在未锁定且
按下左键时用 `clientX/Y` 差值转视角。

### 6.4 其它

`edits` 按 chunkKey 分桶（O(全档) → O(本区块)）；`validateSave()` 全量字段校验；
标题模式高亮同步存档真实模式；`openPalette()` 补发 `game:pause`；版本单一来源 +
`check-version` 机械校验。

---

## 7. 验证矩阵

| 层级 | 命令 | 内容 |
|---|---|---|
| 版本 | `npm run check:version` | package.json / version.ts / README 一致 |
| 类型 | `npm run typecheck` | TypeScript strict，0 error |
| 构建 | `npm run build` | 单文件 `dist/index.html` |
| 快照 | `npm run test:snapshot` | 从当前 TS 源码编译 CJS 测试快照 |
| 逻辑 | `npm run test:logic` | 生存 8 组 + 地形 23 组 |
| 光照 | `npm run test:light` | 天空光 / 方块光 / 跨区块 / 增量回收 21 组 |
| 服务 | `npm run test:services` | 容器 / 事件 / 插件 / 存档校验 46 项（含并发启用、初始化中停用、waitFor 清理、emit 门禁、级联停用） |
| 诊断 | `npm run test:diagnostics` | 运行时诊断组 20 组断言（健康快照 + 异常注入） |
| 地形体系 | `npm run test:terrain-system` | 方块扩充 + 阶段管线 + 群系配置表 20 组 |
| 实景 | `npm run test:smoke` | Chromium 桌面 + 移动端，含服务/插件/诊断/Config ACK 断言 |
| 视觉 | `npm run test:visual` | 昼夜 / 火光 / 全部内置方块展示墙 |
| 一键 | `npm run verify` | 以上全部 |

测试体系（快照机制、固定种子、新增测试规则）见 [TESTING.md](TESTING.md)。

浏览器测试参数可配置：`MC_HEADLESS=0 MC_GL=desktop` + `xvfb-run`
（需 `--enable-unsafe-swiftshader --disable-gpu-sandbox`）。CI 见
`.github/workflows/verify.yml`，要求实景测试 100% PASS。

> 软件渲染 FPS 约 10，引擎把 `dt` 钳制到 0.05 防穿墙，游戏时间流速约为真实的一半。
> 因此挖掘等耗时断言必须按条件轮询（`waitForFunction`），不能固定 sleep——本版已改。

---

## 8. 网格化管线（v1.3.0）

### 8.1 数据契约

`meshTypes.ts` 把「网格化真正需要的能力」与「活对象」解耦：

| 类型 | 作用 |
|---|---|
| `MeshSource` | mesher 唯一的数据入口：`getId / def / isOpaque / getSkyLight / getBlockLight / uv / greedy` |
| `MeshConfig` | 低频配置（方块元数据 + tile→UV 表 + greedy 开关 + revision），只在注册变化时重建 |
| `MeshSnapshot` | 单区块 + 1 格 halo 的 `data / sky / block` 三张 `Uint8Array`（各 18×80×18 ≈ 26KB），索引 `((y*W + lz+1)*W + lx+1)` |
| `PackedGeo` / `PackedMesh` | 可 Transfer 的 `Float32Array` / `Uint32Array` 几何（含每顶点 `sky/block`） |

同一份 `mesher.ts` 跑两种数据源：

- 主线程 `WorldMeshSource`：直读 `world.getBlock`（降级路径 / 基准对照）
- Worker `SnapshotMeshSource`：只读快照数组，**不 import three / World / Atlas**

> 早期方案打算给 Worker 单独写一份 mesher。实际做法是「一个算法 + 两个数据源」，
> 避免两套实现随迭代漂移 —— 这是本版最重要的结构决策。

### 8.2 调度

```
ChunkManager.update()
  ├─ 生成（预算 4ms）→ world.dirty.add
  ├─ 网格化（预算 6ms）→ 投递给 Worker 池（least-busy 选 wid，generation++）+ inFlight.set(key, gen)
  ├─ Worker.onmessage → pendingResults（带 wid 回显）
  └─ drain(): 丢弃 generation 过期的结果，按 wid 回退在途计数，其余 buildGeo + 上传
```

- **Worker 池（v1.3.0）**：默认 `min(hardwareConcurrency-1, 4)` 个 Worker（`?workers=N` 覆盖，夹紧 1..8）；
  派发时选「在途任务数最少」的 Worker（least-busy），解除单 Worker 吞吐上限；任一 Worker
  失败即整体 `fallbackToMain()`。`pickWorker()` 返回 wid 并记一笔在途，`drain` 时按 `wid` 回退。
- **代次去重**：同一区块连续改脏只会保留最新结果，旧结果直接丢弃（不再闪烁）。
- **在途取消**：区块卸载时从 `inFlight` 移除并 `generation++`，回传结果被识别为过期。
- **背压**：`dirty.size > 24` 时暂停生成，避免「生成快于网格化」造成的队列堆积。
- **自愈**：每帧扫描视距内「已生成但无网格」的区块并重新入队，任何漏标脏都会收敛。
- **降级**：Worker 构造或运行失败 → `fallbackToMain()` 切同步路径；`?mesher=main` 可强制。

### 8.3 Greedy Meshing

按 6 个面方向分别建 mask（`layer → dimU×dimV`），key = `方块 id | AO 档位 | 角点天空光 | 角点方块光`。

合并约束是**四角 AO 与四角角点光照都必须完全相等**：

1. GPU 对大 quad 做双线性插值，四角亮度不同就会被拉长成渐变；
2. 原逐面路径的 `flip`（对角线方向）由 AO 决定，四角相等时恒为 false，合并后三角化方向一致。

因此「合并」只改变顶点组织，不改变任何一个像素的着色。`test/mesher-check.cjs`
把网格展开成「通道 × 面方向 × 平面坐标 × 格坐标」的集合逐格比对，实测亮度差 `0.0e+0`。

合并面的局部 UV 为 `0..w / 0..h`，由 `tiledAtlas.ts` 的 `onBeforeCompile` 注入
`fract(vMapUv)` 平铺 —— 图集只有 16×16 格，不做平铺会采样到相邻贴图。

### 8.3.1 平滑光照（v1.5.1）

AO 一直是逐顶点的，光照却一直是「整面一个值」，所以墙面、地面在大片区域里是死平的。
v1.5.1 把光照也改成逐顶点：**每个角点取「空气侧」相邻 4 格光照的均值**（原版同款模型）。

- 采样范围：面法向固定在邻居格 N，法向之外的两个切向各跨 2 格 → 每个角点由 4 格决定。
- 实现：4 个角点合起来正好覆盖 N 周围切向的 3×3 补丁，所以先取一次 3×3 补丁（9 格），
  再让 4 个角点各取补丁里的 2×2 均值，比逐角点各取 4 格省一半采样。
- 粒度：角点光量化到 0~15（与体素光照同粒度），让「四角是否一致」是精确判定。
- 一致性：同一张面上相邻方块共享的角点取到的是同一组 4 格 → 角点光在方块边界两侧连续，无接缝。
- 代价：四角光照不一致的面**一律退回逐面输出**（否则合并面只能带一份光，渐变会被抹平），
  实测 quad 数 8039 → 8525（+6%），单区块网格化 CPU 34 ms → 35.8 ms（+5%）。

角点光不需要新的顶点属性：`aLight` 本来就是逐顶点的 vec2，只是此前 4 个顶点写的是同一个值。
快照契约（`data / sky / block` 三张 18×80×18 缓冲）也不变 —— 1 格 halo 已经足够取到角点所需的 4 格。

### 8.3.2 顶点布局与渲染通道（v1.5.1）

第 2 轮 3D 优化的三个改动都以**受控实验**的形式落地（设置 / 原始数据 / 判据见
[EXPERIMENTS.md](EXPERIMENTS.md)），这里只记结论与实现要点。

**顶点布局打包（E1）**：每顶点 60 B → 44 B。

| 旧 | 新 |
| --- | --- |
| `position(3) + uv(2) + color(3) + aLight(2) + aTileRect(4)` = 14 float / 60 B | `position(3) + uv(2) + aShade(1) + aLight(2) + aTileOrigin(2) + aTint(1)` = 11 float / 44 B |

- `color` 三分量同值（面定向 × AO），单分量 `aShade` 即可，shader 侧用 `vec3(vShade)`。
- 图集 tile 只需存**起点** `aTileOrigin(2)`，尺寸由新 uniform `uTileSize` 提供；
  片元里 `fract(vLocalUv)` 乘 `uTileSize` 再加起点，与原来的 `aTileRect` 等价。
- 收益只在显存与带宽，着色不变（`test/mesher` 与 `test:visual` 双重锁定）。

**抗锯齿分档（E2）**：`?aa=off|msaa|ssaa`，默认 `off`。

- `off`：原生分辨率，默认档。
- `msaa`：在 `WebGLRenderer` 构造时传 `antialias:true` —— 上下文属性只能在创建时决定，
  所以它在 boot 开头解析，且**不能运行时切换**。
- `ssaa`：`setPixelRatio(basePixelRatio × SSAA_SCALE)`，`SSAA_SCALE = 1.5`，
  受 `MAX_PIXEL_RATIO` 封顶；可运行时切换。

**自发光并入不透明通道（E3）**：萤石 / 南瓜灯 / 火把不再开独立 emissive 通道。

- 通道分配在 `mesher.ts` 的 `passFor()`：`lightEmission > 0` 的方块进 `opaque`，
  顶点开关 `aTint = 2`。
- shader 里 `unlit = step(1.5, vTint)`：自发光**跳过光照与植被染色**，
  但保留 `vShade`（面定向 × AO），否则会比旧通道亮一档。
- `?emerge=0` 保留并入前的独立 emissive 通道作对照，`MeshConfig.mergeEmissive`
  贯通 `mesher` / `chunkManager` / `main` 三处。
- 实测：draw call 64 → 47、emissive mesh 49 → 0、program 数不变，
  顶点缓冲与索引缓冲**逐字节相同**，15552 个归一化像素采样**零差异**。

### 8.4 性能取舍（实测）

| 指标 | 逐面 | Greedy |
|---|---|---|
| quad 数（6 区块，3 种子，v1.4.9） | 11,526 | 6,978（-39.5%） |
| quad 数（6 区块，3 种子，v1.5.1 平滑光照） | 12,507 | 8,525（-31.8%） |
| 单区块网格化 CPU（Node，冷启动） | 25 ms | 35 ms |
| 浏览器内单区块网格化 | ~7 ms | ~8.7 ms |

CPU 略升来自「按面扫描 + 每个可见面一次 AO」；因为整段已移出主线程，渲染不再被阻塞。
v1.3.0 已按 `navigator.hardwareConcurrency` 起 Worker 池（least-busy 派发）把吞吐补回来。

> 注：逐面基线从 11,526 涨到 12,507，是平滑光照把一部分面从「合并面」退回「逐面」所致
> （面覆盖集合本身不变，只是 quad 组织方式变了）。

顶点布局与渲染通道的收益不在这张表里：v1.5.1 把每顶点从 60 B 压到 **44 B**（-26.7%），
自发光并入不透明通道把 draw call 从 64 降到 47，两者都不改变着色（见 §8.3.2 与
[EXPERIMENTS.md](EXPERIMENTS.md)）。

## 8.5 运行时诊断组（v1.3.2）

`src/diagnostics/RuntimeDiagnostics.ts` 只接收组装根收集的只读快照，不依赖 three / DOM
业务对象，因此浏览器与 Node 共用同一套检查：

| 入口 | 用途 |
|---|---|
| `CraftAPI.diagnostics.run()` | 手动执行全部检查，返回 `{ ok, checked, errors, warnings, issues, durationMs }` |
| `CraftAPI.diagnostics.last()` | 最近一次自动采样结果 |
| F3 面板 | 显示「运行时诊断」行 |
| `__mc.diagnostics` | 控制台调试入口 |
| 自动采样 | 每 10 秒一次；异常集合变化时才 `console.groupCollapsed` 输出 |

覆盖的不变量：版本一致、玩家坐标/摔落值、playing 输入状态、暂停态残留按键、Worker 配置
ACK、Worker 池大小、未初始化光照、幽灵网格、视距内缺网格、网格积压、插件 failed、事件
订阅、生存数值与死亡状态一致、实体数量、存档脏标记老化。

Worker 现在对每条 `config` 消息回传 `config-ack`；`ChunkManager.configReady` 只有在所有
Worker 都确认当前 `revision` 后才为 true。运行时注册方块 / 纹理后，`invalidateConfig()`
会立即重建并下发配置，同时把已有网格重新入队。

## 8.6 地形生成管线（v1.4.0）

`DefaultGenerator.generateChunk()` 不再是一段 100 行的流水账，而是
「构建上下文 → 按固定阶段派发」：

| 阶段 | 职责 | 关键约束 |
|---|---|---|
| `columns` | 地形柱、陡坡露石、雪线、浅海黏土、水、渐隐洞穴 | 水下地层不挖洞穴，避免空气袋 |
| `ores` | 分层矿脉（煤 / 铁 / 金 / 钻石 / 萤石 + 铜 / 红石 / 青金石 / 绿宝石 / 花岗岩） | 只替换石头；`biome` 限制的矿脉逐格校验群系边界 |
| `trees` | 跨区块树木（橡树 / 白桦 / 云杉 / 金合欢 / 樱花，树种权重来自配置表） | 由世界坐标候选点决定，邻区块裁剪结果一致 |
| `decorate` | 花草 / 仙人掌 / 甘蔗 / 海草 / 海带 / 睡莲 / 南瓜 | 只写在配置表地表方块之上，不覆盖树冠，四邻水位校验 |

地表 / 填充 / 装饰 / 浅滩黏土 / 仙人掌 / 甘蔗 / 树种 / 水下植物 / 睡莲 / 南瓜由
`BIOME_PROFILES`（11 个群系）统一描述，构造时解析为方块 id；`TERRAIN_STAGES` 与实例
`stageNames` 是对外可读的契约，`test/terrain-system-check.cjs` 直接断言阶段顺序与
配置表驱动的自然生成位置。

## 8.7 植物生态与能量体系（v1.4.1）

`Botany`（`src/world/botany.ts`）是独立于地形生成的运行时生态层：

| 设计点 | 实现 |
|---|---|
| 采样 | 每 0.3s 在玩家周围 24 格内随机取 56 列（移动端 24 列），只处理已生成区块 |
| 高度分布 | 72% 贴地表 ±2 格（花草 / 草方块 / 树苗），28% 深入地下（蘑菇 / 地衣） |
| 规则表 | 按方块名分派：柱状生长、作物阶段、树苗长树、草方块 / 花草 / 藤蔓 / 睡莲 / 水草 / 地衣蔓延、支撑检查与整列枯萎 |
| 内在能量 | `plantTraits.ts` 声明代谢类型 / 开花阈值 / 生长耗能 / 共享参数；`Botany` 为每株植物维护 0~100 能量，先充能再执行规则，能量不足则跳过 |
| 环境判定 | solar：天空光 × 昼夜与方块光取大，土壤 +2；hydro：四邻水体或连续水草列；fungal：有效光照 <8，火光（方块光 ≥13）会灼伤 |
| 根系网络 | 能量 ≥80 的植物向同代谢类型邻居转移富余能量；向日葵 / 发光地衣为枢纽（半径 4/3） |
| 采集 | 能量达到 `bloom` 后空手右键或破坏结算：花蜜 / 额外种子 / 浆果；采集消耗 45 能量，浆果丛退回未成熟 |
| 树形 | 与地形阶段共用 `buildTree()`（`src/world/trees.ts`），自然树与树苗树形一致 |
| 事件 | 写入发出 `plant:grow`（grow / spread / decay / ripen / harvest）；开花 / 采集发出 `plant:bloom` 驱动粒子 |
| 性能 | 单帧代价只与采样次数相关；能量表上限 4096 条按最旧淘汰，不做全图植物表。`test:botany` / `test:plant-energy` 覆盖全部规则 |

### 8.7.1 v1.6 植物系统深化

四个纯数据模块承担规则复杂度，`Botany` 作为唯一状态协调者：

| 模块 | 接口 | 职责 |
|---|---|---|
| `src/world/ecology.ts` | `seasonAt(day)` / `weatherAt(seed,day)` / `modifiers(env)` | 6 日一季的历法（一年 24 日）、seed 派生天气、三代谢倍率表；默认 spring/clear 全为 1，`Botany.update/tickAt` 的可选 `env` 不传时保持旧行为逐值中性 |
| `src/world/drops.ts` | `rollDrops(specs, ctx)` | 稳定哈希判定掉落，替代玩家 / 实体两处 `Math.random`；支持 chance / 数量区间 / 昼夜 / 群系条件 |
| `src/world/soil.ts` | `nutrientAt/consume/enrich/returnToSoil` | 与能量并行的土壤养分场；未跟踪格返回 100（天然肥沃），懒初始化保证旧测试中性；上限 1024 |
| `src/world/compost.ts` | `levelOf/nextId/harvestOf` | 堆肥桶等级编码进 block id 110~118，借 `world.edits` 免费持久化；无需独立状态表 / 存档字段 |

新增状态与约束：
- `Botany` 持有 `energy` / `soil` / `env` 三份状态；`grow()` 成功写入后才扣能量与养分，失败都不扣；`decay()` / 破坏采集归还半份养分。
- 玩家空手右键采集蓄能植物；手持 `item:fertilizer`（+35 养分）/ `item:bone_meal`（+55 养分且 +15 能量）右键目标格施肥。
- 猪 / 羊 12% 掉有机肥，新增骷髅怪（夜间 hostile，75% 掉骨粉）；掉落判定全部走 `rollDrops`。
- `Botany.serializeEcology()/restoreEcology()`：紧凑元组存档，逐条校验坐标 / id / trait / 数值范围，同锚点去重、植物与土壤分别截断 1024；坏档丢弃不抛错。`SaveData` 加可选 `botany/dayCount`，`Sky.setTime()` 回填天数。
- `block:break/place` 订阅额外清掉同 x,z 且同 id 的锚点能量，修复柱状 / 藤蔓中间段被拆后残留储能。

## 9. 后续路线（带验收标准）

| 版本 | 目标 | 可机械检查的验收标准 |
|---|---|---|
| v1.3.0 | Worker 池（least-busy 派发） | 实景 `workerCount ≥ 1` 断言，回归全绿，多核环境吞吐随核数线性提升 |
| v1.3.0 | 天空光 / 方块光（已完成） | `light-check` 21 项断言（v1.3.1 补遮光回收、跨区块天窗与幂等往返回归）；mesher 面覆盖与光照逐格一致 |
| v1.4.0 | 方块扩充 + 地形生成体系整合（已完成） | `terrain-system-check` 18 组断言：id 45~54 末位追加、阶段顺序、10 种新方块自然生成位置 |
| v1.4.1 | 植物生态 + 内在能量体系（已完成） | 35 种植物 / 树种 append-only；`botany-check` 28 组 + `plant-energy-check` 29 组断言 |
| v1.6.0 | 花海扩充 + 植被表现力（已完成） | 追加 28 种植物（id 92~119）、花圃 / 浮萍 / 洞穴发光植物、植物高度分层与风摆；`terrain-system` 42 组 + `botany` 34 组 + `plant-energy` 32 组断言 |
| v1.4.2 | 透明通道按距离排序 | 玻璃/水叠加无穿帮截图断言 |
| v1.5.0 | 合成系统（已完成） | `crafting-check` 43 组断言：配方表结构、有序 / 无序匹配、3×3 内偏移摆放、材料组、背包取放闭环 |
| v1.4.3 | AABB 脱困 | 被方块包围时可在 2 秒内脱出 |
| v1.4.4 | 光照服务化（可选） | `LightEngine` 经 `ServiceContainer` 注入且不修改 main.ts 业务代码 |
| v2.0 | 护甲 / 联机 | 以插件形式实现，不新增 `main.ts` 事件接线 |

**当前建议**：不要先上合成/护甲/更多怪物。地形生成已收敛为可测试的阶段管线，
下一步做透明排序与 AABB 脱困。

## 生态扩展点（v1.4.3）

`src/world/plantRules.ts` 提供 `PlantRuleRegistry`（按 owner 批量注销、按方块 id
动态解析名称、支持一个方块命中多条规则）。`Botany` 持有该表，在 `applyAt()` 的
内置分支全部未命中时才构造 `PlantRuleContext` 分派；上下文只暴露读世界、带能量
消耗的写入、能量微调三类能力，写入统一经 `plant:grow` 事件，插件拿不到 `World`。

`CraftAPI.botany` 是对应门面，`PluginService.scopeAPI()` 按 `botany:register`
权限裁剪写入口。内置插件 `core:botany-expansion` 的数据与规则放在
`src/plugins/builtin/botanyContent.ts`（纯数据，可编译进测试快照），装配逻辑放在
`botanyExpansion.ts`。依赖方向仍是 `main.ts → services → api → 业务模块`，
插件不 import 引擎内部实现。

**v1.6 增强**：`PlantRuleContext` 新增 `day()/season()/weather()/soil(x,y,z)/enrichSoil(x,y,z,delta)`；
`PlantRule.priority?: number` 让 `ruleFor()` 按 `(priority, id)` 双键稳定排序（同优先级按
id 字典序），`list()` 暴露 priority。内置扩展包现含 4 条规则（含雨天水生补能演示）。

**确定性掉落接缝**：`rollDrops(specs, ctx)` 是掉落判定的唯一接缝——测试直接对纯函数
断言概率 / 区间 / 条件，玩家与实体只是两个 adapter（分别以 `b:x,y,z` 与 `e:id:serial`
为来源标识），新增掉落来源不必改判定逻辑。
