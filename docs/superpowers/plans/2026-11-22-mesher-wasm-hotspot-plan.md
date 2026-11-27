# 网格化热点优化 + WASM 后端自适应 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低 Greedy 网格化内层循环成本（目标 ≥1.5×，输出逐字节不变），并让 WASM 噪声后端只在实测更快时安装。

**Architecture:** B 在 `mesher.ts` 内部标量化和减少每格调用，配合 `meshTypes.ts` 的 typed-array 打包；C 在 `wasm/runtime.ts` 用真实生成器调用组合做 JS/WASM 对称基准，纯函数决定后端，`main.ts` 透传 `?wasm=force/0`。两条轨道互不依赖，可分别验收。

**Tech Stack:** TypeScript 5.6 strict、three.js 0.170（仅渲染侧）、Node CJS 测试快照、已有 WebAssembly 内核（不重新编译）。

**Spec:** `docs/superpowers/specs/2026-11-22-mesher-wasm-hotspot-design.md`

## Global Constraints

- 输出逐字节一致（quad 顺序 + 全部顶点属性）优先于提速；护栏不过就回滚该子项。
- 不改 `MeshSnapshot` 数据契约、不改 Worker 池架构、不改地形/存档结果。
- 零新增依赖；本机无 clang/wasm 编译器，**不得修改 `native/mc_kernel.c` 或 `kernelBinary.ts`**。
- 保留 WASM↔JS 逐位等价自检与运行期异常回退。
- 测试用项目自己的 `npm run test:snapshot` 生成的 `test/logic`、`test/terrain-logic` 快照。
- 提交只做本地 commit，不 push；commit 前相关测试必须绿。

## Review Focus

1. **typed array 预分配的多余容量被打包成 0** → Task 1 的 packMesh 前后缀对拍测试。
2. **重构改变 quad 顺序或顶点属性** → Task 2 的完整输出 SHA-256 护栏，Task 3 每次改动后重跑。
3. **特殊方块（cross / 液体 / 自发光）在合并扫描时重复发射或漏发** → Task 3 护栏 + `npm run test:mesher` 61 项。
4. **自适应基准用错调用组合导致装了更慢的后端** → Task 4 固定 `NOISE_BENCH_SAMPLE` 操作数断言（noise2=5, fbm2=4, ridged2=1, noise3=2, fbm3=0）。
5. **`?wasm=0` 强制关闭被 force/实验性开关绕过** → Task 4 `resolveWasmMode` 优先级测试 + Task 5 诊断字段回归。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/world/meshTypes.ts` | `GeoArrays` 放宽为 typed array；`packMesh` 只打包已用前缀 |
| `src/world/mesher.ts` | Greedy 内层循环：坐标标量、提升可选调用、特殊方块处理（条件性） |
| `src/wasm/runtime.ts` | 纯决策函数 + 对称基准 + 自适应后端安装 |
| `src/main.ts` | `?wasm=force/0` 透传 |
| `src/diagnostics/RuntimeDiagnostics.ts` | wasm 后端诊断字段 |
| `scripts/build-test-snapshot.mjs` | 新增 `src/wasm/runtime.ts` 入口 |
| `test/mesher-fixture.cjs` | seed 2026 的 24 区块快照 fixture + 输出序列化/哈希 |
| `test/mesher-hotspot-check.cjs` | 输出护栏 + 计时（含 `--record` 写基线） |
| `test/mesher-hotspot-baseline.json` | 基线 hash + ms（由 `--record` 生成并提交） |
| `test/mesh-typed-arrays-check.cjs` | packMesh typed-array 回归 |
| `test/wasm-backend-choice-check.cjs` | 后端选择 + 参数优先级 + 基准样本断言 |
| `test/diagnostics-check.cjs` | wasm 诊断字段注入回归 |
| `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `docs/WASM.md`（存在则改） | 同步说明 |
| `package.json` | 新增 `test:mesher-hotspot` / `test:wasm-choice` 脚本（不挂 `verify`） |

---

### Task 1: packMesh 支持 typed array（B.4）

**Files:** Modify `src/world/meshTypes.ts`；Create `test/mesh-typed-arrays-check.cjs`

**Interfaces:**
- Produces: `export type GeoArray = number[] | Float32Array | Uint32Array`；`GeoArrays` 各字段改为 `GeoArray`（indices 为 `number[] | Uint32Array`）；`packMesh(d: ChunkMeshData)` 保持签名不变。
- Consumes: 无。

