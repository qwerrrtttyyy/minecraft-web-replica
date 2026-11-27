# Mobile/Performance line — 完整执行报告

日期：2026-11-22 · 分支：`mobile-frametime` · 基线：`90ccd6c8f1893298f9ba28c2683fe7bbe318038b`

## 状态：DONE

4 张任务卡 M01–M04 全部完成，先红后绿、逐任务本地提交、未 push。硬门「输出逐字节一致」全程保持；提速目标超额达成。

## 性能摘要

| 项 | 值 |
|---|---|
| 生产路径 | 24 区块 seed 2026，cx=0..5 / cz=0..3，`SnapshotMeshSource`，确定性 UV 替身 |
| 集合 SHA-256（24 块串联后再 sha256） | `816ba4ba6eb4c6a5b0ef381077fe4ab191fa7e2d1e3154537998bfdbd8e8a5eb` |
| 优化前基线 | **142.561 ms/chunk**（`--record` 实测，本机并行负载；规格来源数据为 87.27） |
| 优化后 | **20.505 ms/chunk**（8 轮平均） |
| 实测提速 | **6.95×**（目标 ≤95.04 ms/chunk，要求 1.5×，已超额达成） |
| hash 是否变化 | 否（每步重跑护栏） |

B.3（合并两次全量扫描）为条件性可选项，会改变特殊方块发射顺序（规格明确警告破坏逐字节一致）。B.1+B.2 已使目标超额达成，按「逐字节一致优先于速度」红线主动放弃 B.3。

---

## Task 1 — verify:node 与生产路径护栏基线（M01）

- **BASE** `90ccd6c8f1893298f9ba28c2683fe7bbe318038b` → **HEAD** `ec6283554fef20f700b52f0ef46a00be76ac149c`
- 变更：`package.json` 新增 `verify:node` 与 `test:mesher-hotspot`；新建 `test/mesher-fixture.cjs`、`test/mesher-hotspot-check.cjs`、`test/mesher-hotspot-baseline.json`。已脚本化核对 `verify:node` = `verify` 精确去掉 `test:smoke`/`test:options`/`test:visual`，保留 `test:mobile`（33 项逐项一致）；`verify` 原样未改；`test:mesher-hotspot` 不挂任何链。
- RED：`node test/mesher-hotspot-check.cjs` → **exit 1**（baseline.json 不存在，已算出 hash `816ba4…`）。
- 记录基线：`node test/mesher-hotspot-check.cjs --record` → **exit 0**（写入 hash + 142.5607 ms/chunk）；复查 → **exit 0**（hash 一致）。基线在任何优化前提交。
- 回归：`npm run typecheck` → exit 0；`npm run test:snapshot` → exit 0；`npm run test:mesher` → 61 项 exit 0；`npm run test:mobile` → exit 0。
- Commit：`test(mesher): 固定 24 区块输出护栏、性能基线与 verify:node`

## Task 2 — packMesh typed-array 支持（M02）

- **BASE** `ec62835` → **HEAD** `f321ed9c43820d8b180da42f23bca229e5442108`
- 变更：`meshTypes.ts` 新增 `GeoArray = number[] | Float32Array | Uint32Array`、`MutableGeoArrays`、`MutableChunkMeshData` 与 `used` 前缀标记；`packMesh(d: ChunkMeshData)` 签名不变，对 typed array 用 `subarray(0, used)` 只打包已用前缀，普通数组原样；`mesher.ts` 收集期用窄类型，`publish()` 对外契约不变，全程无 `as any`。
- RED：`node test/mesh-typed-arrays-check.cjs` → **exit 1**（旧实现把预分配容量尾部 0 打包）。
- GREEN：`npm run typecheck` → exit 0；`npm run test:snapshot` → exit 0；`node test/mesh-typed-arrays-check.cjs` → 37 项 exit 0；`node test/mesher-hotspot-check.cjs` → hash 一致 exit 0；`npm run test:mesher` → 61 项 exit 0；`npm run test:mobile` → exit 0。
- Commit：`perf(mesher): 支持 typed array 几何缓冲并只打包已用前缀`

## Task 3 — Greedy 内层循环标量化（M03）

