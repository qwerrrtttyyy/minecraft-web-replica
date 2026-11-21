# Minecraft TS —— TypeScript 体素引擎复刻

<p align="center">
  <img src="docs/assets/showcase.gif" width="720" alt="实机演示：清晨森林 → 挖掘 → 黄昏 TNT → 星空">
</p>

<p align="center">
  <a href="https://qwerrrtttyyy.github.io/minecraft-web-replica/">在线试玩</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a> ·
  <a href="docs/TESTING.md">测试</a> ·
  <a href="docs/HISTORY.md">演进实录</a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml"><img alt="verify CI" src="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/tags"><img alt="version" src="https://img.shields.io/github/v/tag/qwerrrtttyyy/minecraft-web-replica?label=version"></a>
  <img alt="TypeScript 5.6" src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white">
  <img alt="three.js 0.170" src="https://img.shields.io/badge/three.js-0.170-049ef4?logo=threedotjs&logoColor=white">
  <img alt="runtime deps: three.js only" src="https://img.shields.io/badge/runtime%20deps-three.js%20only-2ea44f">
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> 🤖 本项目完全由 AI 生成（源码 / 测试 / 文档），人类仅提出方向；生成方式与质量边界见「[关于本项目](#关于本项目)」。
> 📖 简体中文 | [English](README_EN.md)

一个依赖极轻的体素 Minecraft 复刻：运行时唯一依赖 **three.js**，其余全部手写——体素世界、
区块流式加载、带 AO 的贪心网格化、三通道光照 BFS、程序化像素纹理、昼夜天空、物理碰撞、
实体 AI、植物生态、合成与存档。构建产物是**单个自包含 HTML**，离线、`file://` 双击即玩；
所有纹理均代码逐像素绘制，不含任何原版资源。

当前正式版：v1 ｜ 当前非正式版：1.5.0（双轨版本号，唯一来源 [`src/core/version.ts`](src/core/version.ts)）

## 特性总览

- **体素引擎**：区块流式加载（背压暂停 + 自愈重入队），数据 / 天空光 / 方块光三通道网格，
  Worker 池上跑 Greedy Meshing（quad 数约降 40%）
- **光照**：天空光 + 方块光双通道 BFS（0–15 级），增量更新，烘焙进顶点属性（零额外 draw call）
- **地形**：四阶段管线 `columns → ores → trees → decorate`，域扭曲 + `ridged fBm` 山脊与河道，
  温度 × 湿度双轴群系（11 个：恶地 / 沼泥 / 干草原 / 樱花林增新），渐隐洞穴，分层矿脉，跨区块树冠
- **生存循环**：生命 / 饥饿 / 呼吸 / 挖掘硬度 / 掉落入包 / 敌对生物 / 死亡重生 / 3×3 合成
- **植物生态**：随机刻引擎 + 内在能量体系（solar / hydro / fungal 三类代谢、根系共享、开花反馈）
- **91+ 方块**：全部经 `BlockRegistry` 数据驱动注册，8×8 → 16×16 程序化图集（256 槽）
- **插件体系**：服务容器 + 命名空间事件 + 热插拔插件（js / wasm:module / wasm:host 三载体），
  `window.CraftAPI` 扩展门面
- **移动端**：虚拟摇杆、动态分辨率、震动反馈、safe-area 适配
- **工程化**：`npm run verify` 一条链完成版本一致性 → 类型检查 → 构建 → 全量回归 → 浏览器实景

**v1.5.0 实验性内容与 WASM 内核（预发布系列）**：新增**实验性内容开关**（设置页可开/关，默认关闭）——开启后启用真实 WebAssembly 计算内核（噪声批量计算，带逐位等价性自检与自动回退）与插件三载体（js / wasm:module / wasm:host）；关闭即回到纯 JS 路径。插件 API 契约版本 `2.1.0` 与项目版本解耦；扩展点注册表支持世界生成与游戏循环扩展。v1.4.9 的设置页 / 合成 / PWA / 脱困等能力全部保留。

**v1.4.9 整合发布**：统一版本并整合待合并改进（含插件体系强化、设置/选项页与导入导出、合成相关基础、体验优化与文档更新等）；具体细节见各 PR 与提交记录。

## 实验性内容

设置页提供两个实验分组，改动**即时生效并自动保存**，重启后从本地配置恢复。

### 分组一：实验性内容（引擎内核，v1.5.0）

提供 **WASM 内核 / 插件载体** 总开关，**默认关闭**：

- 关闭：地形噪声走纯 JS 路径，WASM 插件载体（wasm:module / wasm:host）拒绝启用；行为与 v1.4.9 完全一致。
- 开启：启用真实 WebAssembly 计算内核（带逐位等价性自检、失败自动回退）与三种插件载体、扩展点注册表。
- URL 参数 `?wasm=0` 可在实验性内容开启时强制关闭 WASM 后端（便于对照基准）。
- 实验性功能的状态与统计可通过 `CraftAPI.wasm.status()/stats()` 与 F3 面板查看。

### 分组二：实验性玩法（对齐原版 gamerule）

进一步还原原版设置体验，四个开关对应原版 `/gamerule` 语义：

| 设置项 | 原版对应 | 默认 | 关闭 / 效果 |
|---|---|---|---|
| 随机刻速度 | `/gamerule randomTickSpeed` | 标准 | 4 档（暂停 / 慢 / 标准 / 快），缩放植物随机刻采样数；「暂停」停止生长与扩散，恢复时不爆发 |
| 昼夜循环 | `/gamerule doDaylightCycle` | 开 | 关闭后时间与太阳定格在当前时刻，云和星空仍微动 |
| 死亡保留物品 | `/gamerule keepInventory` | 开 | 关闭后死亡清空背包（原版默认掉落行为）；默认开启保持本项目的友好设定 |
| 生物生成 | `/gamerule doMobSpawning` | 开 | 关闭后停止自动补刷生物，已存在个体按距离 / 日照自然清退 |
| 体素云层 | 渲染特性 | 开 | 关闭后隐藏云并跳过云几何重建（省电），重新开启时位置连续 |
| 方块重力 | 玩法特性 | 开 | 关闭后沙/砾石与悬空植物不再下落，方块保持原位 |
| 透明排序 | 渲染特性 | 开 | 关闭后透明通道退回固定顺序，可对照玻璃/水叠加穿帮效果 |

前四项对应原版 `/gamerule`，后三项是本项目已实现特性新增的对照开关。这些开关的即时状态可在 F3 调试面板观察到（生物数、植物能量、时间、透明排序条目等）。

## 版本轨道与预览版

- `vN`（如 `v1`、`v2`）是**正式里程碑**标签，只在里程碑发布时推进；
- `vX.Y.Z`（如 `v1.4.9`、`v1.5.0`）是**迭代版**标签，随日常迭代递增；
- 预发布版使用 SemVer 预发布标签：`1.5.0-alpha.1` → `1.5.0-beta.1` → `1.5.0-rc.1` → `1.5.0`。
  每个预览版都对应独立的 GitHub Prerelease 与完整 CI 验证。

## 版本规范

本项目采用**双轨版本号**，`src/core/version.ts` 是唯一来源：

| 轨道 | 格式 | 含义 | 出现位置 |
| --- | --- | --- | --- |
| 正式版 `RELEASE` | `vN`（`v1`、`v2`…） | 对外发布的里程碑，整数只增不减 | Git 标签 `vN`、F3 面板、`CraftAPI.release` |
| 非正式版 `VERSION` | `X.Y.Z`（`1.4.1`…） | 日常迭代，语义化版本 | `package.json`、`CraftAPI.version`、README |

规则：

- 日常提交只推进 `X.Y.Z`，`RELEASE` 保持不动；一个正式版可覆盖多个迭代版。
- 达到里程碑时由维护者把 `RELEASE` 推进到下一个 `vN`，并在该提交打同名轻量标签。
- 所有标签统一带 `v` 前缀：正式版里程碑为 `vN`（`v1`、`v2`…），历史迭代标签为 `vX.Y.Z`（`v1.3.0`、`v1.3.1`）。
- `npm run check:version` 机械校验双轨格式与一致性，并扫描 `src/**/*.ts` 禁止硬编码版本字面量。

**v1.5.0 生存模式合成系统**：新增可用的工作台合成界面（3×3 材料网格 + 结果槽 + 背包区 +
配方列表），生存模式下从暂停菜单「工作台」或**空手右键工作台方块**均可打开。内置最小闭环配方：
原木 → 木板、4 木板 → 工作台、4 沙 → 砂岩、4 圆石 → 石砖、2 木板 → 4 木棍（新增物品）。
新增 `test:crafting`（43 组）回归。

**v1.4.2 合并光照/天空增强**：合并 `trae/agent-9z2CVz` 分支——天空光/方块光双通道 BFS 传播、
44 种方块（光源/建材/植物/羊毛）、Greedy Meshing 光照通道、Web Worker 网格化池、
8 相月贴图、双层星点异相闪烁。`test:light` / `test:visual` 回归通过。

**v1.4.1 植物生态与能量体系**：追加 **35 种植物 / 树种方块**（id 57~91，仍为末位追加），
新增 **随机刻生态引擎** `Botany` 与 **植物内在能量系统**：植物靠光照 / 水体 / 阴暗蓄能，
能量决定生长、蔓延与开花；蓄满后开花（粒子反馈）、可采集花蜜，向日葵与发光地衣构成
根系供能枢纽，蘑菇在火光旁会枯萎、水生植物离水会枯死。新增 `test:botany`（28 组）与
`test:plant-energy`（29 组）回归。

**还原工程第 1 批**：天穹精修（8 相月贴图、双层星点异相闪烁、日月地平线大气放大与染色、
体素云扁平化、雾区间前移）、HUD 原版化（四臂镂空准星、凹陷物品槽、选中白框、状态图标描边）、
新增南瓜与书架两种方块（id 55、56，末位追加）。`test:visual` 增至 13 项、
`test:terrain-system` 增至 20 组。所有纹理仍为代码逐像素绘制，**不含任何原版资源**。

**v1.4.0 方块与地形体系整合**：追加 **10 种方块**（铜 / 绿宝石 / 青金石 / 红石矿石、黏土、
灰化土、仙人掌、甘蔗、蕨、花岗岩，id 45~54 仍为末位追加）；`DefaultGenerator` 重构为
`columns → ores → trees → decorate` 四个显式阶段 + **群系配置表** `BIOME_PROFILES`，
新方块全部由配置表驱动自然生成（浅海黏土、针叶林灰化土、沙漠仙人掌、临水甘蔗、高山绿宝石）。
新增 `test:terrain-system`（18 组断言），测试体系文档化见 [docs/TESTING.md](docs/TESTING.md)。

**v1.5.0 设置页**：新增独立 **Options 设置页**（标题屏「设置」/ 暂停菜单「设置」），
把原先挤在暂停菜单里的渲染距离 / 灵敏度 / FOV 收拢进去，并补上**音量**与**反转 Y 轴**；
新增 `core/options.ts` 作为设置的唯一权威来源，独立持久化到 localStorage（跨世界、跨存档），
旧存档内嵌 settings 仅作无本地配置时的兜底；音效引擎与输入层相应支持音量与 Y 轴反转，
`CraftAPI.settings` 扩展 `volume(v)` / `invertY(v)`。新增 `test:options`（24 项，含桌面 / 移动端 / 持久化）
并纳入 `npm run verify`。

**高级与开发者设置**：设置页拆出 **视频** 与 **开发者** 两组，新增 **画质档位**
（自动 / 高 / 均衡 / 省电，映射 `engine.setQualityScale()`，自动档仍交给自适应逐帧调整）、
**粒子效果**、**视角摇晃**、**自动跳跃**、**触控灵敏度**（仅移动端显示），开发者组含
**显示调试信息**（常显 F3 面板）、**Greedy 网格合并**、**网格化线程**（自动 / 主线程 / 1 / 2 / 4，
运行期重建 Worker 池，在途任务由主线程补算）、**自动保存间隔**（关闭 / 8 / 15 / 30 秒）与
**设置导入导出**（JSON 文本互拷，导入按已知字段过滤 + 规范化）。`ChunkManager` 新增
`setWorkerPoolSize()` / `recommendedPoolSize()`，Worker 池重建期间到达的网格请求改为先排队、
配置下发后补算，不再报「配置未就绪」。`CraftAPI.settings` 相应扩展 `quality` / `particles` /
`viewBob` / `autoJump` / `touchSensitivity` / `debugOverlay` / `greedy` / `mesherThreads` /
`autosaveInterval` / `exportOptions()` / `importOptions(json)`。`test:options` 增至 41 项
（桌面 / 移动端 / 高级项 / 开发者项 / 导入导出 / 跨会话持久化）。

**v1.1.0 新增**：完整可玩的**生存模式**（生命 / 饥饿 / 挖掘耗时 / 掉落背包 / 僵尸 / 死亡重生），
以及面向手机的**性能与交互优化**（动态分辨率、更低渲染距离与粒子预算、触控震动反馈与大按钮布局）。

**v1.3.0 渲染管线升级**：区块网格化整体迁入 **Web Worker 池**（`?worker&inline` Blob Worker，单文件
`file://` 下可直接运行；默认 `min(hardwareConcurrency - 1, 4)` 个 Worker、least-busy 派发，
构造或运行期任一 Worker 失败都整体回退主线程），并实现 **Greedy Meshing**——按面方向做 mask
贪心合并，quad 数下降约 40%，且保证「每个面格的贴图与亮度完全不变」。

**v1.3.0 光照升级**：移植**天空光 / 方块光**双通道（0~15），火把与南瓜灯能真正照亮洞穴；
光照随顶点进入 shader，昼夜与点光源不增加 draw call，Greedy 只在光照一致的面之间合并。

**v1.3.1 集成复核**：合并画面润色与光照 / 新方块 / 图集移植，并修掉移植带入的**天空光不回收**
与**重复放置白扣背包**两处真实缺陷；`test:visual` 视觉回归纳入 `npm run verify` 与 CI，
补上 MIT LICENSE。逐条改动见文末「v1.3.1 集成复核与修复记录」。

**v1.3.2 运行时诊断与生命周期修复**：修复运行时注册方块后 Worker 配置不刷新、暂停/死亡期间
按键卡住、菜单→方块库关闭后直接恢复游戏、入水后残留摔落伤害等缺陷；插件并发启用 / 初始化中
停用与 `EventChannel.waitFor` 清理补齐代次机制。新增 **运行时诊断组**
（`CraftAPI.diagnostics.run()`、F3 面板、每 10 秒自动采样）与 `test:diagnostics` 回归。
逐条改动见文末「v1.3.2 运行时诊断与修复记录」。

**v1.2.0 架构革新**：把**事件**与**插件**相关的 API 从 `main.ts` 中彻底独立为服务层
（`ServiceContainer` + `EventService` + `PluginService`），`CraftAPI` 退化为薄门面，
横切逻辑下沉为可启用/停用的一等公民插件；同时修复流式加载竞态与多项实测缺陷，
并把浏览器实景测试纳入 `npm run verify` 与 CI。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

> 非官方学习项目，与 Mojang / Microsoft 无关。所有纹理均为代码逐像素绘制，不含任何原版资源。

> **文档数字口径**：下文各版本「验证结果 / 实测」里的断言数、quad 数、耗时与体积均为
> **当时环境的历次记录**，只作演进留档；当前验收一律以 `npm run verify` 的输出与
> `test/artifacts/results.json` 为准，不要把旧数字当作阈值。

## 快速开始

**在线试玩（GitHub Pages）**：<https://qwerrrtttyyy.github.io/minecraft-web-replica/>

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 类型检查 + 单文件 dist/index.html
npm run verify   # 全量验收：版本 + 类型 + 构建 + 回归 + 浏览器实景
```

## 操作

| 按键 | 功能 |
| --- | --- |
| WASD / 空格 / Shift | 移动 / 跳跃（双击或 F 飞行，创造）/ 潜行 |
| 左键 / 右键 / 中键 | 破坏（按硬度计时）/ 放置、进食、采集 / 取样 |
| 滚轮 / 1-9 / E | 快捷栏 / 方块库 |
| F5 / F3 / F1 | 视角 / 调试面板 / 隐藏 HUD |
| Esc | 菜单 → 设置、工作台、按键重绑定 |

**设置页**：音效音量、FOV、渲染距离、灵敏度、画质档位、粒子、自动跳跃、触控灵敏度；
开发者组提供调试常显、Greedy 开关、网格化线程、自动保存间隔与设置导入导出。
选项原版风格双列排布（小屏单列），持久化于 `localStorage`；游戏内「关于」页
（标题屏 / 菜单 / 设置页入口）展示版本与项目信息。

## 架构

```
src/
├── core/       引擎内核：engine（渲染/调度）、types、version（★唯一版本源）
├── services/   ★ ServiceContainer / EventService（错误隔离、waitFor、stats）/ PluginService
├── api/        ★ CraftAPI 薄门面（plugins / events / settings / survival 命名空间）
├── plugins/    builtin 内置插件（autosave、hud-feedback）+ 示例
├── world/      地形 / 光照 / 网格化 / 植物生态 / 方块注册
├── gfx/  player/  entity/  input/  ui/  audio/  save/  diagnostics/
└── main.ts     ★ 组装根：建服务 → 注入 → 启插件 → 启动循环
```

依赖方向单向：`main.ts → services → api(类型) → 业务模块`；插件只依赖服务容器与
`PluginContext`。关键设计：

- **服务化扩展点**：事件与插件有身份、生命周期、依赖与权限，由 `ServiceContainer` 统一装配；
  停用插件自动撤销订阅并执行 teardown，`disable(A)` 级联停用下游依赖
- **权限白名单**：`world:write` / `player:write` / `save:write` / `blocks:register` 等未声明的
  写能力在插件上下文被拦截；读能力默认开放
- **数据驱动**：渲染 / 碰撞 / 音效 / 掉落只查 `BlockRegistry` 属性，不硬编码 id
- **烘焙光照**：面定向明暗 + 逐顶点 AO + 光照通道写入顶点属性，`MeshBasicMaterial` 无实时阴影
- **存档**：编辑差分（只记玩家改动，按 chunkKey 分桶）+ `validateSave()` 全量校验，坏档当作无存档

## 地形生成

`DefaultGenerator` 全部特征由「世界坐标 + seed」决定，区块生成顺序不影响结果。
四阶段管线 `TERRAIN_STAGES`（`columns → ores → trees → decorate`）：矿石只替换石头、
树木先于花草、装饰不覆盖树冠；地表 / 填充 / 装饰统一收进 `BIOME_PROFILES` 配置表。

- **域扭曲 + 脊线山脉 + 河道**：低频噪声扰动采样坐标；`ridged fBm` 生成山脊，`|n|≈0`
  等值线切出河谷，河谷按距海平面高度平滑淡出、不在海床拉沟
- **群系**：温度 × 湿度双轴 + 坡度决定 `ocean / beach / desert / plains / forest / taiga / alpine / mesa / swamp / savanna / cherry` 地表
  （恶地按 `strata` 彩色陶瓦层分层 + 红沙；沼泥地表 + 苔藓等高湿装饰；干草原草皮 + 金合欢伞形树；樱花林粉冠粉色树）
- **洞穴**：脊线隧道 + 团块洞穴双 3D 噪声，按距地表深度渐隐；水下地层不挖，杜绝空气袋
- **矿脉**：煤 / 铁 / 金 / 钻 / 铜 / 红石 / 青金石 / 绿宝石按深度分层，绿宝石逐格校验群系边界
- **跨区块树木**：6×6 候选点扫描，树冠裁剪写入覆盖区块，双向无「半棵树」
- **性能**：24×24 列信息缓存 + 网格差分坡度，实测 2~6 ms / 区块（Node 纯逻辑）

可调参数经构造第三参 `TerrainOptions` 注入（`warp` / `baseHeight` / `treeDensity` / `oreRichness` 等），
详见 `src/world/generator`。

## 光照与渲染

- 双通道光照（天空光 / 方块光，0–15）由主线程 `LightEngine` 维护：天空光按列初始化后只对
  影子边界做 BFS；方块光光源 14~15 级、逐格衰减、可跨区块；`World.setBlock` 增量更新并标记脏区块
- Greedy mask key 含光照档位——光照不同的面不合并，避免插值抹平火把照亮区
- Shader 顶点属性 `aLight = (sky, block)`，亮度 `max(sky × daylight, block)`；
  夜间天空光偏蓝、日出日落按太阳色染色；萤石 / 南瓜灯走 emissive 常亮
- 单区块光照初始化 3~6 ms，方块变化更新约 1 ms（Node 实测）

## 扩展 API

全部接口挂在 `window.CraftAPI`，控制台即可试玩（完整契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：

```js
CraftAPI.on('block:break', e => console.log(e));            // 事件
CraftAPI.registerTile('ruby_ore', (set, rng) => {...});      // 逐像素程序化纹理
CraftAPI.registerBlock({ name: 'ruby_ore', hardness: 3, tiles: {...} }); // 数据驱动方块，即刻进方块库
CraftAPI.registerEntity({ id: 'cow', build() {...} });       // 自定义实体
CraftAPI.setGenerator({ generateChunk(cx, cz, data) {...} }); // 替换地形（只影响未生成区块）
CraftAPI.player.teleport(0, 50, 0);
CraftAPI.save.setProvider({ load, save, clear });             // 云存档后端
CraftAPI.engine.addSystem({ update(dt) {...} });             // 每帧更新系统

// 插件：有 id / 版本 / 依赖 / 权限 / 生命周期
CraftAPI.plugins.register({
  manifest: { id: 'demo:mining-log', version: '1.0.0', permissions: ['api:emit'] },
  setup(ctx) { ctx.events.on('block:break', e => ctx.log(e.block)); },
});
await CraftAPI.plugins.enable('demo:mining-log');

// 生态扩展（需 botany:register 权限）：注册植物特性 + 随机刻规则
CraftAPI.botany.registerPlant('my_flower', { metabolism: 'solar', bloom: 80, growthCost: 18 });
CraftAPI.botany.registerRule({ id: 'me:rule', owner: 'me:my-pack', tick: (ctx) => false });
```

事件契约在 `src/services/events/GameEvents.ts`，支持 TypeScript 声明合并追加自定义事件。

## 测试

```bash
npm run verify   # 唯一验收入口，要求浏览器测试 100% PASS
```

| 命令 | 覆盖 |
|---|---|
| `test:logic` | 生存状态机 8 组 + 地形 23 组（含性能基准、旧方块 id 兼容） |
| `test:light` / `test:mesher` | 光照 21 组；网格快照保真、Greedy 光照逐格等价、quad 收益 |
| `test:services` / `test:diagnostics` | 服务容器 / 事件 / 插件 / 存档 38 项；运行时诊断 20 组 |
| `test:terrain-system` / `test:botany` / `test:plant-energy` | 方块 id append-only 校验、生态随机刻、能量体系 |
| `test:feel` | 跳跃输入缓冲 8 组（按下沿 / 120ms 窗口 / 消费 / 按住 / reset） |
| `test:crafting` | 配方表、有序 / 无序匹配、2×2 与 3×3 尺寸差异 43 组 |
| `test:wasm` / `test:plugin-v2` / `test:plugin-carrier` | WASM 自检回退、插件体系 v2、三载体 |
| `test:smoke` / `test:visual` | Chromium 实景 + 像素级视觉回归（Xvfb 软渲染） |

矩阵细节与固定种子规则见 [docs/TESTING.md](docs/TESTING.md)；benchmark 数字以
`test/artifacts/results.json` 实际输出为准。

## 版本规范

双轨版本号，唯一来源 `src/core/version.ts`（`check:version` 在 verify 中机械校验）：

- `vN`：正式里程碑（当前 `v1`），只在里程碑发布时推进并打同名 Git 标签
- `X.Y.Z`：迭代版（当前 `1.5.0`），日常迭代递增；预发布走
  `alpha.N → beta.N → rc.N → 正式`（如 `1.5.0-alpha.1`）

变更摘要见 [CHANGELOG.md](CHANGELOG.md)，v1.1.1 → v1.5.0 各版本演进实录见
[docs/HISTORY.md](docs/HISTORY.md)。

## 关于本项目

- **生成方式**：全部源码、测试与文档由 AI 编程代理生成，人类仅提出方向并合并；每次改动均经
  `npm run verify` 机械验收
- **质量边界**：测试覆盖核心逻辑与视觉回归，但未见过的边角行为仍可能出现；请勿用于生产环境
- 非官方学习项目，与 Mojang / Microsoft 无关；MIT License，欢迎 [参与贡献](CONTRIBUTING.md)

