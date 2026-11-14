# Minecraft TS · 项目级经验与硬规则

TypeScript + three.js 的体素 Minecraft 复刻。运行时唯一依赖 three.js，构建产物是单文件
`dist/index.html`。本文件只记录**改代码前必须知道**的约束与踩坑；架构细节见
[ARCHITECTURE.md](ARCHITECTURE.md)，运行手册见 [agent/RUNBOOK.md](agent/RUNBOOK.md)。

## 基线命令

```bash
npm run typecheck       # tsc --noEmit，必须 0 error
npm run build           # 类型检查 + 单文件构建
npm run test:snapshot   # 从当前 TS 源码生成 CJS 测试快照（必须先跑）
npm run test:logic && npm run test:light && npm run test:mesher
npm run test:services && npm run test:diagnostics && npm run test:terrain-system
npm run verify          # 以上全部 + 浏览器实景 / 视觉回归（需要 Chromium）
```

测试快照目录 `test/logic`、`test/terrain-logic` 由脚本生成，**不要手改**；它们已加入
`.gitignore`，也不应提交。

## 硬规则

- **版本单一来源**：`src/core/version.ts` 的 `VERSION` 是唯一来源，`package.json` 与 README
  必须一致；`npm run check:version` 会机械校验。
- **方块 id 只追加**：内置方块 id 1..54 不能调整，否则旧存档 `edits` 差分指向错误方块。
  新方块 id 必须 1..255（`Uint8Array` 存储）；新增后同步 `test/terrain-system-check.cjs`。
- **地形规则进配置表**：地表 / 填充 / 花草 / 浅滩黏土 / 仙人掌 / 甘蔗写在
  `BIOME_PROFILES`；生成阶段顺序（`TERRAIN_STAGES`）是契约，不要随意插入新阶段。
- **数据 / 渲染解耦**：Worker 侧只允许依赖 `MeshSource` / `MeshSnapshot` 纯数据，禁止
  import three / World / TextureAtlas。主线程与 Worker 共用同一份 `mesher.ts`。
- **Worker 配置失效**：注册方块 / 纹理后必须让 `ChunkManager.invalidateConfig()` 重建并
  `postConfig()` 到每个 Worker，同时重排已有网格；Worker 会回传 `config-ack`，
  `chunks.configReady` 是运行时诊断的判据。
- **快照契约**：带光照的网格快照必须同时拷贝 `data / sky / block` 三张 18×80×18 缓冲；
  Greedy mask key 包含 `id | ao<<8 | sky<<10 | block<<14`，光照不同不合并。
- **输入状态机**：暂停 / 死亡 / 返回标题时调用 `input.reset()`；keyup 必须无条件处理，
  否则禁用期间的松键会永久留在 `keys` 里。
- **插件生命周期**：`PluginService` 用 `pending` Promise 复用并发 enable，用 epoch 识别
  “setup 期间被 disable”；`EventChannel.waitFor` 也必须走通道作用域，dispose 时一起清理。
- **权限是护栏不是沙箱**：`scopeAPI` 会拦截 world/player/save/api/blocks 的写入口，
  但 `ctx.services` / `ctx.api.engine` 仍是受信内部对象；不要把不可信代码当作沙箱。
- **存档竞态**：保存是异步的；用 `dirtyVersion + saveSeq` 保证旧保存回调不会清掉新编辑。
- **诊断**：新增高风险不变量时，优先在 `src/diagnostics/RuntimeDiagnostics.ts` 增加检查，
  并在 `test/diagnostics-check.cjs` 补一条注入式回归。
- **Worker 池构造**：`createWorkerPool()` 任一构造失败必须整体 terminate 并回退主线程，
  禁止留下「部分实例 + worker 模式」的残池；用 `test:worker-pool` 注入式回归验证。
- **编辑差分**：分桶值存已解析的数值坐标（`BlockEdit`），字符串 key 只在 `recordEdit` 解析一次；
  `ensureChunk` 不再逐条 `split(',')`。改动用 `test:edits` 覆盖负坐标与跨区块边界。

## 常见排查

- **Worker 没收到配置**：检查 `invalidateConfig()` 是否真的重建并下发；用
  `CraftAPI.diagnostics.run()` 或 F3 的「运行时诊断」确认 `configReady`。
- **区块有数据但没网格**：先看 `world.dirty` / `chunks.inFlightCount`；自愈只会处理
  「无网格且无在途任务」的区块，诊断组会在队列静默时报告 `chunks.missingMesh`。
- **CI 浏览器失败**：优先重跑；仍需本地复现时用 `xvfb-run` + `MC_HEADLESS=0 MC_GL=desktop`。
- **软件渲染帧率低**：引擎把 `dt` 钳制到 0.05，游戏时间约为真实的一半；测试必须按条件
  轮询（`waitForFunction`），不要固定 sleep。
