# 插件体系：三载体与扩展点（v1.6.0）

> v1.5.0 的插件体系解决了「插件如何加载 / 依赖 / 鉴权」；v1.6.0 回答两个新问题：
> **插件可以用什么实现**（JS / 纯计算 WASM / 宿主导入 WASM），以及
> **插件能扩展哪里**（统一扩展点注册表）。二者都不改变已有 JS 插件的任何写法。

---

## 1. 三种载体（Carrier）

`PluginDefinition` 的 `setup`（JS）与 `carrier`（WASM）二选一，由 `PluginService` 统一生命周期：

| 载体 | 实现体 | 能做什么 | 典型用途 |
| --- | --- | --- | --- |
| `js`（默认） | `setup(ctx)` 函数 | 全部（ctx.api / ctx.events / ctx.extensions） | 游戏逻辑、UI、内容包 |
| `wasm:module` | 零 import WASM 模块 | 注册为插件私有数值模块，被动调用 | 数学 / 哈希 / 编解码 / 确定性计算 |
| `wasm:host` | 受控白名单 import 的 WASM 模块 | 主动读世界、订阅事件、注册扩展点、读写私有存储 | 需要引擎交互的沙箱逻辑 |

载体只是「激活函数 + 清理函数」，依赖解析、semver 约束、权限裁剪、代次保护、setup 超时、
命名空间存储、能力发现全部复用同一套实现——WASM 插件与 JS 插件在生命周期上完全对等。

### 1.1 `wasm:module`（纯计算）

零 import（复用 `compilePluginModule` 的安全边界），激活时经 `WasmRuntime.registerModule` 注册：
停用自动注销。调用走 `ctx.api.wasm.callModule(id, fn, ...)`（需 `wasm:use` 权限）。
注册载体本身同样要求 manifest 声明 `wasm:use`——否则零权限插件可以绕过 `scopeAPI` 直接注册并实例化模块。

```ts
CraftAPI.plugins.register({
  manifest: { id: 'me:math', permissions: ['wasm:use'] },
  carrier: { kind: 'wasm:module', bytes: base64OrBytes, moduleId: 'me:math' },
});
await CraftAPI.plugins.enable('me:math');
// 之后：ctx.api.wasm.callModule('me:math', 'add', 2, 3)
```

### 1.2 `wasm:host`（完整宿主导入）

编译后的模块必须满足以下 ABI（详见 `native/host_plugin_fixture.c` 这个可运行范例）：

| 类别 | 名称 | 说明 |
| --- | --- | --- |
| 导入 | `env.mc_log(ptr,len)` | 经插件命名空间输出日志（读能力） |
| 导入 | `env.mc_now() / mc_rand()` | 单调时钟 / 确定性 PRNG（按插件 id 播种） |
| 导入 | `env.mc_world_seed() / mc_world_get() / mc_world_height()` | 读世界（读能力） |
| 导入 | `env.mc_world_set(x,y,z,id)` | 写方块（需 `world:write`） |
| 导入 | `env.mc_wasm_call(namePtr,nameLen,...)` | 调内置内核导出（需 `wasm:use`） |
| 导入 | `env.mc_ext_register(ptr,len) -> kind` | 注册扩展点，返回 `POINT_KINDS` 整数 |
| 导入 | `env.mc_storage_get/set(...)` | 读写插件私有存储（命名空间隔离） |
| 导出 | `mc_plugin_abi() -> 1` | ABI 校验，不匹配拒绝激活 |
| 导出 | `memory` / `mc_scratch_ptr` / `mc_scratch_size` | 文本传递的线性内存与暂存区 |
| 导出 | `_start()` | 激活时调用（注册扩展点） |
| 导出 | `mc_hook(kind,a,b,c,d)` | 扩展点 / 事件回调入口 |
| 导出 | `_dispose()`（可选） | 停用时调用 |

**白名单即安全边界**：`WebAssembly.Module.imports` 里任何非 `env` 模块或未列举的函数名
（如示例负例 `native/bad_host_fixture.c` 的 `mc_evil`）都会让插件激活失败、隔离为 `failed`。
权限不足或 `carrier.hostImports` 未声明的能力会注入「调用即抛错」桩——插件能加载降级，
但越权调用一定失败，绝不静默成功。

