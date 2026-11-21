# WebAssembly 支持（v1.5.0 引入，v1.5.2 批量内核 + 内核内缓存）

> 目标：在不破坏**固定 seed 地形确定性**、不引入运行时依赖、不牺牲**单文件 `file://` 可运行**
> 的前提下，把体素引擎的数值热点搬进真实的 WebAssembly 内核，并让插件能安全复用与扩展它。

---

## 1. 设计约束

| 约束 | 做法 |
| --- | --- |
| 产物是自包含单文件 HTML | 内核以 base64 内联在 `src/wasm/kernelBinary.ts`，运行时 `decodeBase64` → 同步实例化，**不 fetch、不依赖网络** |
| 地形确定性不可变 | WASM 与 JS 参考实现必须 `Object.is` 逐位相等；未通过自检就**拒绝接管**，任何异常自动回退 JS |
| Web Worker 是内联 Blob Worker | 地形生成发生在**主线程**，网格化 Worker 只消费快照 → WASM 无需进 Worker，避免改消息协议 |
| 无 libc / 无 import | freestanding C，只用 wasm 原生指令；`WebAssembly.Module.imports` 必须为 0 |
| CI 不一定有 clang | 编译产物（`.wasm` 与内联 TS）提交进仓库；CI 只跑 `--check` 校验一致性，不重新编译 |

## 2. 目录与产物

| 路径 | 说明 |
| --- | --- |
| `native/mc_kernel.c` | C 内核源码（唯一数值实现来源之一） |
| `native/mc_kernel.wasm` | clang 编译出的真实二进制（6588 字节，ABI 3） |
| `scripts/build-wasm.mjs` | 编译 + ABI 硬校验 + 生成内联 TS；`--check` 只校验不编译 |
| `src/wasm/kernelBinary.ts` | **自动生成**：base64 / sha256 / 字节数 / ABI，禁止手改 |
| `src/wasm/protocol.ts` | 协议常量、base64 解码、能力检测、准入校验、FNV-1a |
| `src/wasm/kernel.ts` | 编译 / 实例化 / 等价性对拍 / 噪声后端 / 自定义模块 |
| `src/wasm/runtime.ts` | `WasmRuntime` 服务：生命周期、统计、基准、模块注册表 |
| `src/world/noiseMath.ts` | **唯一 JS 参考实现**（从原 `Noise` 类抽出） |
| `src/world/noise.ts` | `Noise` 只负责「后端选择」与批量接口；`?wasmBatch=0` 可切回逐点对照 |

```bash
npm run build:wasm    # 需要 clang + wasm-ld（lld），两者版本都要能产出 wasm32
npm run wasm:check    # CI / verify 用：校验内联产物与 .wasm 一致，无需编译器
```

> 只有 clang 不够：链接阶段要 `wasm-ld`（`lld` 包）。若 `clang` 报
> `Executable "wasm-ld-18" doesn't exist`，把 lld 的二进制放进 PATH（或 `CLANG=/path/clang`）。
> 同一 clang/lld 版本重编会得到**逐字节相同**的 `.wasm`——这是 `wasm:check` 敢在 CI 里
> 只比对不重编的前提。

编译命令（脚本内）：

```bash
clang --target=wasm32 -O2 -ffreestanding -nostdlib -fno-exceptions \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=131072 -Wl,--max-memory=1048576 -Wl,--strip-all \
  -o native/mc_kernel.wasm native/mc_kernel.c
```

## 3. ABI 契约（ABI = 3）

