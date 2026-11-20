# WebAssembly 支持（v1.5.0）

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
| `native/mc_kernel.wasm` | clang 编译出的真实二进制（2473 字节，ABI 2） |
| `scripts/build-wasm.mjs` | 编译 + ABI 硬校验 + 生成内联 TS；`--check` 只校验不编译 |
| `src/wasm/kernelBinary.ts` | **自动生成**：base64 / sha256 / 字节数 / ABI，禁止手改 |
| `src/wasm/protocol.ts` | 协议常量、base64 解码、能力检测、准入校验、FNV-1a |
| `src/wasm/kernel.ts` | 编译 / 实例化 / 等价性对拍 / 噪声后端 / 自定义模块 |
| `src/wasm/runtime.ts` | `WasmRuntime` 服务：生命周期、统计、基准、模块注册表 |
| `src/world/noiseMath.ts` | **唯一 JS 参考实现**（从原 `Noise` 类抽出） |
| `src/world/noise.ts` | `Noise` 只负责「后端选择」，默认行为与 v1.4.3 逐位一致 |

```bash
npm run build:wasm    # 需要 clang（支持 wasm32 目标）
npm run wasm:check    # CI / verify 用：校验内联产物与 .wasm 一致，无需编译器
```

编译命令（脚本内）：

```bash
clang --target=wasm32 -O2 -ffreestanding -nostdlib -fno-exceptions \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=131072 -Wl,--max-memory=1048576 -Wl,--strip-all \
  -o native/mc_kernel.wasm native/mc_kernel.c
```

## 3. ABI 契约（ABI = 2）

`KERNEL_REQUIRED_EXPORTS`（`protocol.ts`）与 `build-wasm.mjs` 使用同一张表；
变更导出集合时**必须同步三处并推进 ABI**。

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `memory` | WebAssembly.Memory | linear memory；perm 表 / scratch 由宿主写入 |
| `mc_abi` | `() -> i32` | ABI 版本，当前 2 |
| `mc_fingerprint` | `() -> f64` | 与实现无关的指纹，确认加载的是本内核产物 |
| `mc_perm_ptr` / `mc_scratch_ptr` / `mc_scratch_size` | `() -> i32` | 静态数组地址，避免手写内存布局与 stack 冲突 |
| `mc_noise2` / `mc_noise3` | `(f64,...) -> f64` | 值噪声，[-1,1] |
| `mc_fbm2` / `mc_fbm3` / `mc_ridged2` | `(..., i32 oct, f64 lac, f64 gain) -> f64` | 分形叠加 / 脊线噪声 |
| `mc_fbm2_batch` | `(x0,y0,step,n,oct,lac,gain) -> f64` | 一次跨界调用算 n 个点，摊薄边界开销 |
| `mc_ao` | `(s1,s2,cc) -> i32` | AO 四角亮度档位（整数原语） |
| `mc_crc32` | `(ptr,len) -> i32` | IEEE CRC32（整数原语，宿主按 `>>> 0` 读） |

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

在 Node 22 / V8 上，`benchmark(2000)` 的两次实测（`test/artifacts` 不入库，数字仅作说明）：

| 调用方式 | JS | WASM | 倍率 | 结论 |
| --- | --- | --- | --- | --- |
| **逐点** `fbm2` 逐次跨界调用 | 3.75 ms | 4.36 ms | 0.86× | 边界开销吃掉收益，V8 对短函数 JIT 更强 |
| **批量** `mc_fbm2_batch`（一次 64 点） | 1.67 ms | 0.97 ms | **1.73×** | 才是该内核的正确用法 |

因此：
- 地形生成走 `Noise.fbm2/fbm3/...` 的**逐点路径**，主要价值是**确定性 + 可替换计算后端**，
  不宣称必然加速；
- 需要吞吐的批量计算（插件、预计算、分析工具）应通过 `mc_fbm2_batch` 或自定义模块
  **一次调用处理一批数据**；
- 不同浏览器 / 设备上倍率会变，`CraftAPI.wasm.benchmark()` 可在目标环境现测，
  代码不把任何倍率写成阈值或断言。

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
| CI `wasm:check` 失败 | 提交时漏了 `native/mc_kernel.wasm` 或 `kernelBinary.ts`，重新 `build:wasm` |

## 8. 回归覆盖

`npm run test:wasm`（24 项）覆盖：内联二进制完整性、零 import / 14 导出、ABI/指纹、
1705 项等价性对拍、伪造内核检出、运行期异常回退、ready/fallback/disabled 状态机、
`setEnabled`、`benchmark`、`callKernel`、CRC32/AO、自定义模块准入与调用、权限裁剪。
`test/diagnostics-check.cjs` 另覆盖 4 个 WASM 诊断检查项。
