# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。
版本号遵循「双轨版本」约定：正式版 `vN`（里程碑）/ 迭代版 `X.Y.Z`（日常迭代），
唯一来源为 `src/core/version.ts`。更详细的演进实录见 README 各版本记录章节。

## [Unreleased]

## [1.5.1-alpha.1] - 2026-11-21

本预发布整合三个开放 PR（#17 审查修复、#18 实验性玩法、#19 3D 优化）并在合并后统一审查修正。

### 整合自 PR #17 / #18

- **4 个新群系 / 地貌**：恶地（彩色陶瓦层理 + 红沙）、沼泽（泥地表 + 苔藓/睡莲）、热带草原（干草 + 伞形金合欢）、樱花林（粉冠樱花树）；仍由 `BIOME_PROFILES` 驱动。
- **12 个新方块**（id 98~109，append-only；92~97 保留给插件）：5 色陶瓦、红沙、泥、干草、金合欢/樱花原木与树叶，配套逐像素纹理与两种新树形。
- **跳跃输入缓冲**（落地前 120ms）与**命中反馈**（碎屑 + 封顶屏震 + 音效去疲劳），新增 `test:feel`(8)。
- **实验性玩法 7 开关**：随机刻速度 / 昼夜循环 / 死亡保留物品 / 生物生成 / 体素云层 / 方块重力 / 透明排序；即时生效并持久化，`Options` 新增 7 字段，`survival:death` 补 `itemsLost` / `keepInventory`。
- **审查修复**：存档三态与坏档隔离、权限表 52 条路径机械校验、物理子步扫掠与去嵌入、光照 BFS 时间片（M03）、爆炸批量写入 + 光照 deferred flush（M04）、对角区块标脏（M07）、发光装饰补光（M08）、方块 ID 冲突治理（M09）、v2 存档缺 mode 拒绝（M10）、过期 off() 守护（M11）、爆炸视线遮挡（M13）。

### PR #19：两轮 3D 优化

两轮 3D 优化合并于本版本：第 1 轮逐顶点平滑光照，第 2 轮渲染通道与顶点布局整理。
第 2 轮的三个改动全部以**受控实验**形式落地（假设 / 对照 / 翻转方式 / 判据），
设置、原始数据与复现步骤见 [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)，
测量脚本 `test/experiment-3d.mjs`（`npm run test:experiment`，不挂进 `verify`）。

### 第 1 轮：逐顶点平滑光照

#### 新增

- **平滑光照**：光照从「整面一个值」改为**逐顶点**——每个角点取「空气侧」相邻 4 格光照的均值
  （原版同款模型）。墙面、地面、树干底部、洞口与火把周围不再是大片死平，
  接触阴影与光源衰减都变成连续渐变。实测方块展示墙的像素颜色数从 6877 涨到 12968。
- 角点光照的 3×3 补丁采样（9 格取样供 4 个角点共用），比逐角点各取 4 格省一半采样。
- 运行时诊断新增 `chunks.mergeBudget`：盯住「Greedy 合并被改坏」这一高风险不变量
  （平滑光照会让部分面退回逐面输出，若合并彻底失效则平均 quad 数会回到逐面基线）。
- 新增回归：`test/mesher` 平滑光照生效性 3 项（梯度确实存在、占比在合理区间、
  Greedy 与逐面的梯度面占比一致）、`test/diagnostics` 合并预算 3 项。

#### 变更

- Greedy mask key 的 `sky / block` 字段改为写**角点光照等级**（位布局不变，
  `id | ao<<8 | sky<<10 | block<<14`）；四角光照不一致的面退回逐面输出，
  以保证合并结果与逐面输出严格等价。
- 网格化 quad 数 8039 → 8525（+6%），单区块网格化 CPU 34 ms → 35.8 ms（+5%）。
  面覆盖集合、贴图 tile、逐格亮度全部不变（`test/mesher` 实测亮度差 `0.0e+0`）。
- 已知限制更新：光照不再是「15 级硬边无插值」，改为逐角点插值（角点间仍有 1/15 台阶）。

#### 说明

