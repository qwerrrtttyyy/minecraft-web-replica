# 运作手册

## 开发流程

1. 读 [PROJECT-EXPERIENCE.md](../PROJECT-EXPERIENCE.md) 了解硬规则与常见坑
2. 改代码前先跑 `npm run typecheck` 与 `npm run lint`，确认基线干净
3. 改完后按顺序跑回归（见下），提交前必须 `npm run verify` 全绿
4. 提交信息说明「修了什么 / 为什么」，不要只写「update」

## 合并与发布纪律（铁律）

1. **版本 bump = 同 commit 改断言**：任何推进 `VERSION`（`src/core/version.ts` /
   `package.json`）的 commit，必须在**同一个 commit** 里同步更新所有断言旧版本号的
   位置（测试、README 版本行、文档）。禁止把 bump 与断言同步拆成两个 commit——
   中间的红色窗口就是 2026-11-15 的教训：v1.4.2 的 bump（1.4.1 → 1.4.2）没有同步
   `test/survival-smoke.mjs` 的版本断言，main 的 `verify` 红掉
   （`FAIL 版本号单一来源为 1.4.0 — 1.4.2`）。更优做法：版本断言动态读
   `package.json` / `version.ts`（`e31c482` 写法），断言中禁止硬编码版本字面量。
2. **一次只合一个 PR**：合并队列按 PR 编号一次处理一个。每次合并后**立即**在 main
   上跑全量 `npm run verify` 回归（CI 的 `verify` 检查是闸门，main 分支保护要求
   `verify` 绿）；绿了才允许开始下一个合并。禁止多个 PR 排队后批量合入（「排队打饭」）。
   - 队首 PR 红着或冲突：先跳过（记录原因），单独修好 / rebase 后再回队列，
     不允许它堵住后面绿的 PR。
   - 合并前分支必须 rebase 到最新 main；rebase 中出现的版本 bump 冲突
     按第 1 条解决（断言同步进同一个 commit）。
3. **每个 tag 配 Release**：打 tag 的同时必须创建对应 GitHub Release——
   标题格式 `vX.Y.Z 预发布  <主题>`（正式版：`vN 正式版  <主题>`），正文包含
   自上一个 tag 起的 changelog（新增 / 修复 / 流程）与验证情况，pre-release 标记
   与版本轨道一致（迭代版 = prerelease，正式版 = release）。禁止裸 tag（v1.4.2
   曾裸奔，2026-11-15 已补 Release）。
4. **WIP 永不上 main**：任何未完成、未跑绿 `verify` 的工作只能保存在任务分支
   （`feat/*`）或 `git stash`，禁止以「先存个快照」为理由直接提交到 main。
   2026-11-21 的教训：`wip` 提交上 main 后又叠了一个 merge，导致主干红、
   Pages 线上红、后续 PR 全部被冲突阻塞，最终只能整体 revert 回绿版。
   **现场保存 = 切分支提交或 stash，绝不是 main 上的一个 WIP commit。**
5. **Pages 只在 verify 绿后部署**：`.github/workflows/pages.yml` 必须通过
   `workflow_run` 监听 `verify` 成功事件才部署（跨 workflow 不能用 `needs`）。
   分支保护的 required check 可被维护者绕过，单靠它不足以保证线上绿——
   2026-11-21 已经发生过一次绕过。

## 已知技术债

- **Node 版本**：CI 与工作流固定 `node-version: '20'`。本地使用 Node 22/24 时，
  新版 `@types/node` 会把 `Uint8Array<ArrayBufferLike>` 判为不兼容 `BufferSource`
  （`src/wasm/kernel.ts`、`src/services/plugins/carriers/index.ts` 报 TS2345），
  这是本地环境噪声、不是源码问题。下次依赖冲突时一并评估升级 Node 20 → 22。

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
