# AGENTS.md · Minecraft TS

TypeScript + three.js 的体素 Minecraft 复刻。**运行时唯一依赖是 three.js**，其余全部手写：
体素世界、区块流式加载、带 AO 的网格生成、程序化像素纹理、昼夜天空、物理碰撞、实体 AI、
触控适配、存档与扩展 API。构建产物是**单文件 `dist/index.html`**，可 `file://` 直接打开。

> 本文件是**入口索引**，只给命令、地图与最容易踩的硬规则。
> 架构细则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，
> 完整硬规则与排查见 [docs/PROJECT-EXPERIENCE.md](docs/PROJECT-EXPERIENCE.md)，
> 测试矩阵见 [docs/TESTING.md](docs/TESTING.md)，
> 运作手册见 [docs/agent/RUNBOOK.md](docs/agent/RUNBOOK.md)。
> **冲突时以 `docs/` 为准**，不要在这里另立一套口径。

---

## 1. 常用命令

```bash
npm ci
npm run typecheck        # tsc --noEmit（strict），必须 0 error
npm run build            # typecheck + 单文件 dist/index.html
npm run test:snapshot    # 从当前 TS 源码现场编译 CJS 快照 —— 纯逻辑测试的前置
npm run verify           # 唯一验收入口：版本 + 类型 + 构建 + 全部回归 + 浏览器实景
```

| 命令 | 覆盖内容 |
|---|---|
| `check:version` | 双轨版本号格式、`package.json` / `version.ts` / README 三处一致、源码禁硬编码版本字面量 |
| `test:snapshot` | 由 `scripts/build-test-snapshot.mjs` 用项目自己的 `tsc` 编译 `test/logic/`、`test/terrain-logic/` |
| `test:logic` | 生存状态机 8 组 + 地形基础 23 组 |
| `test:light` | 天空光 / 方块光 21 项 |
| `test:mesher` | 网格快照保真、Greedy 面覆盖与光照逐格等价、quad 下降比例 |
| `test:services` | 服务容器 / 事件 / 插件 / 存档 38 项 |
| `test:diagnostics` | 运行时诊断 20 组（健康快照 + 异常注入） |
| `test:worker-pool` | Worker 池构造失败整体回退的注入式回归 |
| `test:edits` | 编辑差分数值分桶：负坐标 / 跨区块边界 / 覆盖 / 存档导出 |
| `test:terrain-system` | 方块扩充（id 45~91）、`TERRAIN_STAGES` 顺序、`BIOME_PROFILES` 34 组 |
| `test:botany` | 植物随机刻：生长 / 蔓延 / 枯萎 / 树苗长树 28 组 |
| `test:plant-energy` | 植物内在能量：代谢 / 蓄能 / 开花 / 采集 / 根系共享 29 组 |
| `test:crafting` | 合成系统：配方表结构 / 有序与无序匹配 / 3×3 内偏移摆放 / 材料组 / 2×2 与 3×3 尺寸差异 / 背包取放闭环 43 组 |
| `test:smoke` | Chromium 实景（桌面 + 移动端），产物写 `test/artifacts/` |
| `test:visual` | 像素级视觉回归：昼夜 / 火光 / 方块墙 / 天穹 |

**执行顺序**：`test:snapshot` 必须先于全部 `require` 快照的纯逻辑测试
（`test:logic` / `light` / `mesher` / `services` / `diagnostics` / `terrain-system` 等）。

Linux 无 GPU 环境跑浏览器组：

```bash
xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop npm run test:smoke
```

CI（`.github/workflows/verify.yml`）要求 `npm run verify` **100% PASS**；
`pages.yml` 把 `dist/` 部署到 GitHub Pages。

---

## 2. 目录地图

```
src/
├── main.ts            组装根（composition root）：建服务 → 注入依赖 → 启插件 → 启动循环
├── core/              引擎内核：主循环、类型常量、唯一版本源；events.ts 仅兼容再导出
├── services/          服务层：ServiceContainer（类型化 DI）/ events/ / plugins/
├── api/               CraftAPI 门面（薄适配层，兼容旧 22 项 + plugins / events 命名空间）
├── world/             体素世界：world / chunkManager / generator / mesher / light / botany / workerPool
├── gfx/               渲染：atlas（程序化像素纹理）/ sky / particles / highlight
├── player/            玩家：player / physics / survival / crafting（合成规则，纯逻辑）
├── entity/            实体：entity / models / tnt
├── input/             键鼠 input 与触控 touch
├── ui/                HUD、合成界面与样式
├── save/              存档：LocalStorageProvider、validateSave
├── audio/             音效
├── diagnostics/       运行时诊断组（只读快照检查、F3 报告、10s 自动采样）
└── plugins/
    ├── builtin/       默认启用的内置插件（autosave / hudFeedback）
    └── example/       插件开发示例（默认不启用）
```

**依赖方向单向**：`main → services → 业务模块`。`api/` 只做适配；
插件只依赖 `PluginContext`，**不 import 引擎内部实现**。

关键常量（`src/core/types.ts`）：`CHUNK_SIZE=16`、`WORLD_HEIGHT=80`、`SEA_LEVEL=30`。

---

## 3. 硬规则（摘要）

细则与完整理由见 `docs/PROJECT-EXPERIENCE.md`。

1. **版本双轨单一来源**：`src/core/version.ts` 是唯一来源 —— `VERSION`（`X.Y.Z`）与
   `RELEASE`（`vN`）分开维护。日常迭代只动 `VERSION`；`RELEASE` 仅在发布正式版时推进。
   Git 标签统一带 `v`：正式版 `vN`，历史迭代 `vX.Y.Z`。
