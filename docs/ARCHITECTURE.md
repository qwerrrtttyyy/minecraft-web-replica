# Minecraft TS 架构说明（v1.6.0）

> 目标：把**插件**与**事件**相关的 API 从 `main.ts` 中彻底独立为服务，形成可替换、
> 可测试、有生命周期的架构分层；同时修复实测暴露的缺陷并补齐工程化闭环。
> v1.5.0 在此之上引入 **WASM 运行时服务**与**插件体系 v2**，两者共用同一套
> 「服务容器注入 + 权限裁剪 + 可回退」的工程约束。

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
| `src/services/plugins/` | `PluginContext` 契约、`PluginService` v2、`scopeAPI` 权限裁剪；`semver` / `storage` / `loader` 为子模块 |
| `src/wasm/` | WASM 协议、内核加载、等价性自检、`WasmRuntime` 服务（零网络 / 同步实例化 / 自动回退） |
| `src/world/noiseMath.ts` | 唯一 JS 噪声参考实现：WASM 对拍基准与运行期回退路径 |
| `native/` | freestanding C 内核源码与 clang 编译产物（`.wasm` 提交进仓库） |
| `src/api/` | `CraftAPI` 门面：旧 22 项 + `plugins` / `events` / `botany` / `wasm` 命名空间 |
| `src/plugins/builtin/` | 默认启用的内置插件（含 `core:wasm-monitor`）；`deps.ts` 定义 `TOKENS.BuiltinDeps` 契约 |
| `src/plugins/example/` | 插件开发示例（`welcome` 与 `wasmProbe`，均不默认启用） |
| `src/diagnostics/` | 运行时诊断组：只读快照检查、F3 / CraftAPI 报告、每 10 秒自动采样 |

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
    dependencies?: string[];       // 支持 id@^1.2.0 约束，循环依赖拦截
    optionalDependencies?: string[];  // v1.5.0：缺失/失败只记 warning
    permissions?: PluginPermission[];
    apiVersion?: string;           // v1.5.0：兼容的引擎插件 API 范围
    capabilities?: string[];       // v1.5.0：声明式能力发现
    priority?: number;             // v1.5.0：enableAll 启用顺序
    timeoutMs?: number;            // v1.5.0：异步 setup 超时保护
    config?: Record<string, unknown>; // v1.5.0：默认配置
  };
  setup(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}
```

`PluginContext` 提供：`id`、`events`（EventChannel）、`services`（容器）、
`api`（按权限裁剪的 CraftAPI 视图）、`log`、`onDispose(fn)`；
v1.5.0 增加 `manifest`（冻结快照）、`apiVersion`、`config`（只读合并）、
`storage`（命名空间 KV）、`provide/require/tryRequire`（插件私有服务，卸载自动回收）。

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
| `botany:register` | `botany.registerPlant` / `registerRule` / `unregister*` |
| `wasm:use` | `wasm.call` / `callModule` / `registerModule` / `setEnabled`（v1.5.0） |
| `plugins:manage` | `plugins.register` / `enable` / `disable` / `unload` / `reload` / `install`（v1.5.0） |

未声明的写能力在插件上下文里会抛错（读能力默认全开）。初始化失败被隔离为
`failed` 并发出 `plugin:error`，**不会拖垮启动流程**。v1.5.0 之前任何插件都能
调用 `CraftAPI.plugins.unload()` 卸载别的插件，`plugins:manage` 权限修复了这个缺口。

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
| 服务 | `npm run test:services` | 容器 / 事件 / 插件 / 存档校验 43 项（含并发启用、初始化中停用、waitFor 清理） |
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
| `trees` | 跨区块树木（橡树 / 白桦 / 云杉，树种权重来自配置表） | 由世界坐标候选点决定，邻区块裁剪结果一致 |
| `decorate` | 花草 / 仙人掌 / 甘蔗 / 海草 / 海带 / 睡莲 / 南瓜 | 只写在配置表地表方块之上，不覆盖树冠，四邻水位校验 |

地表 / 填充 / 装饰 / 浅滩黏土 / 仙人掌 / 甘蔗 / 树种 / 水下植物 / 睡莲 / 南瓜由
`BIOME_PROFILES`（7 个群系）统一描述，构造时解析为方块 id；`TERRAIN_STAGES` 与实例
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

## 9. 后续路线（带验收标准）

| 版本 | 目标 | 可机械检查的验收标准 |
|---|---|---|
| v1.3.0 | Worker 池（least-busy 派发） | 实景 `workerCount ≥ 1` 断言，回归全绿，多核环境吞吐随核数线性提升 |
| v1.3.0 | 天空光 / 方块光（已完成） | `light-check` 21 项断言（v1.3.1 补遮光回收、跨区块天窗与幂等往返回归）；mesher 面覆盖与光照逐格一致 |
| v1.4.0 | 方块扩充 + 地形生成体系整合（已完成） | `terrain-system-check` 18 组断言：id 45~54 末位追加、阶段顺序、10 种新方块自然生成位置 |
| v1.4.1 | 植物生态 + 内在能量体系（已完成） | 35 种植物 / 树种 append-only；`botany-check` 28 组 + `plant-energy-check` 29 组断言 |
| v1.4.2 | 透明通道按距离排序 | 玻璃/水叠加无穿帮截图断言 |
| v1.4.3 | AABB 脱困 | 被方块包围时可在 2 秒内脱出 |
| v1.5.0 | WASM 内核 + 插件体系 v2（已完成） | `wasm:check` / `test:wasm` 24 项 / `test:plugin-v2` 21 项；1705 项噪声逐位对拍零差异，自检失败自动回退纯 JS |
| v1.6.0 | 插件三载体 + 扩展点注册表（已完成） | `test:plugin-carrier` 15 项；`wasm:module` 零 import + `wasm:host` 白名单 host-import（真实 clang fixture）；`ExtensionRegistry` owner 隔离；`worldgen:column` / `gameplay:tick` 扩展点；插件 API 2.1.0 |
| v1.4.4 | 光照服务化（可选） | `LightEngine` 经 `ServiceContainer` 注入且不修改 main.ts 业务代码 |
| v2.0 | 合成 / 护甲 / 联机 | 以插件形式实现，不新增 `main.ts` 事件接线 |

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

## WASM 服务与插件体系 v2（v1.5.0）

```
                    ┌─────────────────────────────────────────────┐
                    │ main.ts（组装根）                            │
                    │ createServices → WasmRuntime.init() →        │
                    │ provide(TOKENS.Wasm) → new DefaultGenerator │
                    └──────────────┬──────────────────────────────┘
                                   │ 注入 / 事件
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌────────────────┐      ┌──────────────────────┐   ┌──────────────────┐
│ WasmRuntime    │      │ PluginService v2     │   │ CraftAPI 门面    │
│ 自检 / 回退 /  │◄────►│ semver / 超时 / 重载 │◄─►│ wasm + plugins   │
│ 模块注册表     │      │ storage / 私有服务   │   │ 权限裁剪         │
└───────┬────────┘      └──────────────────────┘   └──────────────────┘
        │ installNoiseBackend(factory)
        ▼
