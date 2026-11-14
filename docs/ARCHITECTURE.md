# Minecraft TS 架构说明（v1.3.0）

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
| `world:write` | `world.setBlock` |
| `player:write` | `player.teleport` / `setFly` / `break` / `place` |
| `save:write` | `save.import` / `setProvider` |
| `api:emit` | `CraftAPI.emit` |
| `blocks:register` | `registerBlock` / `registerTile` / `registerEntity` / `setGenerator` |

未声明的写能力在插件上下文里会抛错（读能力默认全开）。初始化失败被隔离为
`failed` 并发出 `plugin:error`，**不会拖垮启动流程**。

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
| 服务 | `npm run test:services` | 容器 / 事件 / 插件 / 存档校验 31 项 |
| 实景 | `npm run test:smoke` | Chromium 桌面 + 移动端，含服务/插件断言 |
| 一键 | `npm run verify` | 以上全部 |

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
| `MeshSource` | mesher 唯一的数据入口：`getId / def / isOpaque / uv / greedy` |
| `MeshConfig` | 低频配置（方块元数据 + tile→UV 表 + greedy 开关 + revision），只在注册变化时重建 |
| `MeshSnapshot` | 单区块 + 1 格 halo 的 `Uint8Array`（18×80×18 ≈ 26KB），索引 `((y*W + lz+1)*W + lx+1)` |
| `PackedGeo` / `PackedMesh` | 可 Transfer 的 `Float32Array` / `Uint32Array` 几何 |

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

按 6 个面方向分别建 mask（`layer → dimU×dimV`），key = `方块 id | AO 档位`。

合并约束是**四角 AO 必须完全相等**：

1. GPU 对大 quad 做双线性插值，四角亮度不同就会被拉长成渐变；
2. 原逐面路径的 `flip`（对角线方向）由 AO 决定，四角相等时恒为 false，合并后三角化方向一致。

因此「合并」只改变顶点组织，不改变任何一个像素的着色。`test/mesher-check.cjs`
把网格展开成「通道 × 面方向 × 平面坐标 × 格坐标」的集合逐格比对，实测亮度差 `0.0e+0`。

合并面的局部 UV 为 `0..w / 0..h`，由 `tiledAtlas.ts` 的 `onBeforeCompile` 注入
`fract(vMapUv)` 平铺 —— 图集只有 16×16 格，不做平铺会采样到相邻贴图。

### 8.4 性能取舍（实测）

| 指标 | 逐面 | Greedy |
|---|---|---|
| quad 数（6 区块，3 种子） | 11,526 | 6,978（-39.5%） |
| 单区块网格化 CPU（Node，冷启动） | 25 ms | 35 ms |
| 浏览器内单区块网格化 | ~7 ms | ~8.7 ms |

CPU 略升来自「按面扫描 + 每个可见面一次 AO」；因为整段已移出主线程，渲染不再被阻塞。
v1.3.0 已按 `navigator.hardwareConcurrency` 起 Worker 池（least-busy 派发）把吞吐补回来。

## 9. 后续路线（带验收标准）

| 版本 | 目标 | 可机械检查的验收标准 |
|---|---|---|
| v1.3.0 | Worker 池（least-busy 派发） | 实景 `workerCount ≥ 1` 断言，回归全绿，多核环境吞吐随核数线性提升 |
| v1.4.0 | 透明通道按距离排序 | 玻璃/水叠加无穿帮截图断言 |
| v1.4.1 | AABB 脱困 | 被方块包围时可在 2 秒内脱出 |
| v1.5.0 | 光照传播服务 | 新服务经 `ServiceContainer` 注入，不修改 main.ts 业务代码 |
| v2.0 | 合成 / 护甲 / 联机 | 以插件形式实现，不新增 `main.ts` 事件接线 |

**当前建议**：不要先上合成/护甲/更多怪物。地基（竞态、背压、Worker 池、测试闭环）已补齐，
下一步做透明排序与光照。