- [ ] **Step 1: 写失败测试** `test/mesh-typed-arrays-check.cjs`
  从 `./logic/world/meshTypes.js` 取 `packMesh`。构造 `GeoArrays`：每个分量用容量 8 的 typed array，只填前 4 个元素（indices 填 6 个）；调用 `packMesh`，断言每个 packed 数组长度等于实际写入数、逐值等于用普通 `number[]` 构造的同一份数据打包结果。

- [ ] **Step 2: 确认 RED**
  Run: `npm run test:snapshot && node test/mesh-typed-arrays-check.cjs`
  Expected: FAIL（当前 `new Float32Array(g.positions)` 会把多余的 4 个 0 一起打包）。

- [ ] **Step 3: 实现**
  在 `src/world/meshTypes.ts` 定义 `GeoArray` 并放宽 `GeoArrays`；`packMesh` 内部对每个分量用 `subarray(0, length)`（typed）或原数组（普通数组）再 `new Float32Array/Uint32Array`。不用 `as any`，strict typecheck 必须过。

- [ ] **Step 4: 确认 GREEN + 无回归**
  Run: `npm run typecheck && npm run test:snapshot && node test/mesh-typed-arrays-check.cjs && npm run test:mesher`
  Expected: 全 PASS，`test:mesher` 仍 61 项。

- [ ] **Step 5: Commit**
  `git add src/world/meshTypes.ts test/mesh-typed-arrays-check.cjs && git commit -m "feat(mesher): 支持 typed array 几何缓冲打包"`

---

### Task 2: 生产路径输出护栏与基线（B 的验收前置）

**Files:** Create `test/mesher-fixture.cjs`、`test/mesher-hotspot-check.cjs`；Generate `test/mesher-hotspot-baseline.json`

**Interfaces:**
- Produces: `makeMeshSet(): { cx: number; cz: number; config: MeshConfig; snapshot: MeshSnapshot }[]`（24 项）；`serializeMesh(out: MeshOutput): Buffer`；`meshHash(out): string`（sha256 hex）。
- Consumes: Task 1 的 `packMesh` 兼容 typed array；`test/terrain-logic` 快照。
- 这是 characterization 护栏：在当前未优化代码上先跑绿并记录基线，之后保持不变。

- [ ] **Step 1: 写 fixture 与护栏脚本**
  `test/mesher-fixture.cjs`：seed 2026，`cx=0..5, cz=0..3` 共 24 区块；`World.ensureChunk` 生成；config 用与 `test/mesher-check.cjs` 的 `makeConfig` 相同的确定性 UV 替身；每块用 `buildMeshSnapshot(world, cx, cz)` + `new SnapshotMeshSource(config, snapshot)`。`serializeMesh` 按固定通道顺序（opaque, emissive, transparent, water）与固定属性顺序把 packed 缓冲拼成 Buffer；`meshHash` 做 sha256。
  `test/mesher-hotspot-check.cjs`：断言 fixture 长度 24；`meshHash(meshChunk(src))` 等于 `baseline.json` 的 hash；打印 8 轮平均 ms。支持 `--record` 写基线。

- [ ] **Step 2: 记录基线**
  Run: `npm run test:snapshot && node test/mesher-hotspot-check.cjs --record && node test/mesher-hotspot-check.cjs`
  Expected: 生成 JSON（含 `hash`、`msPerChunk`）；第二次运行 PASS。

- [ ] **Step 3: Commit**
  `git add test/mesher-fixture.cjs test/mesher-hotspot-check.cjs test/mesher-hotspot-baseline.json && git commit -m "test(mesher): 固定 24 区块生产路径输出护栏与基线"`

---

### Task 3: Greedy 内层循环优化（B.1/B.2/B.3）

**Files:** Modify `src/world/mesher.ts`

**Interfaces:**
- Consumes: Task 2 的 `makeMeshSet()` / `meshHash()` 与 `baseline.json`。
- Produces: `meshChunk(src: MeshSource): MeshOutput` 签名不变；输出 hash 不变。

- [ ] **Step 1: 确认护栏当前绿**
  Run: `node test/mesher-hotspot-check.cjs`
  Expected: PASS（记录当前 ms）。

