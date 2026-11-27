# 设计：移动端帧时优化 — Greedy mesher 热点（只做有数据的部分）

日期：2026-11-22
状态：定稿（仅设计 / 任务卡，不含实现）
工作规模：中等（mesher + meshTypes + 测试 + `verify:node`）

## 意图与原因

用户反馈"移动端优化力度还有点不够"。事实上移动端旋钮已经很多（像素比封顶 1.5、质量档、动态分辨率、降渲染距离/粒子/星星/云、横屏门、触控摇杆），继续加旋钮没有依据。同期的实测数据指出真正的大热点是 `meshChunk`：每区块约 87.27ms，占 CPU 采样 90.6%，是地形生成（21.13ms）的 4 倍。

因此本轮只打这个热点：把 Greedy 内层循环标量化、几何缓冲类型化，目标 ≥1.5×，且输出**逐字节一致**。

来源：tuning 副本的 `2026-11-22-mesher-wasm-hotspot` 计划/规格是**未完成的设计稿**（所有 checkbox 未勾、无实现文件、无基线）。botany HEAD `281507e` 已包含它上一轮的 retention/M05/M06 改动。本规格从那份设计稿裁剪而来。

## 实测依据（沿用来源规格，非本轮重测）

环境：Node 24，项目快照，seed 2026。

| 项目 | 结果 |
|---|---|
| `generateChunk` ×64 | 21.13 ms/区块 |
| `ensureChunk` ×64 | 23.27 ms/区块 |
| `meshChunk`（Greedy，`WorldMeshSource`） | **87.27 ms/区块** |
| JS `fbm2` ×20 万 | 103.9 ms（0.00052 ms/次） |
| 现有 WASM `fbm2` ×20 万 | 151.6 ms（0.00076 ms/次，**慢 46%**） |
| `selectEvictions` ×3000 | 0.078 ms/帧（可忽略） |

CPU profile（24 区块 ×8 轮）：`meshChunk` 自身 90.6%，`pushQuad` 1.2%，`emitFace` 0.8%，角点光/AO 各 <1%。所以优化对象是 `meshChunk` 内层扫描，不是 `World` 缓存，也不是 WASM 噪声。

## 已确认的决策（相对来源规格的裁剪）

1. **砍掉 C（WASM 噪声后端自适应）**：实测慢 46%，不值得做；不碰 `wasm/runtime.ts`、`main.ts` 的 wasm 参数、`diagnostics/`。
2. **只做 B 的三个子项**：`packMesh` typed-array 支持、坐标标量化 + 消除每格可选调用、条件性合并两次扫描。
3. **逐字节一致优先于 1.5×**：护栏不过就回滚该子项；允许最终只拿到 <1.5× 并如实记录。
4. **验收口径调整**：本机无可用浏览器（playwright chromium SIGBUS、puppeteer zip 损坏、snap 包装缺依赖），`npm run verify` 实测 exit 1 卡在 `test:smoke`。硬门改为 `verify:node` 全绿 + 新基准/护栏全绿；`p95<33ms @ 默认移动设置` 降级为记录在案的目标，留给有浏览器的环境验证。

## 目标 / 非目标 / 反目标

**目标**

- 同一 24 区块快照集合上 `meshChunk` 提速 ≥1.5×（87.27 → ≤58.2 ms/区块）。
- 输出逐字节一致：quad 顺序 + 全部顶点属性，用 SHA-256 guard 固定。
- 新增 `verify:node`（完整 verify 链去掉三个浏览器步骤），本机可全绿。

**非目标**

- 不改 WASM 噪声、Worker 池架构、`MeshSnapshot` 数据契约、存档、地形生成结果、方块 id / tile 索引。
- 不新增运行时依赖；不重新编译 C 内核。
- 不修浏览器脚本（归环境阻塞，按 E4–E7 写法记录）。

**反目标**

- 为提速改变任何方块外观、光照渐变、透明排序、Greedy 合并语义。
- 把 newGeo 换成 typed array 后忘记 `subarray(0,length)`，把预分配容量打包成 0。

## 约束

