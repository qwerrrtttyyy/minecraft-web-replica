# 运作手册

## 开发流程

1. 读 [PROJECT-EXPERIENCE.md](../PROJECT-EXPERIENCE.md) 了解硬规则与常见坑
2. 改代码前先跑 `npm run typecheck` 与 `npm run lint`，确认基线干净
3. 改完后按顺序跑回归（见下），提交前必须 `npm run verify` 全绿
4. 提交信息说明「修了什么 / 为什么」，不要只写「update」

## 基线命令

```bash
npm ci
npm run check:version
npm run wasm:check
npm run lint
npm run typecheck
npm run test:snapshot
npm run test:wasm
npm run test:plugin-v2
npm run test:plugin-carrier
npm run test:review-fixes
npm run test:logic
npm run test:light
npm run test:mesher
npm run test:services
npm run test:diagnostics
npm run test:worker-pool
npm run test:edits
npm run test:terrain-system
npm run test:botany
npm run test:plant-energy
npm run test:botany-rules
npm run verify          # 以上全部 + build + 浏览器实景 + 视觉回归

# 仅在修改 native/mc_kernel.c 后执行（需要 clang --target=wasm32）
npm run build:wasm      # 重新编译并生成 src/wasm/kernelBinary.ts
```

`test:snapshot` 必须先于全部 require CJS 快照的纯逻辑测试
（`test:wasm / test:plugin-v2 / test:plugin-carrier / test:review-fixes / test:logic / test:light / test:mesher / test:services / test:diagnostics / test:terrain-system / test:botany / test:plant-energy / test:botany-rules`）。

浏览器实景在 Linux 无 GPU 环境下：

```bash
xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop npm run test:smoke
```

## 运行时诊断

- `CraftAPI.diagnostics.run()`：手动执行全部检查，返回结构化报告
- `CraftAPI.diagnostics.last()`：读取最近一次自动采样结果
- F3 面板：查看「运行时诊断」行
- 自动采样每 10 秒一次，仅当异常集合变化时输出 `console.groupCollapsed`

新增检查项时，同时更新 `test/diagnostics-check.cjs`，并在注入异常的快照上断言对应
`issue.id`，确保检查项本身不会静默失效。v1.5.0 的 WASM 检查为
`wasm.status` / `wasm.abi` / `wasm.fallback` / `wasm.selfcheck`。

## WASM 与插件 v2

- 内核导出或浮点表达式变更：`native/mc_kernel.c` ↔ `src/world/noiseMath.ts`
  必须同步，推进 `KERNEL_ABI`，重跑 `npm run build:wasm`；`test:wasm` 的
  `Object.is` 对拍不允许放宽。
- `wasm:check` 不调用编译器，CI 只校验内联产物与 `.wasm` 一致；两者必须同时提交。
- `?wasm=0` 强制关闭 WASM，用于 A/B 对比；`CraftAPI.wasm.stats()` 看自检样本、
  调用数与回退次数。
- 新增 `CraftAPI` 命名空间写方法时同步 `scopeAPI` 裁剪；新增 manifest 字段同步
  `validateManifest` 与 `test:plugin-v2`。
- `CraftAPI.plugins.install(source)` 等价 eval，只加载可信且已审计的源码，
  不要接远程自动下载。

## 地形与方块

- 方块 id 只能末尾追加；新增内置方块后同步更新 `test/terrain-system-check.cjs`
  的 id 断言与 `docs/TESTING.md`。
- 地表 / 装饰规则统一写进 `src/world/generator.ts` 的 `BIOME_PROFILES`，
  不要在地形阶段里散落 `if (biome === ...)`。
- 新增生成阶段会改变 `TERRAIN_STAGES` 契约，必须同时更新阶段顺序断言。

## 常见问题

- **测试快照过期**：重新 `npm run test:snapshot`；不要提交 `test/logic` / `test/terrain-logic`
- **Worker 配置不生效**：确认 `invalidateConfig()` 已重建并下发，且 `chunks.configReady`
  为 true；否则检查 `config-ack` 是否被 `drainResults` 消费
- **CI 浏览器启动超时**：基础设施抖动时重跑；持续失败检查 Chromium / Xvfb / Mesa 安装
- **旧存档方块错位**：方块 id 必须保持 append-only，禁止在中间插入内置方块
- **WASM 一直 fallback**：先看 `CraftAPI.wasm.stats().lastError`；「等价性自检失败」
  说明 C 与 `noiseMath.ts` 表达式顺序漂移，修实现而不是放宽对拍
- **插件被判 failed**：看 `plugins.get(id).error` / `.warnings`；`apiVersion` 不匹配、
  依赖版本不满足、setup 超时都在注册 / 启用期给出明确原因