- **BASE** `f321ed9` → **HEAD** `c0feb7a70601bd0a96f32b80f60fdf2112339983`
- 变更（仅 `src/world/mesher.ts`）：`FACE_GEOMS` 预存 `nx/ny/nz`；`isKnown` 提升到函数入口并 `bind(src)`（保留 `this.snapshot` 语义）；`blockAt` 可变数组改为 face 级不变量 + 局部标量 `bx/by/bz`；合并 quad 的 `base`/`duV`/`dvV` 数组改为 face 级常量标量 `baseX/Y/Z`、`duX/duY/duZ`、`dvX/dvY/dvZ`。AO / 角点光 / mask key / emitFace 数学一字未改。
- Step 1 护栏当前绿：20.5ms 量级，hash 一致。
- GREEN：`npm run typecheck` → exit 0；`npm run test:snapshot` → exit 0；`node test/mesher-hotspot-check.cjs` → hash 一致，20.505 ms/chunk，6.95×，exit 0；`npm run test:mesher` → 61 项 exit 0；`npm run test:mobile` → exit 0。
- B.3 条件步骤：**未实施**（见上）。
- Commit：`perf(mesher): 标量化 Greedy 内层循环并保持输出逐字节一致`

## Task 4 — 验收与 evidence（M04）

- **BASE** `c0feb7a` → **HEAD**：(本次最后一个 commit)
- 变更：`test/mesher-hotspot-baseline.json` 附带 optimized / toVerify / verification 字段；`docs/agent/tasks/M04.yaml` 追加 evidence 段。未触碰 EXPERIMENTS.md / CHANGELOG.md / validate.py / README / ARCHITECTURE / TESTING。
- **验收命令与真实退出码**：
  - `npm run verify:node` → **exit 0**（全绿；含 check:version、permtable、wasm:check、lint、typecheck、build、snapshot、全部 Node 测试及 `test:mobile`）
  - `npm run verify` → **exit 1**，精确错误：`Error: Failed to launch the browser process!` / `Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.` / `Please install it with: snap install chromium`（位于 `test:smoke`，本机无可用浏览器，环境阻塞；未改浏览器脚本、未安装浏览器）
  - `node test/mesher-hotspot-check.cjs` → exit 0（hash 一致）
  - `npm run test:mesher` → exit 0（61 项）
  - `npm run test:mobile` → exit 0
- `p95<33ms @ 默认移动设置` 记为 TO-VERIFY 目标（需有浏览器环境验证），非门。
- Commit：`docs(mobile): 性能基线与验收 evidence`

---

## Commit 链

```
90ccd6c → ec62835  Task 1  test(mesher): 固定 24 区块输出护栏、性能基线与 verify:node
ec62835 → f321ed9  Task 2  perf(mesher): 支持 typed array 几何缓冲并只打包已用前缀
f321ed9 → c0feb7a  Task 3  perf(mesher): 标量化 Greedy 内层循环并保持输出逐字节一致
c0feb7a → <HEAD>   Task 4  docs(mobile): 性能基线与验收 evidence
```

## 偏差与关注点

1. **B.3 未实施**：条件性可选项，存在改变特殊方块发射顺序 → 破坏逐字节一致的风险；1.5× 目标已由 B.1+B.2 超额达成，按红线主动放弃（诚实高于速度）。
2. **时间敏感测试偶发波动**：`test:logic:vitest` 的「单区块平均生成耗时 < 40ms」在本机并行负载（loadavg ~25）下偶发失败（独立重跑 2/3 通过），与本次改动无关（未触碰生成代码）；最终 `verify:node` 全绿 exit 0。
3. **基线绝对值差异**：本机实测基线 142.561 ms/chunk 高于规格来源的 87.27 ms/chunk（并行负载 + 机器差异）；提速倍数按本机同环境前后对比计算，真实可信。
4. **浏览器阻塞**：本机无可用浏览器，`verify` 必失败于 `test:smoke`（snap wrapper）；按环境阻塞如实记录，未修改脚本。
5. **范围**：WASM 噪声后端、诊断、`?wasm=`、`native/mc_kernel.c`、`kernelBinary.ts`、Worker 池、MeshSnapshot 契约全程未触碰；无新增依赖。
