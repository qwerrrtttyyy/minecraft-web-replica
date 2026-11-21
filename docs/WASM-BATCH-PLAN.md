# WASM 批量内核优化计划（ABI 3）

> 目标：把 WASM 从「负收益的逐点后端」改造成「地形生成的批量数值内核」，
> 在不破坏固定 seed 地形确定性、单文件 `file://`、零运行时依赖的前提下，
> 把地形生成的 JS↔WASM 跨界调用次数降低 1–2 个数量级。
>
> 状态：**已执行（v1.5.2）**。执行顺序与验收标准见 §3，风险与回滚见 §4，实测结果见 §7。

---

## 1. 基线（本机实测，Node v24.14.0）

`node test/wasm-bench.cjs --rounds=3 --chunks=64`：

| 模式 | 平均耗时 | 相对 JS |
| --- | --- | --- |
| 纯 JS（不装 WASM 后端） | 1.03 ms/区块 | 1.00× |
| WASM 逐点（当前生产路径） | 1.46 ms/区块 | **0.70×（慢 30%）** |

- 单区块生成约 1.9 ms（`test:logic` 固定断言），WASM 逐点额外成本约 0.43 ms/区块。
- 逐点路径每个区块约 **1.8 万次** `noise3` 跨界（洞穴）+ **5 千次** 高度/群系跨界，
  跨界开销完全吃掉计算收益。
- `mc_fbm2_batch` 存在但**生产代码零调用**，且只返回累加和，无法重建逐点结果。

**结论**：当前 WASM 对游戏运行是净负收益。优化方向不是「更快的逐点」，而是**批量**。

## 2. 设计

### 2.1 ABI 3 新增导出（8 个）

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `mc_batch_in_ptr` | `() -> i32` | 批量输入区地址：每点 3 个 f64（x,y,z），2D 函数忽略 z |
| `mc_batch_out_ptr` | `() -> i32` | 批量输出区地址：每点 1 个 f64 |
| `mc_batch_capacity` | `() -> i32` | 最大批点数（1024） |
| `mc_batch_noise2` | `(n) -> i32` | 批量值噪声 2D |
| `mc_batch_noise3` | `(n) -> i32` | 批量值噪声 3D |
| `mc_batch_fbm2` | `(n, oct, lac, gain) -> i32` | 批量 fBm 2D |
| `mc_batch_fbm3` | `(n, oct, lac, gain) -> i32` | 批量 fBm 3D |
| `mc_batch_ridged2` | `(n, oct, lac, gain) -> i32` | 批量脊线噪声 2D |

返回值 = 实际处理点数（`n` 钳制到 `[0, capacity]`）。逐点独立求值、不累加，
内部调用同一个 `mc_noise2/3`，因此与 JS 逐点天然逐位一致。

保留原有 14 个导出；`KERNEL_REQUIRED_EXPORTS` 从 14 增至 22。

### 2.2 内存布局与预算

```c
#define BATCH_CAPACITY 1024
static u8  perm[512];                       /* 512 B   */
static f64 batchIn[BATCH_CAPACITY * 3];     /* 24 KB   */
static f64 batchOut[BATCH_CAPACITY];        /*  8 KB   */
static u8  scratch[4096];                   /*  4 KB   */
```

- 静态数据约 37 KB，`--initial-memory=131072`（128 KB）仍有余量；若链接告警再提到 262144。
- 容量 1024 覆盖 `buildContext` 的 24×24 = 576 列，留 1.7× 余量。
- 每个 `Noise` 实例独立 linear memory，批量区互不干扰。

### 2.3 JS 层接口

```ts
// noiseMath.ts
export type NoiseBatchKind = 'noise2' | 'noise3' | 'fbm2' | 'fbm3' | 'ridged2';
export interface NoiseBatchOptions { octaves: number; lacunarity: number; gain: number }

export interface NoiseFunctions {
  // ...原有 5 个逐点方法
  /** 批量求值：coords 每 3 个 f64 一个点，结果写入 out[0..count) */
  batch(kind: NoiseBatchKind, coords: Float64Array, count: number, out: Float64Array, opts?: NoiseBatchOptions): void;
}
```

- **JS 参考实现也实现 `batch`**（逐个调用对应逐点函数）——`?wasm=0` 与 fallback 时
  批量路径照常工作，生成器无需分支。
- `Noise` 类新增 `batch(...)`：有 WASM 后端走内核，异常则永久降级到 JS `batch`；
  无后端直接走 JS。

### 2.4 生成器批量化

