# PR 描述草稿：v1.4.3 → v1.6.0 全面优化（WASM 内核 + 插件三载体 + 代码审查修复）

> 说明：本仓库源码通过 GitHub codeload 获取，本地不含原始 git 历史。提交前请在你有写权限的
> fork 上 `git remote add origin <你的 fork URL>` 并认证（`gh auth login` 或配置 token），
> 再推送分支并开 PR。本文件可直接作为 PR body 使用。

## 摘要

对 `minecraft-web-replica` 做了三阶段系统性增强，版本从 **1.4.3** 推进到 **1.6.0**，
插件 API 从 2.0.0 推进到 **2.1.0**，全程保持单文件 `file://` 可运行与全部回归绿。

## 变更内容

### 1. 真实 WebAssembly 计算内核（v1.5.0）
- `native/mc_kernel.c`：freestanding C，clang `--target=wasm32` 编译为 2473B、零 import、14 导出的真实 `.wasm`。
- base64 内联进 `kernelBinary.ts`，运行时同步实例化，无网络依赖；CI 仅校验产物一致性，不依赖 clang。
- 噪声数学抽为唯一 JS 参考 `noiseMath.ts`；`WasmRuntime` 能力检测 → ABI/指纹校验 → 1705 项逐位对拍 → 安装后端。
- 任何失败自动回退纯 JS；`?wasm=0` 强制关闭；F3 诊断新增 4 项 WASM 检查；`CraftAPI.wasm` 命名空间。
- 批量基准（`mc_fbm2_batch`）：批量吞吐 1.7~3.4×，逐点跨界略慢（文档已如实记录）。

### 2. 插件体系 v2 + 三载体（v1.5.0 / v1.6.0）
- manifest 扩展：semver 依赖约束、可选依赖、`apiVersion`、`capabilities`、`priority`、`timeoutMs`、`config`。
- 权限加固：新增 `wasm:use` / `plugins:manage` / `events:subscribe`，scopeAPI 按权限裁剪。
- 生命周期：依赖解析、setup 超时、反向依赖保护、`reload`、`enableAll`、`stats`、命名空间存储、私有服务。
- **三载体对等**：`js`（setup）、`wasm:module`（零 import 纯计算）、`wasm:host`（白名单 host-import，
  可主动读世界/订阅事件/注册扩展点/私有存储）。白名单外 import 在实例化阶段直接拒绝。
- `ExtensionRegistry`：按 owner 隔离、priority 排序、异常隔离；已落地 `worldgen:column` 与
  `gameplay:event` / `gameplay:tick` 两层扩展点。含真实 clang 编译的 host 插件 fixture 与示例。

### 3. 代码审查修复（本次）
审查全部 8 项发现并逐一修复，另加针对性回归：

| 级别 | 修复 |
|---|---|
| 中 M1 | `EventService.once` 加幂等标志，重入不重复回调、不泄漏订阅 |
| 中 M2 | 抽出带操作名的停用/卸载共用实现，`unload` 错误明确指向"卸载" |
| 轻 L1 | 相机远平面初值 900 → 共享常量 520，与 farplane 系统一致 |
| 轻 L2 | `Engine.dispose()` 解绑 resize/orientation/visualViewport 监听并清定时器 |
| 轻 L3 | `EventChannel.once` 同样幂等化 |
| 轻 L4 | `fallbackToMain` 先统一 settle 在途 promise 再补算，避免悬挂与顺序依赖 |
| 轻 L5 | `NoiseBackend.dispose()` 显式释放 WASM 实例，`benchmark` 用 try/finally |
| 轻 L6 | `moveBody` 按最近阻挡面钳制，消除同轴多方块时的穿透/钳过头隐患 |

## 测试

- 新增 `test/review-fixes-check.cjs`（15 项），`test/wasm-check.cjs`（24 项）、
  `test/plugin-v2-check.cjs`（21 项）、`test/plugin-carrier-check.cjs`（15 项）。
- `npm run verify` 全绿：版本/WASM 产物校验 + lint + typecheck + 单文件构建 + 快照 + 全部逻辑/服务/
  诊断回归 + Chromium 实景（95 项）+ 视觉回归（13/13）。
- CI（`.github/workflows/verify.yml`）在 Xvfb + Mesa 软件渲染下跑同一条链，runner 无需 clang。

## 如何验证

```bash
npm ci
npm run verify
```

## 已知限制

- 交付源码不含原始 git 历史（codeload 获取），需在有权限的 fork 上推送。
- `plugins.install(source)` 等价 eval，只应加载已审计的可信源码。
- 修改 WASM 内核导出/表达式需同步 C 与 `noiseMath.ts` 并推进 ABI，对拍不允许放宽为近似相等。
- `wasm:host` 目前覆盖事件与世界生成两层扩展点，其他层可依同一 `ExtensionRegistry` 模式追加。

## 相关文档

- `docs/WASM.md` — WASM 内核设计、ABI、性能与故障排查
- `docs/PLUGINS.md` — 三载体插件体系与扩展点
- `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `docs/agent/RUNBOOK.md`