`KERNEL_REQUIRED_EXPORTS`（`protocol.ts`）与 `build-wasm.mjs` 使用同一张表；
变更导出集合时**必须同步三处并推进 ABI**。

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `memory` | WebAssembly.Memory | linear memory；perm / scratch / 批量 I/O 由宿主写入 |
| `mc_abi` | `() -> i32` | ABI 版本，当前 3 |
| `mc_fingerprint` | `() -> f64` | 与实现无关的指纹，确认加载的是本内核产物 |
| `mc_perm_ptr` / `mc_scratch_ptr` / `mc_scratch_size` | `() -> i32` | 静态数组地址，避免手写内存布局与 stack 冲突 |
| `mc_noise2` / `mc_noise3` | `(f64,...) -> f64` | 值噪声，[-1,1] |
| `mc_fbm2` / `mc_fbm3` / `mc_ridged2` | `(..., i32 oct, f64 lac, f64 gain) -> f64` | 分形叠加 / 脊线噪声 |
| `mc_batch_in_ptr` / `mc_batch_out_ptr` | `() -> i32` | 批量 I/O 固定区：输入 `f64[cap*3]`（x,y,z），输出 `f64[cap]` |
| `mc_batch_capacity` | `() -> i32` | 批量容量，当前 1024 点（JS 与 C 双重钳制） |
| `mc_batch_noise2` / `mc_batch_noise3` | `(i32 n) -> i32` | 批量值噪声：读输入区、写输出区，返回实际处理点数 |
| `mc_batch_fbm2` / `mc_batch_fbm3` / `mc_batch_ridged2` | `(i32 n, i32 oct, f64 lac, f64 gain) -> i32` | 批量分形 / 脊线噪声 |
| `mc_fbm2_batch` | `(x0,y0,step,n,oct,lac,gain) -> f64` | **旧版求和接口**，保留兼容；新代码用 `mc_batch_*` |
| `mc_ao` | `(s1,s2,cc) -> i32` | AO 四角亮度档位（整数原语） |
| `mc_crc32` | `(ptr,len) -> i32` | IEEE CRC32（整数原语，宿主按 `>>> 0` 读） |

批量设计的四个取舍：

- **固定 I/O 区 + 容量查询**，不传裸指针：内存布局不耦合，`build-wasm.mjs` 能在构建期校验
  `ptr + cap*3*8` / `ptr + cap*8` 不越界；
- **`mc_batch_*` 逐点调用与 `mc_noise2/...` 完全相同的函数**，不重排表达式，批量结果与逐点逐位一致；
- **一个 `Noise` 实例一份 WASM 实例与 linear memory**，批量区不共享，不引入跨实例状态；
- **批量入口内部有「上一格」哈希缓存**（v1.5.2）：`hash2` / `hash3` 只取决于整数格坐标，
  缓存只在**单次调用内**有效（调用开始即失效），导出的 `mc_noise2/3` 保持无状态。
  它只消除重复计算，插值与累加顺序一字未改，输出仍与 JS 逐位相等。

**表达式顺序契约**：`native/mc_kernel.c` 的每个浮点表达式与 `noiseMath.ts` 逐字对应
（`a + (b-a)*u + (c-a)*v + (a-b-c+d)*u*v`、累加顺序等）。禁止「顺手优化」——
任何重排都会产生 1 ULP 差异，改变固定 seed 地形并击穿全部回归。
坐标域限制在 i32 之内（`to_i32` 钳制以避免 `i32.trunc_f64_s` trap），实际世界坐标远小于 2^31。

## 4. 运行时生命周期

```
能力检测 → 同步加载内联内核 → magic / import / 导出 / ABI / 指纹校验
  → 等价性对拍（多 seed × 采样点 × 5 类函数 + 批量）
  → 通过：installNoiseBackend(工厂) → 之后 new Noise() 持有独立 WASM 实例
  → 失败：卸载后端、记 lastError、发 wasm:fallback，全程纯 JS
```

- 每个 `Noise` 实例 `instantiate()` 一份 Module 实例，各自独立 linear memory 与 perm 表，
  不同 seed 不会互相污染。
- 后端方法带 `guard`：WASM 抛错 → 该实例永久降级到同一份 JS 参考，并上报 runtime；
  runtime 卸载全局后端且状态落 `fallback`，诊断不会看到「ready 但已失效」的矛盾状态。
- 状态机：`disabled`（`?wasm=0` / 手动关闭）→ `unavailable` / `fallback` / `ready`。
- 事件：`wasm:ready { abi, bytes, sha256, samples }`、`wasm:fallback { reason, code? }`。

### 可观测性

```js
CraftAPI.wasm.status()          // 'ready' | 'fallback' | ...
CraftAPI.wasm.stats()           // 自检样本 / 调用数 / 回退数 / 模块数 / lastError
CraftAPI.wasm.benchmark(2000)   // JS vs WASM 同负载基准（含逐位 correct 判定）
CraftAPI.wasm.setEnabled(false) // 运行时关闭（需 wasm:use 权限，插件视图）
```

`?wasm=0` 可强制关闭 WASM，用于 A/B 对比或排查；F3 诊断新增
`wasm.status` / `wasm.abi` / `wasm.fallback` / `wasm.selfcheck` 四项检查。