**Phase 3a（洞穴，独立、低风险）**：`stageColumns` 每列先收集有效 y（`4 <= y <= h-4` 且
`fade > 0`），填充 `cave` / `cave2` 两组坐标，各一次批量调用。
跨界次数：约 1.8 万 → 约 512 次/区块。

**Phase 3b（高度/群系，收益最大）**：`buildContext` 的 576 列按噪声实例分组批量采样：
1. `warpNoise.noise2` ×2 组 → warp 坐标；
2. `continent.fbm2` / `hills.fbm2` / `mountain.ridged2` / `river.noise2` / `biomeJitter.noise2`；
3. `temperature.fbm2` / `humidity.fbm2` / `biomeJitter.noise2`。

为杜绝两份实现漂移，把组合逻辑抽成单一函数：

```ts
interface HeightSamples { continent; detail; ridge; river; wobble }
private composeHeight(x, z, s: HeightSamples): number   // 原 rawHeight 的 JS 组合逻辑

interface BaseSamples { temperature; humidity; jitter }
private composeBase(height, s: BaseSamples): ColumnBase
```

域扭曲在采样阶段完成（`warped()` 的批量版），`composeHeight` 只接收已组合所需的噪声值，
避免把 warp 结果与最终高度的职责混在一起。

`height()` / `rawHeight()` / `base()` 与批量路径都调用同一组 `compose*`，
逐点采样与批量采样只是数据来源不同。

缓存策略：`buildContext` 先查 `baseCache`，命中列不参与批量；未命中列批量算完后
按原键写回 `heightCache` / `baseCache`。缓存值不变，仅写入顺序变化。

### 2.5 回退与开关

| 机制 | 行为 |
| --- | --- |
| `?wasm=0` | 卸载 WASM 后端，批量路径走 JS 参考 `batch` |
| `?wasmBatch=0` | 强制逐点路径（A/B 对比 / 排查），新增开关 |
| 批量调用异常 | 该后端永久降级到 JS `batch`，计入现有 `stats.fallbacks`，发 `wasm:fallback`（未新增独立 `batchFallbacks` 字段，避免诊断口径分裂） |
| 自检失败 | 与现有逻辑一致：拒绝接管，全程 JS |

## 3. 分期任务

### Phase 1｜内核 + 协议 + 构建链

| 文件 | 改动 |
| --- | --- |
| `native/mc_kernel.c` | ABI 3；新增批量区与 8 个导出；`mc_batch_*` 内部复用 `mc_noise2/3` |
| `src/wasm/protocol.ts` | `KERNEL_ABI=3`；导出表 +8；`BATCH_CAPACITY=1024` |
| `scripts/build-wasm.mjs` | `ABI=3`；`REQUIRED_EXPORTS` +8；校验批量区不越界 |
| `src/wasm/kernelBinary.ts` | 由 `npm run build:wasm` 重新生成（禁手改） |

验收：`npm run build:wasm` 通过 ABI 校验；`npm run wasm:check` 一致；`test:wasm` 更新断言后全绿。

### Phase 2｜后端批量接口 + 等价性回归

| 文件 | 改动 |
| --- | --- |
| `src/world/noiseMath.ts` | `NoiseBatchKind` / `NoiseBatchOptions`；`batch` 进 `NoiseFunctions`；JS 循环实现 |
| `src/wasm/kernel.ts` | `KernelExports` +8；`WasmKernelInstance.batch`；`createNoiseBackend` 批量 guard |
| `src/world/noise.ts` | `Noise.batch(...)`，异常回退 |
| `src/wasm/runtime.ts` | `benchmark` 改为两侧同走批量接口的公平口径；批量调用计入现有 `calls` / `fallbacks` |
| `test/wasm-check.cjs` | ABI 3 / 22 导出；批量对拍（多 seed × 5 函数 × 边界 0/1/1023/1024/1025）；异常回退 |

验收：`test:wasm` 全绿；批量结果与 JS 参考 `Object.is` 逐位相等。

### Phase 3a｜洞穴噪声批量

| 文件 | 改动 |
| --- | --- |
| `src/world/generator.ts` | `stageColumns` 收集 y → `cave.batch` / `cave2.batch` → 用结果判定隧道；`?wasmBatch=0` 开关落在 `Noise.batch`，生成器无需分支 |

验收：`test:logic` 23 组全绿（固定 seed 地形逐位不变）；基准显示区块生成不慢于纯 JS。

### Phase 3b｜高度/群系批量

| 文件 | 改动 |
| --- | --- |
| `src/world/generator.ts` | 抽 `composeHeight` / `composeBase`；`buildContext` 批量采样 + 缓存写回 |