- 角点光**不需要新的顶点属性**（`aLight` 本就是逐顶点 vec2），
  也**不需要新的快照字段**（1 格 halo 已足够取到角点所需的 4 格）——
  数据/渲染解耦与 Worker 边界均未变化。

### 第 2 轮：渲染通道与顶点布局整理

#### 新增

- **顶点属性打包**：每顶点 60 B → **44 B**。`colors`(3) + `aTileRect`(4) 收成
  `aShade`(1) + `aTileOrigin`(2)，tile 尺寸改由 uniform `uTileSize` 提供。
  显存与带宽下降，着色完全不变。
- **抗锯齿分档** `?aa=off|msaa|ssaa`（默认 `off`）：`msaa` 在创建 GL 上下文时打开硬件抗锯齿，
  `ssaa` 按 `SSAA_SCALE = 1.5` 超采样（受 `MAX_PIXEL_RATIO` 封顶）。二者都可在运行时切换
  （`setQuality` / `applyPixelRatio` 同一套路径）。
- **实验测量脚本** `test/experiment-3d.mjs`：固定种子 / 固定相机 / 固定区块集合 /
  最小系统组 / 冻结水面与天空相位，同页翻转变量并做像素级 A/B，自带 12 项有效性闸门
  （含「噪声底必须为零」），数据落 `test/artifacts/experiment-3d.json`。

#### 变更

- **自发光并入不透明通道**：萤石 / 南瓜灯 / 火把不再开独立 emissive 通道，改为复用不透明材质
  + 顶点开关 `aTint = 2`，shader 跳过光照与植被染色（保留面定向 × AO 明暗）。
  实测 draw call 64 → 47、emissive mesh 49 → 0、program 数不变，
  **顶点缓冲与索引缓冲逐字节相同**，15552 个归一化像素采样**零差异**。
  `?emerge=0` 保留旧的独立 emissive 通道作对照。
- 网格通道从「不透明 / 自发光 / 半透明 / 水」收敛为**不透明 / 半透明 / 水**三通道，
  自发光几何与不透明几何同材质、同 draw call 批次。
- `MeshConfig` 增加 `mergeEmissive` 字段，贯通 `mesher` / `chunkManager` / `main`；
  `MeshSource` 暴露 `mergeEmissive`，Worker 侧行为与主线程一致。

#### 说明

- 顶点布局与通道归属都不改变着色：`test/mesher` 新增「并入 vs 独立通道」逐顶点等价断言
  （51 项全过），`test:visual` 13/13，`npm run verify` 全绿。
- 抗锯齿默认关闭：软件渲染下 MSAA / SSAA 的帧率代价明显，是否默认开启留待真机数据。

## [1.5.0] - 2026-11-20

### 新增
- **实验性内容开关**（设置页，默认关闭）：开启后启用真实 WebAssembly 噪声内核（逐位等价性自检 + 失败自动回退）、插件三载体（js / wasm:module / wasm:host）与扩展点注册表（世界生成 / 游戏循环）；关闭后回到与 v1.4.9 一致的纯 JS 路径。
- 插件体系 v2：semver 依赖约束、可选依赖、apiVersion/capabilities/priority/timeoutMs/config、热重载、enableAll、stats、命名空间存储、私有服务、反向依赖保护（force=true 级联）。
- 代码审查修复：EventService/EventChannel.once 幂等、Engine.dispose 解绑监听、相机远平面共享常量、fallbackToMain 先 settle、moveBody 最近面钳制等 8 项。
- 新增回归：`test:wasm`(24)、`test:plugin-v2`(21)、`test:plugin-carrier`(15)、`test:review-fixes`(15)。

### 保留（自 v1.4.9）
- 设置页高级项与导入导出、生存合成系统、IndexedDB 存档、PWA、按键重绑定与手柄、AABB 脱困与透明排序、群系染色与方块重力、Biome 门禁。
- 双轨版本：`RELEASE=v1`（正式里程碑）/ `VERSION=1.5.0`（迭代）；预览版标签 `1.5.0-alpha.1` → `beta.1` → `rc.1` → `1.5.0`。

## [1.4.9] - 2026-11-15