2. **方块 id 只追加**：内置方块 id `1..91` 不能调整或重排，否则旧存档 `edits` 差分指向错方块。
   新方块只能末位追加，且必须在 `1..255`（`Uint8Array` 存储，超出会被静默截断）。
   新增后同步 `test/terrain-system-check.cjs` 的 id 断言与 `docs/TESTING.md`。
3. **合成规则进配置表**：配方表在 `src/player/crafting.ts` 的 `CRAFTING_RECIPES`，
   不要散进 UI 或 main.ts。材料标识用方块名 / `item:xxx`；背包键与材料标识的转换
   只放在组装根的 `craftingHost`。合成匹配必须严格：多一个不相干材料就不该匹配。
4. **地形规则进配置表**：地表 / 填充 / 花草 / 浅滩黏土 / 仙人掌 / 甘蔗一律写进
   `BIOME_PROFILES`（7 个群系），不要在阶段里散落 `if (biome === ...)`。
5. **生成阶段顺序是契约**：`TERRAIN_STAGES = ['columns', 'ores', 'trees', 'decorate']`，
   插入新阶段要同步更新阶段顺序断言。
6. **数据 / 渲染解耦**：Worker 侧只允许依赖 `MeshSource` / `MeshSnapshot` 纯数据，
   **禁止 import three / World / TextureAtlas**；主线程与 Worker 共用同一份 `mesher.ts`。
7. **Worker 配置失效**：注册方块 / 纹理后必须 `ChunkManager.invalidateConfig()` 重建并
   `postConfig()` 到每个 Worker，同时重排已有网格。判据是 `chunks.configReady`。
8. **快照契约**：带光照的网格快照必须同时拷贝 `data / sky / block` 三张 `18×80×18` 缓冲；
   Greedy mask key 含 `id | ao<<8 | sky<<10 | block<<14`，光照不同不合并。
9. **输入状态机**：暂停 / 死亡 / 返回标题时调用 `input.reset()`；`keyup` 必须无条件处理，
   否则禁用期间的松键会永久留在 `keys` 里。
10. **插件生命周期**：`PluginService` 用 `pending` Promise 复用并发 enable，用 epoch 识别
    "setup 期间被 disable"；`EventChannel.waitFor` 也要走通道作用域，dispose 时一并清理。
11. **存档竞态**：保存是异步的；用 `dirtyVersion + saveSeq` 保证旧保存回调不会清掉新编辑。
12. **Worker 池构造**：`createWorkerPool()` 任一实例构造失败必须整体 terminate 并回退主线程，
    禁止留下"部分实例 + worker 模式"的残池。
13. **新增高风险不变量**优先加到 `src/diagnostics/RuntimeDiagnostics.ts`，
    并在 `test/diagnostics-check.cjs` 补一条注入式回归，确保检查项不会静默失效。
14. **大二进制不入库**：>1MB 的媒体 / 产物不提交 git；演示动画用 WebP
    （`docs/assets/showcase.webp`），否则放 Release / Artifacts。详见 `docs/PROJECT-EXPERIENCE.md`。

---

## 4. 改代码的工作流

1. 先读 `docs/PROJECT-EXPERIENCE.md` 了解硬规则与已知坑
2. 改之前跑 `npm run typecheck`，确认基线干净
3. 改完后：`npm run test:snapshot` → 相关 `test:*` → `npm run verify` 全绿
4. 提交信息写清"修了什么 / 为什么"，不要只写 `update`
5. 新增纯逻辑测试入口时，把文件加进 `scripts/build-test-snapshot.mjs` 的 `entries` 数组

**不要手改、不要提交**：`test/logic/`、`test/terrain-logic/`（脚本现场生成的 CJS 快照，
已在 `.gitignore`）、`dist/`、`test/artifacts/`。

---

## 5. 扩展点速查

| 想做什么 | 入口 |
|---|---|
| 加方块 / 纹理 | `src/world/blocks.ts` 的 `registerBuiltinBlocks` + `src/gfx/atlas.ts` 画纹理 |
| 加地形 / 群系装饰 | `src/world/generator.ts` 的 `BIOME_PROFILES` |
| 加植物与生态规则 | `src/world/plantTraits.ts`（能量特性）+ `src/world/botany.ts`（随机刻规则） |
| 加实体 | `src/entity/` |
| 加玩法 | `src/player/survival.ts` |
| 写插件 | `src/plugins/example/welcome.ts` 是完整契约示例 |
| 加运行时检查 | `src/diagnostics/RuntimeDiagnostics.ts` |

插件契约要点：`manifest.id`（建议 `作者:名称`）、`dependencies`、`permissions`
（`world:write` / `player:write` / `save:write` / `api:emit` / `blocks:register`）；
未声明的写能力在插件上下文里会抛错。`setup(ctx)` 可返回 teardown 函数或用 `ctx.onDispose(fn)`，
二者都会执行。

---

## 6. 文档索引

| 文件 | 管什么 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层设计、三大服务契约、插件生命周期、网格化管线、地形管线、缺陷修复原理 |
| [docs/PROJECT-EXPERIENCE.md](docs/PROJECT-EXPERIENCE.md) | **改代码前必读**：硬规则全文 + 常见排查 |
| [docs/TESTING.md](docs/TESTING.md) | 测试体系、快照机制、各测试组职责与断言数 |
| [docs/agent/RUNBOOK.md](docs/agent/RUNBOOK.md) | 运作手册：开发流程、基线命令、运行时诊断、常见问题 |
| [docs/agent/tasks/*.yaml](docs/agent/tasks/) | 任务卡（`touch.allow` / `outputs` 契约），用 `python3 docs/agent/validate.py` 校验 |
| [README.md](README.md) | 对外说明、版本沿革、快速开始 |

非官方学习项目，与 Mojang / Microsoft 无关。所有纹理均为代码逐像素绘制，不含任何原版资源。
