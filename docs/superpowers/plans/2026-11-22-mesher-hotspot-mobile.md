# 移动端帧时优化 — Greedy mesher 热点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `meshChunk` 的 Greedy 内层扫描提速 ≥1.5× 且输出逐字节一致，并给出本机可全绿的 `verify:node` 门。

**Architecture:** 先固定 24 区块生产路径的 SHA-256 输出护栏与基线，再分别做 `packMesh` typed-array 支持与 `mesher.ts` 标量化；任何改变输出 hash 的子项立即回滚。WASM 噪声后端裁剪掉（实测慢 46%）。

**Tech Stack:** TypeScript 5.6 strict、three.js 0.170（仅渲染侧）、Node CJS 快照测试、`node:crypto` sha256。

**Spec:** `docs/superpowers/specs/2026-11-22-mesher-hotspot-mobile-design.md`
**任务卡:** `docs/agent/tasks/M01.yaml`、`M02.yaml`、`M03.yaml`、`M04.yaml`

## Global Constraints

- 输出逐字节一致（quad 顺序 + 全部顶点属性）优先于 1.5×；护栏不过就回滚该子项。
- 不改 `MeshSnapshot` 数据契约、不改 Worker 池架构、不改地形/存档结果。
- 零新增依赖；本机无 clang，**不修改 `native/mc_kernel.c` / `kernelBinary.ts`**。
- 不碰 WASM 噪声自适应（C 轨道已裁剪），不改 `?wasm=` 参数与 wasm 诊断。
- `test:mesher` 61 项、现有 `test:mobile` 四项必须全绿。
- `packMesh` 对外签名不变；tsc strict 过，不用 `as any`。
- 基准脚本不挂 `verify`；只做本地 commit，不 push。
- 本线独占 `package.json`；不改 `EXPERIMENTS.md` / `CHANGELOG.md` / `validate.py`。
- evidence 记真实 exit code；浏览器步骤按环境阻塞如实记录。

## Review Focus

- typed array 预分配容量被打包成多余 0 → Task 2 的前缀对拍测试。
- 标量化改变 quad 顺序或顶点属性 → Task 1 的 SHA-256 guard，Task 3 每步重跑。
- 特殊方块（cross / 液体 / 自发光）在合并扫描时重复或漏发 → Task 3 的护栏 + `test:mesher` 61 项。
- 基准路径与生产路径不一致 → Task 1 固定用 `SnapshotMeshSource` + 24 区块 fixture。
- 超时/卡顿误判为提速 → 计时只作报告与 Node 代理指标，`p95<33ms` 降级为记录目标。

---

### Task 1: verify:node 与生产路径护栏基线（M01）

**Files:**
- Modify: `package.json`（新增 `verify:node` 与 `test:mesher-hotspot` 脚本）
- Create: `test/mesher-fixture.cjs`、`test/mesher-hotspot-check.cjs`
- Generate: `test/mesher-hotspot-baseline.json`

**Interfaces:**
- Produces: `makeMeshSet(): { cx: number; cz: number; config: MeshConfig; snapshot: MeshSnapshot }[]`（24 项）；`serializeMesh(out: MeshOutput): Buffer`；`meshHash(out): string`（sha256 hex）；`verify:node` npm 脚本。
- Consumes: `buildMeshSnapshot` / `SnapshotMeshSource` / `buildMeshConfig`（与 `test/mesher-check.cjs::makeConfig` 相同的确定性 UV 替身）。

- [ ] **Step 1: 写 fixture 与护栏脚本** — `test/mesher-fixture.cjs` 用 seed 2026、`cx=0..5, cz=0..3` 生成 24 区块快照；`serializeMesh` 按 opaque/emissive/transparent/water 通道与固定属性顺序拼 Buffer。`test/mesher-hotspot-check.cjs` 断言 fixture 长度 24、hash 等于 baseline、打印 8 轮平均 ms，支持 `--record`。
- [ ] **Step 2: 确认 RED** — Run: `npm run test:snapshot && node test/mesher-hotspot-check.cjs`；Expected: FAIL（baseline.json 尚不存在）。
- [ ] **Step 3: 记录基线** — Run: `node test/mesher-hotspot-check.cjs --record && node test/mesher-hotspot-check.cjs`；Expected: 生成含 `hash` 与 `msPerChunk` 的 JSON（预期 `msPerChunk ≈ 87.27`），第二次 PASS。基线必须在任何优化前提交。
- [ ] **Step 4: 加 verify:node** — 在 `package.json` 复制 `verify` 链，删除 `npm run test:smoke`、`npm run test:options`、`npm run test:visual` 三段，保留 `test:mobile`；新增 `test:mesher-hotspot` 脚本（不挂进任何 verify）。Expected: `npm run verify:node` 全绿。
- [ ] **Step 5: Commit** — `git add package.json test/mesher-fixture.cjs test/mesher-hotspot-check.cjs test/mesher-hotspot-baseline.json && git commit -m "test(mesher): 固定 24 区块输出护栏、性能基线与 verify:node"`。

### Task 2: packMesh typed-array 支持（M02）

**Files:**
- Modify: `src/world/meshTypes.ts:101-116,162-184`
- Modify: `src/world/mesher.ts:32`（`newGeo`）
- Test: `test/mesh-typed-arrays-check.cjs`

**Interfaces:**
- Consumes: Task 1 的护栏与 `packMesh(d: ChunkMeshData)` 既有签名。
- Produces: `export type GeoArray = number[] | Float32Array | Uint32Array`；`GeoArrays` 各字段改为 `GeoArray`（`indices` 为 `number[] | Uint32Array`）；`packMesh` 对 typed array 用 `subarray(0, length)`。