字符串通过线性内存 `ptr+len` 传递（UTF-8，带边界检查）；宿主与模块共用 `POINT_KINDS` 整数表，
避免让 C 代码解析 JSON。payload 由 `payloadNumbers(point, payload)` 摊平成 4 个数值。

示例插件见 `src/plugins/example/wasmHostPlugin.ts`：

```js
CraftAPI.plugins.register(wasmHostPlugin);
await CraftAPI.plugins.enable('example:wasm-host');
CraftAPI.extensions.list();   // 看到它注册的 worldgen:column / gameplay:tick
```

---

## 2. 扩展点注册表（ExtensionRegistry）

`ctx.extensions.register(point, owner, handler, priority?)` 注册；`owner` 通常就是插件 id，
插件停用 / 卸载时由 `PluginService` 自动 `unregisterOwner(id)`，与事件通道一起彻底清理。

- **确定性顺序**：按 `priority` 降序、同优先级按注册序号升序同步派发 → 世界生成可复现。
- **错误隔离**：单个处理器抛错不中断其余，错误进 `emit()` 返回值与 stats。
- **只读门面**：`CraftAPI.extensions.points/stats/has/list` 供诊断与能力发现；注册必须走 `ctx.extensions`。

已落地的两层：

### 2.1 事件与游戏逻辑

`GameEvents` 通过 `EVENT_TO_POINT` 映射到 `event:*` 扩展点。JS 插件用 `ctx.events.on(type, ...)`；
WASM 插件在 `_start()` 里 `mc_ext_register` 对应扩展点（需 `events:subscribe` 权限），
宿主桥接到带命名空间的 `ctx.events`，卸载自动撤销。映射表（`hostABI.ts`）：

`block:place` / `block:break` / `chunk:generated` / `player:move` / `entity:spawn` / `survival:damage`。

另有 `gameplay:tick`（组装根以 2Hz 派发，无需事件权限），供周期性插件逻辑使用。

### 2.2 世界生成与地形

`worldgen:column` 在 `World.ensureChunk` 中、`generator.generateChunk` 之后、应用存档编辑与
光照初始化之前派发。载荷：

```ts
interface WorldgenColumnPayload {
  cx: number; cz: number; data: Uint8Array;
  get(x, y, z): number;              // 世界坐标读（区块内，越界返回 0）
  set(x, y, z, id): void;            // 生成期写入：不记编辑、不标脏
}
```

时机选择保证两点：玩家编辑仍覆盖插件写入（编辑在后），且新方块参与光照初始化（光照在后）。
JS 插件通过 `ctx.extensions.register('worldgen:column', …)` 注册时需要 `world:write` 权限；
WASM 插件在 `mc_hook` 里对 `kind === POINT_KINDS['worldgen:column']` 调用 `mc_world_set`，
写副作用同样受 `world:write` 门控，`a/b` 参数是 `cx/cz`（见 fixture）。

> 仅当注册了对应扩展点时才构造 payload，`extensions.has()` 短路，热路径零开销。

---

## 3. 新增权限

| 权限 | 放开的能力 |
| --- | --- |
| `events:subscribe` | WASM host 插件经 `mc_ext_register` 桥接 `GameEvents` 订阅 |

`world:write` / `wasm:use` 维持原有语义，WASM host 导入沿用同一套 `scopeAPI` 裁剪。

---

## 4. 版本与兼容

- 项目版本 `1.6.0`，插件 API 契约 `2.1.0`（`manifest.apiVersion` 声明 `^2.1.0` 可要求新载体）。
- v1.2~v1.5 的 JS 插件（只写 `setup`）**零改动**；声明 `apiVersion: '^2.0.0'` 仍满足 2.1.0。
- 热重载（`reload()`）保持 v1.5 现状，本次未增强；按需求不实现新的热替换。

## 5. 构建与回归

```bash
npm run build:plugin-fixtures   # 仅改 native/*_fixture.c 后需要（clang wasm32）
npm run test:plugin-carrier     # 15 项：三载体 + 白名单 + 权限 + 生命周期
```

`native/host_plugin_fixture.wasm` / `bad_host_fixture.wasm` 与内联 base64 已提交，
CI 只跑测试不编译。设计约定与负例见 `test/plugin-carrier-check.cjs`。
