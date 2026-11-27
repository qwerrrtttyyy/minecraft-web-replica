# 设计：网格化热点优化 + WASM 噪声后端自适应（B+C）

日期：2026-11-22  
状态：待负责人确认  
工作规模：中等（跨 `mesher.ts` / `wasm/runtime.ts` / 测试 / 文档）

## 意图与原因

上一轮已把区块驻留从"纯距离卸载"改为"视距必留 + 缓冲区 LRU + 硬外沿"，并闭合了
M05（顶层 dispose）和 M06（配置版本竞态）。本轮要解决两个遗留问题：

1. **真正的大热点还没动**：实测网格化 `meshChunk` 每区块约 87ms，是生成（21ms）的 4 倍，
   也是玩家移动/传送时的主要 CPU 开销。
2. **现有 WASM 线是负收益**：同一批逻辑里 WASM 噪声比 JS 参考慢约 46%，
   但它目前仍可能被安装为默认后端，白白拖慢地形生成。

用户选择 **B（先优化 TS 网格化，并把数据流整理成更适合 WASM 的形态）+ C（修 WASM 噪声负收益）**。
把整个 mesher 搬进 WASM（方案 A）不在本轮范围：本机无 clang/wasm 编译器，且 C 内核有
"逐位等价"硬约束，当前不具备条件。

## 实测依据（手工跑逻辑得到，非猜测）

环境：Node 24，项目 `test/terrain-logic` 与 `test/logic` 现场编译快照，seed 2026。

| 项目 | 结果 |
|---|---|
| `generateChunk` ×64 | 21.13 ms/区块 |
| `ensureChunk` ×64（含光照） | 23.27 ms/区块 |
| `meshChunk`（Greedy，`WorldMeshSource`） | 87.27 ms/区块 |
| JS `fbm2` ×20 万 | 103.9 ms（0.00052 ms/次） |
| 现有 WASM `fbm2` ×20 万 | 151.6 ms（0.00076 ms/次，慢 46%） |
| WASM `fbm2_batch` ×20 万 | 111.0 ms（仍略慢） |
| `selectEvictions` ×3000（441 区块） | 0.078 ms/帧（可忽略） |

CPU profile（生产实际走的 `SnapshotMeshSource` + Greedy，24 区块 ×8 轮）：
**`meshChunk` 自身占 90.6% 采样**，其次是 `pushQuad` 1.2%、`emitFace` 0.8%、
`computeCornerLightInto` 0.7%、`computeAOInto` 0.6%、`getId` 0.4%、GC 0.5%。
主线程直读路径（`WorldMeshSource`）里 `getId` 8.1% + `chunkAt` 3%，但生产 Worker 走的是
快照路径，所以优化对象是 `meshChunk` 的内层扫描循环，不是 `World` 缓存。

## 目标 / 非目标 / 反目标

**目标**

- B：把 `meshChunk` 的 Greedy 内层扫描成本降下来，目标 ≥1.5×（同一 24 区块快照集合，Node 实测）。
- B：让输出与当前实现**逐字节一致**（quad 顺序、顶点属性、key 语义都不变）。
- C：移除 WASM 噪声的负收益——只在实测更快时安装 WASM 后端；本机（WASM 更慢）应自动选 JS。
- C：保留逐位等价自检和"运行期异常回退 JS"的安全网。

**非目标**

- 不把 mesher 搬进 WASM（方案 A），不改 Worker 池架构、不改 `MeshSnapshot` 数据契约。
- 不新增运行时依赖，不改存档格式、地形生成结果、方块 id / 图集 tile 索引。

**反目标（做了就算失败）**

- 为了速度改变任何方块外观、光照渐变、透明排序、Greedy 合并语义。
- 放宽 WASM 与 JS 的逐位等价规则，或用 f32/SIMD 替换 f64 运算顺序。
- 在本机重新编译 C 内核（无 clang，且会破坏 ABI 校验产物一致性）。

## 约束