- [ ] **Step 1: 写失败测试** — `test/mesh-typed-arrays-check.cjs`：每个分量用容量 8 的 typed array 只填前 4 项（indices 填 6 项），调 `packMesh`，断言 packed 长度等于写入数且逐值等于同一份普通 `number[]` 的打包结果。Expected: FAIL（当前 `new Float32Array(g.positions)` 会带上多余 0）。
- [ ] **Step 2: 确认 RED** — Run: `npm run test:snapshot && node test/mesh-typed-arrays-check.cjs`；Expected: FAIL。
- [ ] **Step 3: 实现** — 定义 `GeoArray`，放宽 `GeoArrays`；`packMesh` 内部分类型打包（typed → `subarray(0,length)`，普通数组 → 原样）；`newGeo` 改为容量倍增的 typed array（初始按 2048 quad）；不用 `as any`。
- [ ] **Step 4: 确认 GREEN + 无回归** — Run: `npm run typecheck && npm run test:snapshot && node test/mesh-typed-arrays-check.cjs && node test/mesher-hotspot-check.cjs && npm run test:mesher`；Expected: hash 与基线一致，全 PASS。若 hash 变化，回滚 Task 2 并如实记录。
- [ ] **Step 5: Commit** — `git add src/world/meshTypes.ts src/world/mesher.ts test/mesh-typed-arrays-check.cjs && git commit -m "perf(mesher): 支持 typed array 几何缓冲并只打包已用前缀"`。

### Task 3: Greedy 内层循环标量化（M03）

**Files:** Modify `src/world/mesher.ts`（`FACE_GEOMS`、`blockAt`、可选调用提升、条件性扫描合并）
**Interfaces:** Consumes: Task 1 护栏 + Task 2 typed array；Produces: `meshChunk(src: MeshSource): MeshOutput` 签名与输出 hash 不变。

- [ ] **Step 1: 确认护栏当前绿** — Run: `node test/mesher-hotspot-check.cjs`；Expected: PASS，记录当前 ms。
- [ ] **Step 2: 实施 B.1 + B.2** — 把 `blockAt` 的可变数组 `bb` 换成局部标量 `bx/by/bz`；`FACE_GEOMS` 预存 `nx/ny/nz`；`src.isKnown?.(...)` 提升为循环外 `const isKnown = src.isKnown ?? (() => true)`。AO / 角点光 / mask key / `emitFace` 数学一字不改。
- [ ] **Step 3: 跑护栏与回归** — Run: `node test/mesher-hotspot-check.cjs && npm run test:mesher && npm run test:mobile`；Expected: hash 一致，61 项与 mobile 四项全绿。
- [ ] **Step 4: 条件性 B.3** — 仅当 hash 仍一致时，尝试合并两次全量扫描（B 段按 id 判定普通立方体建 mask / 非普通走 `emitBlock`，用每区块 `Uint8Array` 去重）；若 hash 变化立即回滚本步。
- [ ] **Step 5: 验收提速** — Run: `node test/mesher-hotspot-check.cjs`；Expected: `msPerChunk <= baseline.msPerChunk / 1.5`（即 ≤58.2）。若 hash 一致但未达标，继续在局部化上优化且不改语义；仍不达标则如实记录实际倍数，不谎报。
- [ ] **Step 6: Commit** — `git add src/world/mesher.ts && git commit -m "perf(mesher): 标量化 Greedy 内层循环并保持输出逐字节一致"`。

### Task 4: 移动端线验收与记录（M04）

**Files:** 无源码改动（只跑命令、写 evidence）
**Interfaces:** Consumes: Task 1–3 全部产出。

- [ ] **Step 1: 跑 Node 全门** — Run: `npm run verify:node`；Expected: 全 PASS，evidence 记录真实退出码。
- [ ] **Step 2: 跑完整 verify 并记录阻塞** — Run: `npm run verify`；Expected: exit 1，卡在 `test:smoke` 的 snap-wrapper 错误；记录精确错误行与退出码。
- [ ] **Step 3: 记录性能数据** — 把基线/优化后 ms、倍数、hash、以及 `p95<33ms @ 默认移动设置（待有浏览器环境验证）` 写进 `test/mesher-hotspot-baseline.json` 的附带字段与本线 plan/spec；不改 `docs/EXPERIMENTS.md`（由集成步骤汇总）。
- [ ] **Step 4: Commit** — `git add docs/agent/tasks/M04.yaml test/mesher-hotspot-baseline.json && git commit -m "docs(mobile): 性能基线与验收 evidence"`。

## Self-Review Notes

- Spec 覆盖：B.1/B.2 → Task 3；B.3 → Task 3 Step 4（条件性）；B.4 → Task 2；护栏/基线 → Task 1；验收口径 → Task 4。
- 裁剪确认：C（WASM 自适应）完全不在计划内；无 `wasm/runtime.ts`、`diagnostics`、`?wasm=` 相关任务。
- 类型一致：`GeoArray` / `GeoArrays` / `packMesh` / `MeshOutput` / `meshHash` 全程同名。
- 比例：plan 只锁定文件、签名、命令、判据与回滚条件，不抄写算法实现。
- 已知边界：本机无浏览器，`verify` 必失败于 `test:smoke`，不把它写成阻塞条件；1.5× 若未达标按实际倍数如实记录。