### 新增
- 整合此前的开放 PR：插件体系强化、设置页、合成系统、体验优化（群系染色/方块重力/IndexedDB/PWA/按键重绑定与手柄）、Biome 门禁、文档工程化。
- 统一版本号为 1.4.9，`check:version` 与全量回归通过。

### 修复
- 透明通道按距离排序、AABB 脱困（原 PR #7）
- 插件权限门禁补全、订阅归属、manifest 防篡改、级联停用（原 PR #5）

## [1.4.2] - 2026-11-15

### 新增
- 天空光 / 方块块双通道 BFS 传播、Greedy Meshing 光照通道（`test:light` 回归）
- Web Worker 网格化池（least-busy 派发，失败整体回退主线程）
- 8 相月贴图、双层星点异相闪烁
- 44 种方块（光源 / 建材 / 植物 / 羊毛）

## [1.4.1] - 2026-11-15

### 新增
- 35 种植物 / 树种方块（id 57~91，末位追加）
- 随机刻生态引擎 `Botany` 与植物内在能量系统（solar / hydro / fungal 代谢、
  根系共享、开花采集、发光地衣供能、蘑菇趋火枯萎）
- `test:botany`（28 组）与 `test:plant-energy`（29 组）回归

## [1.4.0] - 2026-11-14

### 新增
- 10 种方块（铜 / 绿宝石 / 青金石 / 红石矿石、黏土、灰化土、仙人掌、甘蔗、蕨、花岗岩）
- `DefaultGenerator` 重构为 `columns → ores → trees → decorate` 四阶段管线 +
  群系配置表 `BIOME_PROFILES`（配置驱动自然生成）
- `test:terrain-system`（20 组断言）
- 双轨版本体系（`RELEASE=v1` / `VERSION=1.4.0`）与 `check:version` 合并护栏

### 修复
- Worker 池构造失败整体回退；存档过期回调改写状态（seq 保护）
- 编辑差分数值分桶提速（-61% ~ -77%）

## [1.3.2] - 2026-11-14

### 修复
- 运行时注册方块后 Worker 配置不刷新
- 暂停 / 死亡期间按键卡住；菜单 → 方块库关闭后直接恢复游戏
- 入水后残留摔落伤害；Worker ACK 与 busy 计数泄漏

### 新增
- 运行时诊断组（`CraftAPI.diagnostics.run()`、F3 面板、10 秒自动采样）与 `test:diagnostics`

## [1.3.1] - 2026-11-14

### 新增
- 画面润色 4 项（天穹去色带、地平线霞光、体素云立体化、水下大气）
- 光照 + 18 新方块（id 27~44）+ 图集重绘 + 视觉回归移植
- MIT LICENSE

### 修复
- 天空光遮挡后不回收；重复放置同一方块白扣背包

## [1.3.0] - 2026-11-14

### 新增
- 服务化架构（`ServiceContainer` / `EventService` / `PluginService`，CraftAPI 薄门面）
- 区块网格化迁入 Web Worker 池 + Greedy Meshing（quad 数下降约 40%）
- 天空光 / 方块光双通道光照（0~15 级，顶点进 shader）
- 性能预算与移动端优化

## [1.2.0] - 2026-11-14

### 新增
- 事件与插件独立为服务层，插件热插拔、事件错误隔离
- 浏览器实景测试纳入 `npm run verify` 与 CI

### 修复
- 流式加载竞态与多项实测缺陷

## [1.1.2] - 2026-11-13

### 变更
- 地形生成重写（域扭曲、脊线山脉、温度 × 湿度群系、渐隐洞穴、分层矿脉、跨区块树木）

## [1.1.1] - 2026-11-13

### 修复
- 模式写回等审查修复项

## [1.1.0] - 2026-11-13

### 新增
- 生存模式（生命 / 饥饿 / 挖掘耗时 / 掉落背包 / 僵尸 / 死亡重生）
- 移动端性能与交互优化（动态分辨率、触控震动、大按钮布局）

---

[Unreleased]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.4.2...HEAD
[1.4.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/releases/tag/v1.4.2
[1.4.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.2...v1.4.2
[1.3.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/qwerrrtttyyy/minecraft-web-replica/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/qwerrrtttyyy/minecraft-web-replica/releases