- 项目硬规则：Worker 侧只依赖 `MeshSource` / `MeshSnapshot` 纯数据；`mesher.ts` 由主线程与 Worker 共用。
- 快照契约：`sky/block` 是 18×80×18 角点光照；mask key `(id | ao<<8 | sky<<10 | blk<<14) + 1`。
- 现有测试 `test:mesher` 61 项必须全绿；新增改动必须有先红后绿的回归。
- 验收用 Node 快照基准（`test/tuning-nodebench.mjs` 风格）；浏览器实景在本环境无法启动 Chromium，只能如实标注未验证。

## 方案（已在对话中比较并选定）

- **A：C 版 mesher 编进新 WASM 内核** — 收益上限最高，但需要 clang（本机没有）、逐字节对拍、
  跨线程契约改造，风险与工作量最大。**不选**。
- **B：TS mesher 优化 + 数据流整理** — 无需编译器，直接打 90.6% 的内层循环，且为将来 WASM 化留下
  对齐的缓冲接口。**选定**。
- **C：修 WASM 噪声负收益** — 不碰 C 源码，用运行时自适应选择更快后端，保持逐位等价。**选定**。
- 组合：**B + C**，两者独立可分别验收。

## 设计细节

### B：`src/world/mesher.ts` 的 Greedy 内层循环

1. **坐标标量化的 `blockAt`**：当前 `blockAt(U,V,L)` 写入可变数组 `bb` 并在循环里反复读 `b[0..2]`。
   改为直接计算三个局部标量 `bx/by/bz`，或把 face 的轴映射/方向预计算进 `FACE_GEOMS`，
   去掉每格 3 次数组下标访问与别名分析障碍。`FACE_GEOMS` 里也预存 `nx/ny/nz`，
   消除循环内 `const [nx,ny,nz] = face.normal` 的解构分配。
2. **消除每格可选调用**：`src.isKnown?.(...)` 在循环里判空；提升到循环外
   `const isKnown = src.isKnown ?? (() => true)`，调用点直接 `isKnown(...)`。
3. **合并两次全量扫描**：当前 A 段（全部 20480 格找特殊方块）与 B 段（6×约 20480 格找普通立方体）
   各扫一遍世界。改成 B 段扫描时按 id 判定：普通立方体建 mask，非普通方块走 `emitBlock`，
   用每区块的 `Uint8Array` 标记避免重复发射。必须保持出门顺序不影响任何测试断言。
4. **quad 构建去 GC**：`newGeo()` 目前返回普通 JS 数组，`pushQuad` 用 `push(...)` 逐顶点写。
   改为带容量倍增的 `Float32Array`/`Uint32Array`（初次容量按 2048 quad 估计）。
   同时放宽 `src/world/meshTypes.ts` 的 `GeoArrays` 类型，并让 `packMesh` 对 typed array
   使用 `subarray(0, length)`（否则预分配容量会被打包成 0）。若输出顺序/长度有任何变化则该子项回滚。
5. **不碰语义**：AO、角点光照、mask key、`emitFace`/`emitCross` 的数学与分支保持不变。

### C：`src/wasm/runtime.ts` 的后端自适应

1. 在 WASM 自检通过之后、安装 `NoiseBackendFactory` 之前，增加一次**代表性基准**：
   固定 perm / 坐标序列，分别计时 JS `makeNoiseFunctions` 与 WASM kernel 的等价调用
   （包含 `fbm2/fbm3/ridged2` 混合），取同样次数。
2. 提取纯函数 `chooseNoiseBackend({ jsMs, wasmMs, threshold = 0.9 })`：
   仅当 `wasmMs < jsMs * threshold` 时选择 WASM；否则 JS。阈值留 10% 裕度抵消噪声。
3. URL 参数（在 `src/main.ts` 透传）：`?wasm=0` 仍强制关闭；新增 `?wasm=force` 强制安装 WASM
   （基准/调试用，实验性关闭时也生效）；其余值走自适应。优先级
   `0 > force > 实验性设置 > 自适应`。设置页开关打开时默认走自适应，不强迫 WASM。
4. 诊断与可观测：`WasmRuntime.stats()` / 诊断快照新增
   `backend: 'js' | 'wasm'`、`benchJsMs`、`benchWasmMs`；`window.__mc` 可读。
5. 保持不变：逐位等价自检、运行期异常回退 JS、`installNoiseBackend` 的注入方式、
   `Noise` 类对外 API。
6. 不修改 `native/mc_kernel.c`、不重新编译 wasm、不改 ABI。