## 5. 性能：诚实的数据

先给结论：**WASM 只有在「一次跨界处理一大批点」时才有优势**；逐点调用是净亏损。
以下数字来自 Node 24 / V8（4 核容器，`test/wasm-bench.cjs`），倍率仅作说明，
代码不把任何倍率写成阈值或断言。

### 5.1 内核原语（576 点/批，复用输入输出缓冲）

| 函数 | JS | WASM | 倍率 |
| --- | --- | --- | --- |
| `noise2` | 0.031 ms | 0.014 ms | 2.27× |
| `fbm2`（3 oct） | 0.049 ms | 0.022 ms | 2.22× |
| `ridged2`（3 oct） | 0.043 ms | 0.028 ms | 1.55× |
| `noise3` | 0.032 ms | 0.016 ms | 1.99× |
| `fbm3`（3 oct） | 0.084 ms | 0.040 ms | 2.12× |

### 5.2 真实调用形态（含坐标填充 / 拷贝 / 结果回传）

| 场景 | 结果 |
| --- | --- |
| 10 类列噪声（576 列，每次新建缓冲） | JS 0.231 ms → WASM 0.195 ms，**1.19×** |
| `buildContext` 整体（含 576 个对象 / 坡度 / 缓存写入） | 两者在测量噪声内持平（多次运行 0.95~1.02×） |
| 整个区块 `generateChunk`（含矿石 / 树木 / 装饰） | WASM 批量 / 旧 JS 逐点 **1.06~1.14×** |
| 批量接口引入前的逐点 WASM | **0.70×**（比纯 JS 慢约 43%） |

解读：

- 批量化把「每点一次跨界」降到「每类噪声一次跨界」，先止住 0.70× 的净亏损；
- 内核本身算得比 V8 快约 2×，但坐标填充、`Float64Array` 分配与 JS 侧组合逻辑把收益稀释到 1.1~1.2×；
- 区块生成里噪声只占一部分，端到端因此只有个位数到十几个百分点的提升；
- 想继续榨收益，方向不是「更多导出」，而是减少 JS 侧的每字段缓冲准备（复用 scratch、
  把坐标变换下推内核），代价是内核与地形语义耦合，需单独评估。
  （v1.5.2 已按这个方向做了复用缓冲与内核内格缓存，见 5.3；再往下需要新的「整列」ABI。）

`?wasmBatch=0` 可强制走逐点路径，用于在真实场景做 A/B；`CraftAPI.wasm.benchmark()`
也是同接口、同点数、同调用次数的公平对比（不再用「JS 逐点 vs WASM 批量」的混合口径）。

### 5.3 v1.5.2 第二轮：内核内哈希缓存 + JS 侧去分配

第二轮不再动 ABI（仍是 3），只改两侧实现：

**内核侧**——`hash2` / `hash3` 是整数格坐标的纯函数，而地形采样的点集是连续成行/成列的：
洞穴按列写入，同一列的 `y/11` 平均 11 个点才跨一格；列噪声按行主序，一行 24 个点全在同一格里
（最小格宽 45 个世界坐标）。于是批量入口加一层「上一格」缓存，命中只做插值：

- `mc_batch_noise3`：`(xi,yi,zi)` 缓存 8 个角哈希，顺带按 `(x,z)` 缓存 `u/w`（整列不变）；
- `mc_batch_noise2`：`(xi,yi)` 缓存 4 个角哈希；
- `mc_batch_fbm2` / `mc_batch_ridged2`：**倍频循环提到外层、点循环放内层**，
  这样同一倍频的连续点才能命中缓存；每个点的累加顺序（从 `0.0` 起逐倍频相加）与原来
  完全相同，输出逐位不变。

**JS 侧**——列缓存的键改成整数配对（`(x+2²⁵)*2²⁶+(z+2²⁵)`，超出安全域回退字符串），
批量坐标与 10 路输出改用复用缓冲（每区块从 10 次 `Float64Array` 分配降到 0），
洞穴每行只做 2 次跨界而不是每列 2 次，阈值表取代逐格 `smoothstep`，
缓存腾空从每列一次改成每区块一次。

