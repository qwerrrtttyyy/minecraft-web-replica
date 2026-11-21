# project-conventions

 minecraft-ts 项目的硬规则速查（源自 AGENTS.md / docs/PROJECT-EXPERIENCE.md）。
 仅由 AtomCode 自动调用，用户不直接调用。

## 调用时机

做任何修改 `src/**` 的任务前，将本节作为检查清单对照。

## 硬规则摘要

1. **版本双轨**：`src/core/version.ts` 是唯一来源；`VERSION`（X.Y.Z）与 `RELEASE`（vN）分开。日常只动 `VERSION`。源码禁硬编码版本字面量。
2. **方块 id 只追加**：内置方块 id `1..119` 不可调整或重排（旧存档 edits 差分依赖）。新方块末位追加且须在 `1..255`（Uint8Array 存储）。
3. **合成规则进配置表**：配方只写 `src/player/crafting.ts` 的 `CRAFTING_RECIPES`，不散进 UI 或 main.ts。匹配必须严格（多一个不相干材料就不匹配）。
4. **地形规则进配置表**：写进 `BIOME_PROFILES`（11 群系），不在阶段里散落 `if (biome === ...)`。
5. **阶段顺序是契约**：`TERRAIN_STAGES = ['columns', 'ores', 'trees', 'decorate']`，改动须同步断言。
6. **数据/渲染解耦**：Worker 侧禁止 import three / World / TextureAtlas；只依赖 `MeshSource` / `MeshSnapshot` 纯数据。
7. **Worker 配置失效**：注册方块/纹理后必须 `ChunkManager.invalidateConfig()` + `postConfig()`，判据 `chunks.configReady`。
8. **快照契约**：带光照的网格快照必须拷贝 `data / sky / block` 三张 18×80×18 缓冲；Greedy mask key 为 `id | ao<<8 | sky<<10 | block<<14`；四角光照不一致的面退回逐面输出。
9. **输入状态机**：暂停/死亡/返回标题时 `input.reset()`；`keyup` 无条件处理。
10. **插件生命周期**：`PluginService` 用 pending Promise 复用并发 enable；`EventChannel.waitFor` 走通道作用域。
11. **存档竞态**：`dirtyVersion + saveSeq` 保证旧保存回调不清掉新编辑。
12. **Worker 池构造**：任一实例失败须整体 terminate 回退主线程，不留残池。
13. **新高风险不变量**：优先加到 `src/diagnostics/RuntimeDiagnostics.ts` + `test/diagnostics-check.cjs` 注入式回归。
14. **不提交生成物**：`test/logic/`、`test/terrain-logic/`、`dist/`、`test/artifacts/` 不手改不提交。

## 验证基线

改完后按序：`npm run typecheck` → `npm run test:snapshot` → 相关 `test:*` → `npm run verify` 全绿。