┌────────────────────────────────────────────────────────────┐
│ Noise（后端选择）── WASM 内核（每实例独立 memory）           │
│                └─ noiseMath.ts（唯一 JS 参考 / 回退基准）     │
└────────────────────────────────────────────────────────────┘
```

**关键顺序**：`WasmRuntime.init()` 必须在 `new DefaultGenerator()` 之前完成，
否则已构造的 `Noise` 实例不会持有 WASM 后端。这也解释了为什么 WASM 不进
网格化 Worker —— 地形生成在主线程，Worker 只消费区块快照，无需改消息协议。

**分层不变量**：

1. `noiseMath.ts` 是唯一 JS 数值参考；C 内核与它逐位对拍，任何差异都被视为缺陷，
   而不是「近似相等」。
2. `WasmRuntime` 是服务容器里的一等公民（`TOKENS.Wasm`），插件只通过
   `CraftAPI.wasm` 或 `ctx.services.require(TOKENS.Wasm)` 访问，不 import 内核实现。
3. 插件自定义 WASM 模块必须零 import、体积/内存/导出受限，只开放数值调用，
   形成「插件 → WASM」的受控扩展点。
4. 所有新增写能力（`wasm:use` / `plugins:manage`）都落在 `scopeAPI` 裁剪内，
   读能力默认全开。
5. 失败一律降级：内核加载失败、自检不过、运行期异常 → 卸载后端、发
   `wasm:fallback`、状态落 `fallback`，游戏行为与 v1.4.3 完全一致。

完整 ABI、编译流程、性能数据与故障排查见 [WASM.md](WASM.md)；
插件 v2 的字段与回归清单见 [TESTING.md](TESTING.md)。

## 插件三载体与扩展点注册表（v1.6.0）

v1.5.0 的 WASM 只是「被动数值后端」；v1.6.0 让 WASM 成为**与 JS 对等的一等插件载体**，
并给所有载体一个统一的扩展落点。分层不变量不变：插件不 import 引擎内部实现，只经
`PluginContext` / `CraftAPI` / `ExtensionRegistry` 交互。

```
PluginDefinition = manifest + ( setup(ctx) | carrier )
                              │              │
                       js（原样）      wasm:module / wasm:host
                                             │
                              CarrierHost 适配成统一 setup/teardown
                                             │
                     PluginService（依赖 / 权限 / 代次 / 超时 / 存储，全部复用）
                                             │
                              ExtensionRegistry（owner 隔离）
                            ┌────────────────┴────────────────┐
                    worldgen:column                     gameplay:event / tick
                 （World.ensureChunk 后）              （事件桥接 + 主循环 0.5s）
```

**三种载体**

- `js`：`setup(ctx)` 一等公民，写法零改动。
- `wasm:module`：零 import 模块，激活时注册为插件私有数值模块，经
  `ctx.api.wasm.callModule` 被动调用，复用 `compilePluginModule` 安全边界。
- `wasm:host`：声明白名单 host import 的模块，经 `planGrants` 按权限注入（`env.mc_*`），
  白名单外 import 在实例化阶段直接被拒；缺权限的能力注入「调用即抛错桩」以便降级加载。
  导出 `mc_plugin_abi` / `_start` / `_dispose` / `mc_hook`，通过 scratch 内存 + UTF-8
  编解码交换文本 payload。二者都复用同一套生命周期，只是「激活函数」不同。

**扩展点**：`ExtensionRegistry` 按 point 注册、按 owner 隔离、按 priority 排序，单个
handler 抛错被隔离（记入 `errors`，不影响其它 handler）。已落地两层：

1. `worldgen:column` —— 在 `World.ensureChunk` 生成后、应用玩家编辑前派发，
   payload 提供区块坐标与 get/setBlock，WASM 钩子与 JS 回调都能改地形。
2. `gameplay:event` / `gameplay:tick` —— host 插件经 `mc_ext_register` 订阅 GameEvents，
   主循环每 0.5 秒派发一次 tick，避免逐帧跨界抖动。

**权限**：新增 `events:subscribe`（host 插件订阅游戏事件）。`mc_world_set` 走
`ctx.api` 的 `world:write` 裁剪，`mc_storage_*` 走命名空间 KV，无越权路径。

ABI、host import 白名单表、fixture 编译与示例见 [PLUGINS.md](PLUGINS.md)。