| 场景 | 结果 |
| --- | --- |
| 洞穴形态的 `noise3`（同列连续 y） | 15.6 → **6.8 ns/点**（2.3×） |
| 散乱点 `noise3`（缓存全 miss） | 29.6 → 23.2 ns/点（1.28×） |
| 真实列噪声 `fbm2`（3 oct，行主序） | 39.2 → 31.9 ns/点 |
| 真实列噪声 `noise2` | 17.0 → 11.7 ns/点 |
| 3000 区块稳态（A/B 交替计时） | 0.557 → **0.455 ms/区块**（1.22×） |
| 同一次运行三模式对照 | js 逐点 0.884 / js 批量 0.783 / wasm **0.511** ms/区块 |

机器噪声约 ±10%，上表全部是「同机、同负载、多次取最小」的口径。CPU 采样里内核占比
从 51% 降到 36%，剩下的大头是 `buildContext` 的缓存读写与对象分配（20%）、
`emitColumnSegment` 的填块循环（10%）。

> 缓存对**散点**批量是净亏损（全 miss 时 `fbm2` 慢约 1.6×）。地形是连续点集才有收益，
> 插件如果拿散点大批量调 `fbm2`，收益会消失——这是有意的取舍，不是精度问题。

## 6. 插件扩展点

`CraftAPI.wasm` 的完整接口：

| 方法 | 权限 | 说明 |
| --- | --- | --- |
| `status()` / `stats()` / `benchmark()` / `listModules()` | 只读 | 无需声明权限 |
| `call(name, ...args)` | `wasm:use` | 调用内置内核数值导出 |
| `callModule(id, fn, ...args)` | `wasm:use` | 调用插件模块导出 |
| `registerModule(id, bytes\|ArrayBuffer\|base64)` | `wasm:use` | 注册自定义 WASM 模块 |
| `unregisterModule(id)` / `setEnabled(v)` | `wasm:use` | 注销 / 开关 |

自定义模块**准入规则**（`compilePluginModule`）：

1. 合法 magic、`≤ 256KB`、导出 `≤ 64` 个、内存 `≤ 16` 页；
2. **零 import**（不允许回调宿主 / 访问 DOM / 发起网络）；
3. 只导出 `function` / `memory`，拒绝 table / global；
4. 调用参数最多 16 个且必须是有限数值，返回值必须是数值；
5. 最多注册 16 个模块，id 遵循插件命名规则，重复注册拒绝。

示例（`src/plugins/example/wasmProbe.ts`，不默认启用）：

```js
CraftAPI.plugins.register(wasmProbePlugin);
await CraftAPI.plugins.enable('example:wasm-probe');
// 插件内：
api.wasm.call('mc_ao', 1, 0, 1);           // => 1
api.wasm.registerModule('example:math', bytes);
api.wasm.callModule('example:math', 'add', 2, 3);
```

> 注意：`CraftAPI.plugins.install(source)` 用 `new Function` 执行**可信源码**（等价 eval），
> 不会自动 fetch 远程内容；只加载你自己审计过的片段，详见 `src/services/plugins/loader.ts`。

## 7. 故障排查

| 现象 | 排查 |
| --- | --- |
| `wasm:fallback` + `lastError` 含「编译失败」 | 内联产物损坏 → `npm run build:wasm` 重新生成 |
| 「等价性自检失败」 | C 与 `noiseMath.ts` 表达式顺序漂移，**不要放宽对拍**，修实现 |
| 「指纹与 JS 参考不一致」 | 加载的不是本仓库编译产物，检查 `kernelBinary.ts` |
| `?wasm=0` 正常、默认异常 | 内核或后端问题；用 `CraftAPI.wasm.stats()` 看 `fallbacks` |
| `?wasmBatch=0` 正常、默认异常 | 问题在批量路径：先用 `test:wasm` 看批量对拍，再查 `mc_batch_*` 导出与容量 |
| CI `wasm:check` 失败 | 提交时漏了 `native/mc_kernel.wasm` 或 `kernelBinary.ts`，重新 `build:wasm` |

## 8. 回归覆盖

`npm run test:wasm`（29 项）覆盖：内联二进制完整性、零 import / 22 导出、ABI/指纹、
1705 项等价性对拍、15000+ 项批量逐位对拍、批量容量与钳制、`?wasmBatch=0` 对照开关、
伪造内核检出、运行期异常回退、ready/fallback/disabled 状态机、`setEnabled`、`benchmark`、
`callKernel`、CRC32/AO、自定义模块准入与调用、权限裁剪。
`test/diagnostics-check.cjs` 另覆盖 4 个 WASM 诊断检查项。