验收：`test:logic` / `test:terrain-system` 全绿；40 seed 出生点、河道、跨区块树冠断言不变。

### Phase 4｜基准、文档、版本、验收

| 文件 | 改动 |
| --- | --- |
| `test/wasm-bench.cjs` | 三种模式（js-point / js-batch / wasm）+ 仅 `buildContext` 的微基准，剥离矿石/树木/装饰干扰 |
| `docs/WASM.md` | §3 ABI 表 +8；§5 性能表更新；§8 回归项 |
| `CHANGELOG.md` / `README.md` | 新版本条目与版本标记 |
| `src/core/version.ts` / `package.json` | 版本号（默认 **1.5.2**；若你要求 minor 则 1.6.0，见 §5） |
| `AGENTS.md` §6 | 文档索引加入本计划（如保留） |

验收：`npm run verify` 全绿；无浏览器环境时单独说明未执行项，不冒充通过。

## 4. 风险与回滚

| 风险 | 概率 | 影响 | 处置 |
| --- | --- | --- | --- |
| 批量表达式与逐点偏差 1 ULP | 低 | 地形确定性破裂 | 批量内部直接调用原有 `mc_noise2/3`；`Object.is` 对拍拦住 |
| 缓存写入顺序改变导致性能抖动 | 中 | 不影响正确性 | 基准对比；必要时批量路径不写 `heightCache` |
| 生成器重构引入行为差异 | 中 | 固定 seed 地形变化 | `compose*` 单一实现 + `test:logic` 全绿；Phase 3a / 3b 独立提交，可单独回滚 |
| ABI 3 与生成物不同步 | 低 | CI `wasm:check` 失败 | 三处同步 + `build:wasm` 重新生成 |
| 批量区越界 | 低 | 内核 trap | C 侧钳制 `n`；JS 侧校验 `count <= capacity` |

**回滚点**：Phase 1–3 每期独立可编译、可测试；任一期失败即停在该期，保留 `?wasmBatch=0`
让生产退回逐点路径。

## 5. 待决策

1. **版本号**：默认 `1.5.2`。仓库存在既有 `v1.6.0` 注释（插件载体 / 高级设置），
   若本轮占用 1.6.0 会与该批功能共号；除非一并清理残留，否则建议 1.5.2。
2. **`?wasmBatch=0` 是否保留为长期开关**：默认保留，便于线上 A/B。
3. **是否把 `mc_fbm2_batch`（累加版）标记为废弃**：默认保留，插件可能已依赖。

## 6. 验收清单

- [x] ABI 3，22 个导出，零 import，指纹一致
- [x] 批量内核与 JS 参考逐位相等（多 seed × 5 函数 × 容量边界，15000+ 样本）
- [x] 固定 seed 地形逐位不变（`test:logic` / `test:terrain-system`）
- [x] `npm run verify` 全绿（27 步含浏览器组，本机 Xvfb + 桌面 GL 实跑通过）
- [x] 基准：批量路径区块生成耗时 ≤ 纯 JS，且显著优于 WASM 逐点
- [x] 文档、CHANGELOG、版本号三处一致

## 7. 执行结果（v1.5.2）

| 项 | 结果 |
| --- | --- |
| 内核原语 576 点/批 | WASM 比 JS 快 1.55~2.27× |
| 10 类列噪声（含缓冲准备） | 1.19× |
| `buildContext` 整体 | 与 JS 持平（多次运行 0.95~1.02×，差异在测量噪声内） |
| 整区块生成 | WASM 批量 / 旧 JS 逐点 1.06~1.14× |
| 逐点 WASM（改造前） | 0.70× |
| 固定 seed 地形 | 洞穴空腔 3652、河道 3471 列、海洋 147 区块、40 seed 出生点均不变 |

结论：批量化先修掉了逐点路径的净亏损，内核算力优势在真实调用形态下被 JS 侧缓冲准备与
组合逻辑稀释。`buildContext` 的 A/B 差异落在噪声内，因此不宣称「列信息阶段提速」；
端到端的 1.06~1.14× 才是可复现的结论。进一步优化方向是把每字段的坐标填充/分配从 JS 侧移走
（复用 scratch 或坐标变换下推内核），属于下一轮，不在本计划内。

> 上述方向已在 v1.5.2 落地（复用缓冲 + 内核内单格哈希缓存 + 倍频外提），
> ABI 仍是 3；结果与取舍见 [WASM.md](WASM.md) §5.3。