### 测试计划（先红后绿）

- `test/mesher-hotspot-check.cjs`（新）：用固定快照集合对 `meshChunk` 做
  (a) 输出逐字节对拍 baseline（可用快照 JSON 哈希）与 (b) 计时；断言输出一致且相对基线
  提速 ≥1.5×。计时部分对机器敏感，作为非 `verify` 的基准脚本，断言只放在输出一致性上。
- `test/wasm-backend-choice-check.cjs`（新）：纯逻辑测 `chooseNoiseBackend` 的
  更快/更慢/相等/阈值边界，以及 force/off 语义。
- `test/diagnostics-check.cjs`：若新增诊断字段，补注入式回归（保持旧快照缺字段可跳过）。
- 现有 `test:mesher` 61 项、`test:wasm` 24 项、`test:services` 55 项必须保持全绿。

## Builder check 后的决定（我的 call，可在我读文档时复核）

独立 builder 提了 5 个会改变计划的问题，答案如下。这些是我作为实现者的决策，
只有被负责人否决时才会改动计划。

1. **"逐字节一致"优先于 1.5× 提速**：顺序也算输出契约。
   B.3（合并两次扫描）若导致特殊方块的发射顺序变化，就**放弃 B.3**，保留原 A 段，
   从 B.1/B.2/B.4 拿收益。新增对拍测试必须比较**完整输出缓冲**（quad 顺序 + 所有顶点属性），
   不能只比面集合——现有 61 项 mesher 测试只比覆盖，抓不到顺序变化。
2. **自适应基准用生成器真实调用组合**，不用合成组合，也不用 `benchmark()`：
   查 `generator.ts` 得到实际热点是 `noise2`、`fbm2(octaves=3)`、`ridged2(octaves=3)`、`noise3`；
   **`fbm3` 在生成里根本没用**。用固定坐标序列分别计时 JS 与 WASM 的同一组合，
   在 `installNoiseBackend` 之前完成。`benchmark()` 依赖 `status === 'ready'` 且只测
   `mc_fbm2_batch`，不适合作为安装判据。
3. **`meshTypes.ts` 纳入 B 的范围**：`GeoArrays` 从 `number[]` 放宽为
   `number[] | Float32Array | Uint32Array`；`packMesh` 对 typed array 必须用
   `subarray(0, length)`，否则预分配的多余容量会被打包成 0，破坏逐字节判据。
   严格 typecheck 必须通过，不用 `as any`。
4. **`main.ts` 纳入 C 的范围，用于参数透传**：优先级
   `?wasm=0` > `?wasm=force` > 实验性设置 > 自适应；`force` 在实验性关闭时也生效
   （明确的调试覆盖），`0` 始终能强制关闭。`backend` / `benchJsMs` / `benchWasmMs`
   加入诊断快照与 `window.__mc`。
5. **基准基线固定为生产路径**：`SnapshotMeshSource` + 固定 24 区块 fixture
   （seed 2026，`cx=0..5, cz=0..3`，UV 替身与 `test/mesher-check.cjs` 的 `makeConfig` 一致）。
   把 fixture 抽成 `test/mesher-fixture.cjs` 供 baseline 与新测试共用，
   避免测量路径与优化对象不一致。

## 其他实现者决定

- 平台/工具：沿用项目现有 TypeScript + Node 快照测试，不引入新依赖或编译器。
- 基准数据放在 `test/` 下的独立脚本，不挂进 `verify`（与项目 `docs/EXPERIMENTS.md` 的约定一致）。
- 文档更新到 `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `docs/WASM.md`（若存在）。

## 验收清单

- [ ] `npm run typecheck` / `npm run build` 绿
- [ ] `npm run test:mesher` 61 项绿 + 新输出逐字节对拍绿
- [ ] `npm run test:wasm` / `test:services` / `test:diagnostics` 绿
- [ ] Node 基准：同一 24 区块快照集合 `meshChunk` 提速 ≥1.5×（报告前后 ms）
- [ ] Node 基准：自适应在本机选择 JS（因 WASM 实测更慢），`?wasm=force` 仍可强制 WASM
- [ ] 浏览器实景无法在本环境运行，报告中明确标注