- Worker 侧只依赖 `MeshSource` / `MeshSnapshot` 纯数据；`mesher.ts` 主线程与 Worker 共用。
- 快照契约：`sky/block` 为 18×80×18 角点光照；mask key `(id | ao<<8 | sky<<10 | blk<<14) + 1`。
- `test:mesher` 61 项必须全绿；新改动先红后绿。
- `MeshOutput` / `packMesh` 对外签名不变；tsc strict 过，不用 `as any`。
- 基准脚本不挂 `verify`（与 `docs/EXPERIMENTS.md` 约定一致）。
- 提交只做本地 commit，不 push。

## 设计细节

### B.1/B.2 `src/world/mesher.ts`

- `blockAt(U,V,L)` 的可变数组 `bb` 换成局部标量 `bx/by/bz`；`FACE_GEOMS` 预存 `nx/ny/nz`，去掉循环内 `const [nx,ny,nz] = face.normal` 的解构分配。
- `src.isKnown?.(...)` 提升到循环外 `const isKnown = src.isKnown ?? (() => true)`。
- AO / 角点光照 / mask key / `emitFace` / `emitCross` 的数学与分支**一字不改**。
- B.3（合并两次全量扫描）为**条件性**：仅在 hash 仍一致时保留；特殊方块发射顺序变化则立即回滚。

### B.4 `src/world/meshTypes.ts`

- 新增 `export type GeoArray = number[] | Float32Array | Uint32Array`；`GeoArrays` 各字段放宽（`indices` 为 `number[] | Uint32Array`）。
- `packMesh(d: ChunkMeshData)` 签名不变；内部对 typed array 用 `subarray(0, length)`，对普通数组保持原样。
- `newGeo()` 改用带容量倍增的 typed array（初始容量按 2048 quad）。

### 护栏与基准

- `test/mesher-fixture.cjs`：seed 2026，`cx=0..5, cz=0..3` 共 24 区块，生产路径 `SnapshotMeshSource` + 与 `test/mesher-check.cjs::makeConfig` 相同的确定性 UV 替身；导出 `makeMeshSet(): {cx,cz,config,snapshot}[]`、`serializeMesh(out): Buffer`、`meshHash(out): string`。
- `test/mesher-hotspot-check.cjs`：断言 `meshHash(meshChunk(src))` 等于 `test/mesher-hotspot-baseline.json`；打印 8 轮平均 ms；支持 `--record` 写基线。hash 是硬断言，计时只报告并校验 `msPerChunk <= baseline/1.5`（无浏览器环境下作为 Node 代理指标）。
- 基线必须在任何优化前记录并提交。

### `verify:node`

`package.json` 新增脚本：完整 `verify` 链去掉 `test:smoke` / `test:options` / `test:visual`，保留 `test:mobile`；不修改既有 `verify`（CI 在有浏览器环境仍跑全链）。完整 verify 每线各跑一次，evidence 记录真实 exit 1 与精确错误。

## 测试计划（先红后绿）

- `test/mesh-typed-arrays-check.cjs`：容量 8 的 typed array 只写前 4 项，打包后长度/逐值等于普通数组版本（RED：当前会把多余 0 打包进去）。
- `test/mesher-hotspot-check.cjs` + baseline：先记录再对拍，hash 变化即失败。
- `npm run test:mesher`、`npm run test:mobile` 每次改动后必跑。

## 验收清单

- [ ] `npm run typecheck` / `npm run build` 绿
- [ ] `npm run test:snapshot && node test/mesh-typed-arrays-check.cjs && npm run test:mesher` 绿
- [ ] `node test/mesher-hotspot-check.cjs` 绿：hash 与基线一致且 `msPerChunk <= baseline/1.5`（若未达标但 hash 一致，如实记录倍数）
- [ ] `npm run verify:node` 全绿；完整 `npm run verify` 跑一次并记录浏览器步骤阻塞
- [ ] `p95<33ms` 写入 EXPERIMENTS.md 作为待验证目标（由合并集成步骤汇总）
- [ ] 本线不改 `EXPERIMENTS.md` / `CHANGELOG.md` / `validate.py`