- [ ] **Step 2: 实施 B.1 + B.2**
  把 `blockAt(U,V,L)` 的可变数组 `bb` 换成局部标量 `bx/by/bz`（或从 `FACE_GEOMS` 预取轴映射）；把 `const [nx,ny,nz] = face.normal` 提到 `FACE_GEOMS` 预计算；把 `src.isKnown?.(...)` 提升到循环外 `const isKnown = src.isKnown ?? (() => true)`。AO / 角点光照 / mask key / emitFace 的数学与分支一字不改。

- [ ] **Step 3: 跑护栏与回归**
  Run: `node test/mesher-hotspot-check.cjs && npm run test:mesher`
  Expected: hash 一致、`test:mesher` 61 项绿。

- [ ] **Step 4: 条件性实施 B.3（合并两次扫描）**
  仅当输出 hash 仍一致时保留：在 B 段扫描中按 id 判定普通立方体建 mask / 非普通方块走 `emitBlock`，用 `Uint8Array` 去重，去掉 A 段全量扫描。**若 hash 变化（特殊方块顺序改变），立即回滚本步**——逐字节一致优先于 1.5×。

- [ ] **Step 5: 验收提速**
  Run: `node test/mesher-hotspot-check.cjs`
  Expected: PASS；`msPerChunk <= baseline.msPerChunk / 1.5`。若未达标但 hash 一致，继续在标量局部化上优化，不改语义；仍不达标则如实记录实际倍数并停止。

- [ ] **Step 6: 文档与 Commit**
  在 `docs/ARCHITECTURE.md` 网格化章节补一段 B 的说明；`docs/TESTING.md` 加 `test:mesher-hotspot` 行；`package.json` 加脚本（不进 verify）。
  `git add src/world/mesher.ts docs/ARCHITECTURE.md docs/TESTING.md package.json && git commit -m "perf(mesher): 标量化 Greedy 内层循环并保持输出逐字节一致"`

---

### Task 4: 后端选择与参数优先级纯函数（C 的决策层）

**Files:** Modify `src/wasm/runtime.ts`、`scripts/build-test-snapshot.mjs`；Create `test/wasm-backend-choice-check.cjs`

**Interfaces:**
- Produces:
  - `export const NOISE_BENCH_SAMPLE = { noise2: 5, fbm2: 4, ridged2: 1, noise3: 2, fbm3: 0 } as const;`
  - `export function chooseNoiseBackend(input: { jsMs: number; wasmMs: number; threshold?: number }): 'js' | 'wasm'`
  - `export function resolveWasmMode(param: string | null, experimental: boolean): 'off' | 'force' | 'adaptive'`
- Consumes: 无。

- [ ] **Step 1: 写失败测试** `test/wasm-backend-choice-check.cjs`
  从 `./logic/wasm/runtime.js` 取三个导出。断言：
  - `chooseNoiseBackend({ jsMs: 100, wasmMs: 70 }) === 'wasm'`
  - `chooseNoiseBackend({ jsMs: 100, wasmMs: 90 }) === 'js'`（默认 threshold 0.9 的边界）
  - `chooseNoiseBackend({ jsMs: 100, wasmMs: 80, threshold: 0.75 }) === 'js'`
  - `resolveWasmMode('0', true) === 'off'`、`resolveWasmMode('force', false) === 'force'`、`resolveWasmMode(null, true) === 'adaptive'`、`resolveWasmMode(null, false) === 'off'`
  - `NOISE_BENCH_SAMPLE` 逐值等于 `{ noise2:5, fbm2:4, ridged2:1, noise3:2, fbm3:0 }`

- [ ] **Step 2: 确认 RED**
  Run: `npm run test:snapshot && node test/wasm-backend-choice-check.cjs`
  Expected: FAIL（模块无这些导出；需先把 `src/wasm/runtime.ts` 加进 `scripts/build-test-snapshot.mjs` 的 `entries`）。

- [ ] **Step 3: 实现纯函数**
  在 `src/wasm/runtime.ts` 顶层导出上述常量与函数。`chooseNoiseBackend`：threshold 默认 0.9，仅当 `wasmMs < jsMs * threshold` 返回 `'wasm'`，非法/NaN 输入返回 `'js'`。`resolveWasmMode`：`'0'` → off；`'force'` → force；`!experimental` → off；否则 adaptive。

- [ ] **Step 4: 确认 GREEN**
  Run: `npm run test:snapshot && node test/wasm-backend-choice-check.cjs && npm run typecheck`
  Expected: PASS。

