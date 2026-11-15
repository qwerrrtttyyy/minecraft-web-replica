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
npm run lint
npm run typecheck
npm run test:snapshot
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
```

`test:snapshot` 必须先于全部 require CJS 快照的纯逻辑测试
（`test:logic / test:light / test:mesher / test:services / test:diagnostics / test:terrain-system / test:botany / test:plant-energy / test:botany-rules`）。

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
`issue.id`，确保检查项本身不会静默失效。

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