- [ ] **Step 5: Commit**
  `git add src/wasm/runtime.ts scripts/build-test-snapshot.mjs test/wasm-backend-choice-check.cjs && git commit -m "feat(wasm): 后端自适应决策与参数优先级纯函数"`

---

### Task 5: 自适应安装、参数透传与诊断（C 的接线）

**Files:** Modify `src/wasm/runtime.ts`、`src/main.ts`、`src/diagnostics/RuntimeDiagnostics.ts`、`test/diagnostics-check.cjs`、`docs/WASM.md`（若存在）

**Interfaces:**
- Consumes: Task 4 的三个导出；现有 `WasmRuntime` 构造函数与 `WasmStats`。
- Produces:
  - `WasmStats` 新增 `backend: 'js' | 'wasm' | 'pending'`、`benchJsMs: number`、`benchWasmMs: number`
  - 构造函数 options 新增 `wasmParam?: string | null`
  - 诊断 `wasm` 块新增同名字段；`window.__mc.wasm.stats()` 可读

- [ ] **Step 1: 写诊断注入测试（先红）**
  `test/diagnostics-check.cjs`：`base()` 的 `wasm` 块加 `backend: 'js', benchJsMs: 10, benchWasmMs: 15`；新增断言组：非法 `backend` 值被捕获、旧快照缺字段时跳过。
  Run: `npm run test:snapshot && node test/diagnostics-check.cjs`
  Expected: FAIL（诊断尚不认识新字段）。

- [ ] **Step 2: 实现对称基准与安装决策**
  在 `src/wasm/runtime.ts` 增加内部 `benchmarkNoiseBackends(mod, perm): { jsMs, wasmMs }`：按 `NOISE_BENCH_SAMPLE` 的固定坐标序列，分别用 `makeNoiseFunctions(perm)` 与 `createNoiseBackend(mod, perm)`（或直接使用 kernel exports）跑同样次数；不使用 `benchmark()`（它依赖 `ready` 且只测 batch）。在 `init()` 自检通过之后、安装后端之前调用；用 `chooseNoiseBackend` 决定，仅在 `'wasm'` 时 `installNoiseBackend(...)`。`force` 跳过基准直接安装，`off` 不加载。运行期异常仍走既有 fallback 路径。

- [ ] **Step 3: main.ts 透传与运行期开关**
  构造函数调用处加 `wasmParam: qs.get('wasm')`；`setExperimental` 触发的 `wasm.setEnabled(...)` 保持 off/force 参数优先，其余走自适应。不得移除 `?wasm=0` 的强制关闭能力。

- [ ] **Step 4: 诊断与文档**
  `WasmStats` 与诊断快照补字段；`docs/WASM.md`（或 `docs/ARCHITECTURE.md` 的 WASM 段）说明自适应策略与 force/off 优先级；`docs/TESTING.md` 加 `test:wasm-choice` 行；`package.json` 加脚本（不进 verify）。

- [ ] **Step 5: 全量回归**
  Run: `npm run typecheck && npm run test:snapshot && node test/wasm-backend-choice-check.cjs && node test/diagnostics-check.cjs && npm run test:wasm && npm run test:services && npm run test:mesher`
  Expected: 全 PASS；本机自适应选 JS（WASM 实测更慢），`?wasm=force` 仍可强制。
  若浏览器可用，另确认 `window.__mc.wasm.stats()` 的 `benchJsMs`/`benchWasmMs` 均 > 0；
  本环境 Chromium 无法启动，则该项如实标注未验证。

- [ ] **Step 6: Commit**
  `git add src/wasm/runtime.ts src/main.ts src/diagnostics/RuntimeDiagnostics.ts test/diagnostics-check.cjs docs/ package.json && git commit -m "feat(wasm): 仅在实测更快时安装噪声后端并暴露基准诊断"`

---

## Self-Review Notes

- Spec 覆盖：B.1/B.2 → Task 3；B.3 → Task 3 Step 4（条件性）；B.4 → Task 1；C 的基准/决策 → Task 4，接线 → Task 5；输出护栏 → Task 2；文档 → Task 3/5。
- 任务独立：Task 1-3（B）与 Task 4-5（C）无相互依赖；Task 2 依赖 Task 1 的 packMesh 兼容。
- 未把 `verify` 跑法写入任务：本环境浏览器组无法启动 Chromium，任务 5 只跑 Node 链，报告中须如实标注。
