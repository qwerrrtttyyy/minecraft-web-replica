# Minecraft TS —— TypeScript 体素引擎复刻

<p align="center">
  <img src="docs/assets/showcase.webp" width="720" alt="实机演示：清晨森林 → 挖掘 → 黄昏 TNT → 星空">
</p>

<p align="center">
  <b><a href="https://qwerrrtttyyy.github.io/minecraft-web-replica/">▶ 在线试玩</a></b>
  &nbsp;·&nbsp; <a href="#快速开始">本地运行</a>
  &nbsp;·&nbsp; <a href="docs/ARCHITECTURE.md">架构</a>
  &nbsp;·&nbsp; <a href="docs/TESTING.md">测试</a>
  &nbsp;·&nbsp; <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml"><img alt="verify CI" src="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/tags"><img alt="version" src="https://img.shields.io/github/v/tag/qwerrrtttyyy/minecraft-web-replica?label=version"></a>
  <img alt="TypeScript 5.6" src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white">
  <img alt="three.js 0.170" src="https://img.shields.io/badge/three.js-0.170-049ef4?logo=threedotjs&logoColor=white">
  <img alt="runtime deps: three.js only" src="https://img.shields.io/badge/runtime%20deps-three.js%20only-2ea44f">
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> 🤖 **本项目完全由 AI 生成**——全部源码、测试与文档均出自 AI 编程代理，人类仅提出方向。  
> ⚠️ **警告：项目处于激进改进阶段**——迭代极快，API、存档格式与游戏行为随时可能变动，请勿用于生产环境。  
> 📖 生成方式、审核边界与质量边界见 [「关于本项目（诚实说明）」](#关于本项目诚实说明)。

**简体中文** | [English](README_EN.md)

一个架构清晰、依赖极轻的前端 Minecraft 基础复刻。运行时唯一依赖为 **three.js**（渲染），
其余全部手写：体素世界、区块流式加载、带 AO 的网格生成、程序化像素纹理、昼夜天空、
物理碰撞、实体 AI、触控适配、存档与扩展 API。构建产物是**单个自包含 HTML**，
离线、无外部资源、`file://` 双击即可运行；所有纹理均为代码逐像素绘制，不含任何原版资源。

> 当前正式版：v1 ｜ 当前非正式版：1.6.0-beta.4（双轨版本号，规则见下方「版本规范」）

**v1.6.0-beta.4 高性能服务体系（预发布）**：主循环系统统一经 `FrameScheduler` 按阶段 / 优先级调度，软帧预算下让位 `background` 系统（带防饿死）并隔离系统级异常；`PerfService` 逐系统采样 p50 / p95，经 F3「性能」行与运行时诊断暴露热点。0 新方块 / 0 地形改动 / 0 新依赖（`src/services/perf/` 只依赖 `performance.now`）。详见 [CHANGELOG.md](CHANGELOG.md)。

> **更新历史**：本 README 只描述项目**当前状态**，不收录版本沿革；完整更新历史见 [CHANGELOG.md](CHANGELOG.md)。

> **当前进行中**：静态结构（村庄小屋 / 废弃矿井 / 地牢，第 5 生成阶段）已合入待发布；v2 路线图的护甲插件与联机协作草案继续推进。







## 实验性内容

设置页「实验性内容」分组提供 **WASM 内核 / 插件载体** 总开关，**默认关闭**：

- 关闭：地形噪声走纯 JS 路径，WASM 插件载体（wasm:module / wasm:host）拒绝启用。
- 开启：启用真实 WebAssembly 计算内核（带逐位等价性自检、失败自动回退）与三种插件载体、扩展点注册表。
- URL 参数 `?wasm=0` 可在实验性内容开启时强制关闭 WASM 后端（便于对照基准）。
- 实验性功能的状态与统计可通过 `CraftAPI.wasm.status()/stats()` 与 F3 面板查看。

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

> 非官方学习项目，与 Mojang / Microsoft 无关。所有纹理均为代码逐像素绘制，不含任何原版资源。

## 快速开始

**在线试玩（GitHub Pages）**：<https://qwerrrtttyyy.github.io/minecraft-web-replica/>

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 类型检查 + 构建为单文件 dist/index.html（可直接双击打开）
npm run lint     # Biome 代码质量门禁（构建 / CI 前置）
```

构建产物是**自包含的单文件 HTML**（three.js 已内联），无网络、无外部资源即可运行。

## 操作

| 按键 | 功能 |
| --- | --- |
| WASD / 方向键 | 移动 |
| 空格 | 跳跃 / 水中上浮 / 飞行上升 |
| 双击空格 或 F | 切换飞行（Shift 下降，仅创造模式可用） |
| Shift | 潜行 |
| Ctrl / 双击 W | 疾跑 |
| 鼠标左键（按住） | 破坏方块（按方块硬度计时，生存模式有进度条） |
| 鼠标右键 | 放置方块 / 手持食物时进食 / 空手采集蓄能植物 |
| 鼠标中键 | 取样准星方块 |
| 滚轮 / 1-9 | 切换快捷栏 |
| E | 方块库（全部注册方块，可搜索） |
| F5 | 第一 / 第三人称视角 |
| F3 | 调试面板 |
| F1 | 隐藏 HUD |
| Esc | 菜单（菜单里可进「设置」） |

**设置页**（标题屏「设置」链接 / 暂停菜单「设置」按钮）：音效开关与音量、视野 FOV、
渲染距离、视角灵敏度、反转 Y 轴，以及一键重置；**视频**组新增画质档位、粒子效果、视角摇晃，
**控制**组新增自动跳跃与触控灵敏度（仅移动端），**开发者**组提供调试信息常显、Greedy 网格合并、
网格化线程、自动保存间隔与设置导入导出。设置自动写入本机 localStorage，
换世界 / 删存档都不丢；游戏内核可用 `CraftAPI.settings.volume(v)` / `invertY(v)` /
`quality(v)` / `mesherThreads(v)` 等接口调整。

移动端：左下虚拟摇杆移动（推满疾跑），右侧空白处拖动转视角，
右下按钮为跳跃 / 破坏（长按持续挖）/ 放置（手持食物时变“进食”）/ 上升 / 下降，自带自动跳台阶。

玩法彩蛋：放置 **TNT** 后左键敲击点燃，1.6 秒后爆炸（可连锁，会波及玩家与生物）。

## 生存模式

标题页可选「生存 / 创造」，默认生存。生存模式把“挖—捡—吃—躲—死—重生”这一循环完整跑通：

| 系统 | 规则 |
| --- | --- |
| 生命 | 10 颗心 = 20 点。摔落（>3 格起算）、溺水、饥饿、僵尸攻击都会掉血；受伤有 0.32s 无敌帧并伴随红屏 + 音效 + 镜头抖动 |
| 饥饿 | 10 个鸡腿 = 20 点。移动 / 跳跃 / 挖掘累积消耗，耗尽后每 4 秒扣 1 点血；饥饿值 ≥18 且未满血时每 4 秒回 1 点血 |
| 呼吸 | 水下 15 秒氧气，耗尽后每秒扣 2 点血，浮出水面恢复 |
| 挖掘 | 每方块按 `硬度 × 1.1 秒` 计时，准星处显示进度条；半途松手保留 1 秒后清零；轻点一下只推进 0.3 秒（手机点按也能挖） |
| 掉落 | 方块与生物死亡都会掉落进背包，新获得的物品自动补进快捷栏空位；草→泥土、石→圆石、树叶 50% 掉自身 + 20% 掉苹果、玻璃/水/基岩/TNT 不掉、猪掉猪排 |
| 背包 | 快捷栏 9 格可堆叠，方块库只显示“已拥有的方块”，格子上标 xN；放置消耗、进食消耗 |
| 合成 | 3×3 材料网格 + 结果槽 + 背包区 + 配方列表；点背包物品放入选中格，点格子退回背包，点配方可自动摆放，点结果槽合成。材料取自生存背包，产物直接进背包 |
| 敌对生物 | 夜晚在玩家附近生成僵尸、骷髅、苦力怕（贴近自爆）、蜘蛛（更快、追击更远），白天会灼烧的仅在僵尸 / 骷髅 / 蜘蛛；追击距离 24~30 格，接触造成 2~3 点伤害、冷却 1.05 秒；创造模式左键秒杀，生存模式数下击杀。鱿鱼在水中悬浮游动，不攻击 |
| 死亡重生 | 生命归零 → 死亡界面（死因 + 重生 / 返回标题），重生回到出生点、满血满饥饿，**背包保留** |
| 存档 | v2 版存档记录模式、生存状态（生命/饥饿/氧气/背包）、快捷栏堆叠；旧 v1 存档自动升级并进入创造模式 |

食物：共 16 种可食物（`src/core/tuning.ts` 的 `FOOD_VALUES`，含苹果 / 猪排 / 熟肉 / 浆果 / 花蜜 / 蒜香米饭等），进食同时叠加饱和度。生存模式初始携带 2 个苹果 + 8 支火把；生存模式下飞行被禁用。

### 合成系统

生存模式新增可用的工作台界面。两个入口：**暂停菜单里的「工作台」按钮**，或**空手右键已放置的工作台方块**。
界面为 3×3 材料网格 + 右侧结果槽 + 底部背包区 + 配方列表：

- 点背包条目 → 把材料放进当前选中的格子（没选中就填第一个空格）
- 点已填的格子 → 材料退回背包
- 点配方条目 → 按图案自动摆好（材料不足会提示）
- 点结果槽 → 消耗材料合成，产物直接进背包

内置最小闭环配方（全部可放进 2×2，故不必先有工作台就能起步）：

| 配方 | 材料 | 产物 |
| --- | --- | --- |
| 木板 | 1 原木（橡木 / 白桦 / 云杉各一条） | 4 对应木板 |
| 工作台 | 4 木板（2×2，任一木板均可） | 1 工作台 |
| 砂岩 | 4 沙（2×2） | 1 砂岩 |
| 石砖 | 4 圆石（2×2） | 1 石砖 |
| 木棍 | 2 木板（竖排） | 4 木棍 |
| 切制砂岩 | 4 砂岩（2×2） | 4 切制砂岩 |
| 錾制砂岩 | 2 切制砂岩（无序） | 1 錾制砂岩 |
| 红砂岩 | 4 红沙（2×2） | 1 红砂岩 |
| 平滑砂岩 | 1 砂岩入熔炉烧炼 | 1 平滑砂岩 |
| 箭 | 燧石 + 木棍 + 羽毛（无序，2×2） | 4 箭 |
| 弓 | 3 线 + 2 木棍（3×3 工作台） | 1 弓 |

## 方块与美术

在原有 26 种基础方块之后追加的建材 / 光源 / 植物一批（id 27 起，全部末位追加，旧存档 `edits` 差分保持有效；当前内置方块共 **165** 种，最大 id 177）：

| 类别 | 方块 |
| --- | --- |
| 光源 | 火把（十字面，自发光 14）、南瓜灯（自发光 15） |
| 建材 | 石砖、苔石圆石、黑曜石（硬度 12）、沙砾、砂岩（含平滑 / 錾制 / 切制 / 红砂岩）、冰（半透明）、云杉木板、白桦木板、工作台（顶面 3×3 网格） |
| 植物 | 红蘑菇、棕蘑菇、枯灌木（十字面，需放在实心方块上） |
| 羊毛 | 橙、绿、紫、黑 |

美术优化：树叶改为 4×4 叶簇 + 边缘镂空，草方块 / 石头 / 水 / 砖块重绘，云层随昼夜压暗。
所有新方块都走 `BlockRegistry` 数据驱动注册：创造模式方块库（E）直接可见，生存模式可用
`CraftAPI.survival.give('obsidian')` 获取，破坏 / 放置 / 音效 / 掉落自动生效。

### 矿物与地表方块（id 45~54）

| 类别 | 方块 | 自然生成位置 |
| --- | --- | --- |
| 矿石 | 铜矿石、绿宝石矿石、青金石矿石、红石矿石 | 地下矿脉；绿宝石只在高山（alpine），逐格校验群系边界 |
| 地表 / 建材 | 黏土、灰化土、花岗岩、仙人掌 | 黏土在浅海海床；灰化土是针叶林地表；花岗岩为地下岩脉；仙人掌在沙漠沙面成列 1~3 格 |
| 植物 | 甘蔗、蕨 | 甘蔗在临水浅岸（1~2 格高）；蕨是草甸 / 森林 / 针叶林装饰 |

图集为 **16×16（256 槽）**，内置纹理 64 张，`registerTile()` 可继续扩展。
方块 id append-only，`test:terrain-system` 会机械校验既有 id 不变。

> 说明：天空光 / 方块光传播已在本版本接入 Worker + Greedy 管线（见下节）；逐方块色差
> （`colorVariance`）与 Greedy 合并天然冲突，留待后续用逐顶点色实现。

### 植物与生态（id 57~91）

| 类别 | 方块 | 自然生成 / 机制 |
| --- | --- | --- |
| 花卉 | 蓝铃花、绒球葱、蓝花美耳草、滨菊、矢车菊、铃兰、四色郁金香、向日葵、丁香、玫瑰丛、牡丹 | 草甸 / 森林 / 针叶林按权重装饰；邻近同类会向空地蔓延 |
| 地表植物 | 高蕨、藤蔓、苔藓地毯、发光地衣（自发光 7） | 高蕨进入森林 / 针叶林；藤蔓向下垂挂；地衣只在暗处扩散 |
| 水生 | 睡莲、海草、海带 | 海草 / 海带长在海床（海带成列长到水面）；睡莲在浅海表面铺开 |
| 作物 | 麦苗 → 抽穗 → 成熟小麦、甜浆果丛 → 成熟甜浆果丛、南瓜藤 | 随机刻推进阶段；南瓜藤在旁侧结南瓜；成熟后掉落种子 / 浆果 |
| 树与树苗 | 橡树 / 白桦 / 云杉树苗，白桦原木 / 树叶、云杉原木 / 树叶 | 森林混交橡树 + 白桦，针叶林 / 高山为云杉；树苗净空足够时长成对应树种 |

自然生成继续由 `BIOME_PROFILES` 驱动：新增 `trees`（树种权重）、`waterPlants` +
`waterPlantChance`（水下植物）、`lilyChance`、`pumpkinChance` 四类配置。
森林 / 针叶林树形由 `src/world/trees.ts` 统一构建，地形阶段与树苗生长共用同一份形状。

**随机刻生态引擎**（`src/world/botany.ts`）只采样玩家附近的已生成区块：每次随机刻
取若干「列 + 高度」，因此开销与采样次数成正比、不随世界规模增长。规则包括：

| 行为 | 规则 |
| --- | --- |
| 生长 | 甘蔗 / 仙人掌最高 3 格、竹子最高 8 格、海带最高 10 格；小麦三阶段；浆果成熟；树苗长树 |
| 蔓延 | 草方块 → 泥土、草方块长花草、花草 / 海草 / 睡莲 / 藤蔓 / 地衣 / 苔藓向邻格扩散、蘑菇只在暗处扩散 |
| 枯萎 | 支撑方块被拆后植物自动脱落；甘蔗 / 竹子 / 仙人掌 / 海带整列枯萎 |
| 事件 | 每次变化发出 `plant:grow`（`grow / spread / decay / ripen / harvest`），自动存档插件据此标记脏 |

#### 植物内在能量

每株植物有 0~100 的内在能量，能量来源与物种特性由
[`plantTraits.ts`](src/world/plantTraits.ts) 的数据表驱动，而不是统一的随机概率：

| 代谢类型 | 蓄能条件 | 典型物种 | 环境惩罚 |
| --- | --- | --- | --- |
| `solar` | 光照（天空光 × 昼夜 + 方块光）、脚下土壤 +2 | 花卉、草、作物、树苗、甘蔗、仙人掌 | 完全黑暗（天空光 <4 且方块光 <4）会饿死；夜间只衰减到 20 不下限 |
| `hydro` | 四邻水体或连续的上下水草列 | 海草、海带、睡莲 | 离水持续掉能并枯死 |
| `fungal` | 有效光照 < 8（夜晚 / 阴影 / 洞穴） | 蘑菇、发光地衣、苔藓 | 方块光 ≥13（火把旁）会被灼伤枯死；白天强光只压制能量不致死 |

- **生长门槛**：每次生长 / 蔓延先检查 `growthCost`，成功后才扣能量；能量不足时规则直接跳过。
  树苗需要蓄满 90 能量才会长成树，是整片生态里最高的门槛。
- **开花反馈**：达到物种 `bloom` 阈值时发出 `plant:bloom`，主循环在植物位置喷出彩色与金色两层粒子。
- **根系共享**：能量 ≥80 的植物会把富余能量送给同代谢类型的邻近植物（半径 2~4，单次 8~24）；
  向日葵（半径 4、单次 24）与发光地衣（半径 3、单次 16）是能量枢纽，负责把整片花园带起来。
- **采集收益**：蓄能开花的植物可用空手右键采集，或在破坏时结算——花卉产 `花蜜`（食物 3），
  向日葵产 2 份花蜜，成熟小麦额外掉 2 个种子，成熟浆果丛额外掉 2 颗甜浆果并退回未成熟状态。
  采集消耗 45 能量，不能连续刷取。
- **可观测**：F3 面板显示 `植物能量: N 株 / 开花 M / 均值 E`；能量是运行时生态状态，
  不写入存档（重新载入后从 32 初始储能开始重新蓄能）。

种子与浆果通过 `ITEMS[*].plant` 声明「右键种植方块」：小麦种子种麦苗、甜浆果种浆果丛，
生存模式消耗 1 个物品，创造模式无限。

### 植物杂交与品系

品系是挂在既有植物方块上的「数据层」（[`plantStrains.ts`](src/world/plantStrains.ts)），
不新增方块与物品注册，差异只体现在数值：生长耗能、开花阈值、采收产出、耐阴。
两株**成熟**植株水平相邻且命中组合表、满足条件（土壤养分 / 雨天）且附近有空位时，
随机刻小概率在空位长出带品系的后代：

| 组合 | 条件 | 后代品系 | 效果 |
| --- | --- | --- | --- |
| 小麦 × 小麦 | 两株脚下养分 ≥80 | 大穗小麦 | 慢熟（耗能 26），收获 4 份种子 |
| 小麦 × 甜浆果丛 | — | 莓穗 | 耐阴（光照门槛 9→6），收获额外 +1 甜浆果 |
| 甜浆果丛 × 葡萄藤 | — | 藤莓 | 早熟（bloom 68），收获 3 颗甜浆果 |
| 葡萄藤 × 葡萄藤 | 雨天 | 霜酿葡萄 | 生长耗能 26→20 |
| 小麦 × 葡萄藤 | — | 金穗小麦（隐藏） | bloom 70，收获额外 +1 花蜜 |

- **存档**：生态存档升级为 v2（追加 `strains` 表）；v1 旧档自动迁移为无品系，破坏植株品系即消失。
- **确定性**：杂交判定全部走 Botany 的确定性 rng，同种子同操作序列必然同结果。

## 光照系统

天空光 + 方块光双通道（0~15），由主线程 `LightEngine` 维护，区块加载与方块变化时增量更新：

| 项 | 内容 |
| --- | --- |
| 天空光 | 按列初始化（露天 15，水和树叶逐格衰减），只把影子边界与区块边界放入 BFS 队列做水平扩散；未加载区块按露天处理，世界边缘不发黑 |
| 方块光 | 火把 14、南瓜灯 / 萤石 15，每格衰减 1（水衰减 2），可跨区块传播；移除光源走「清空 + 边界重扩散」 |
| 增量更新 | `World.setBlock` 同步更新光照并标记受影响区块，Greedy 只重算脏区块 |
| 网格契约 | `MeshSnapshot` / `MeshSource` 增加 `sky` / `block`，Worker 侧不访问 `World` 也能取光 |
| Greedy | mask key 加入天空光 / 方块光档位：光照不同的面不合并，避免插值把「火把照亮的三格」拉成整面亮 |
| Shader | 顶点属性 `aShade`（面定向 × AO）+ `aLight = (sky, block)` + `aTileOrigin` + `aTint`（0 普通 / 1 群系染色 / 2 自发光），每顶点 44 B；亮度 `max(sky × daylight, block)`，最低 0.07 保留轮廓；夜间天空光偏蓝，日出 / 日落按太阳色染色 |
| 自发光 | 萤石 / 南瓜灯 / 火把（十字面）复用不透明通道，`aTint=2` 让 shader 跳过光照与染色、只保留面定向 × AO 明暗，不增加 draw call；`?emerge=0` 可切回并入前的独立 emissive 通道作对照 |
| 手持物 | 按眼睛所在格的天空光 / 方块光着色，进洞后会随火把变亮 |
| 出生点 | 优先露天、非沙滩 / 沙漠 / 海洋的陆地，避免一睁眼被树冠糊脸 |

性能：单区块光照初始化约 3~6 ms（Node 实测，已过滤无效边界种子），方块变化的光照更新约 1 ms；
`test/light-check.cjs` 用 14 组断言覆盖天空光列、方块光衰减、跨区块传播与增量回收。

## 移动端优化

- **动态分辨率**：`engine.setQualityScale()` 按帧率自动调整渲染缩放（低于 40fps 每步降 0.1，高于 58fps 每步升 0.05，下限 0.6），像素比上限 1.5，并监听 `visualViewport` 变化。
- **更省的默认预算**：渲染距离 3（桌面 5）、粒子池 380（桌面 800）、TNT 爆炸粒子 55、僵尸夜间上限 4。
- **触控体验**：按钮加大（`pointer:coarse` 媒体查询）、摇杆推满疾跑、破坏键长按持续挖、放置键随手持物切换为“进食”图标、关键操作（受伤/破坏/放置/死亡）触发 `navigator.vibrate` 震动反馈、`env(safe-area-inset-*)` 适配刘海与手势条、560px 与横屏 520px 两套紧凑布局。
- **交互修正**：拖动视角与按钮区域分离（右侧空白拖动），首次点击不会“只锁定指针不干活”。

## 架构

```
src/
├── core/                    引擎内核（不含业务横切逻辑）
│   ├── engine.ts            渲染器 / 场景 / 相机 / 系统调度 / 自适应尺寸
│   ├── types.ts             System 接口、常量、工具函数
│   ├── version.ts           ★ 全项目唯一版本来源
│   └── events.ts            兼容垫片：再导出 services/events（旧代码 / 测试快照用）
├── services/                ★ 服务层：插件与事件能力独立于此
│   ├── ServiceContainer.ts  类型安全服务注册表（provide/require/逆序 dispose）
│   ├── events/
│   │   ├── GameEvents.ts    事件契约表（支持声明合并扩展）
│   │   ├── EventService.ts  事件服务：错误隔离 / once / waitFor / onAny / stats / 深度保护
│   │   └── EventChannel.ts  命名空间订阅作用域（插件卸载即自动清理）
│   ├── plugins/
│   │   ├── PluginContext.ts manifest / permissions / PluginContext 契约
│   │   └── PluginService.ts 注册 / 依赖解析 / 权限裁剪 / 启停 / 生命周期事件
│   └── perf/
│       ├── FrameScheduler.ts 帧预算调度器：阶段 / 优先级 / 软预算 / 防饿死 / 异常隔离
│       └── PerfService.ts    逐系统耗时采样（p50 / p95），接入 F3 与运行时诊断
├── api/                     ★ 公开门面（薄适配层，旧 22 项能力签名不变）
│   ├── CraftAPI.ts          window.CraftAPI 实现 + plugins / events 命名空间
│   └── index.ts
├── plugins/
│   ├── builtin/             一等公民内置插件（默认启用）
│   │   ├── autosave.ts      存档脏标记追踪
│   │   ├── hudFeedback.ts   事件 → HUD / 音效 / 触感
│   │   └── deps.ts          内置插件依赖契约（TOKENS.BuiltinDeps）
│   └── example/welcome.ts   插件开发示例（默认不启用）
├── world/  gfx/  player/  entity/  input/  ui/  audio/  save/   业务模块
└── main.ts                  ★ 组装根：只做「建服务 → 注入 → 启插件 → 启动循环」
```

依赖方向单向：`main.ts → services → api(类型) → 业务模块`；插件只依赖服务容器与
`PluginContext`，不 import 引擎内部实现。

### 关键设计

- **服务化扩展点**：事件不再是散落的 `new EventBus()`，插件不再是一堆自由函数。
  两者都有身份、生命周期、依赖与权限，统一由 `ServiceContainer` 装配。
- **插件可热插拔**：`CraftAPI.plugins.register/enable/disable/unload`，停用自动撤销
  事件订阅、执行 teardown；初始化失败隔离为 `failed` 并发出 `plugin:error`。
- **事件错误隔离**：单个订阅者抛错不再中断同事件其他订阅者或整帧逻辑。
- **数据驱动**：方块全部经 `BlockRegistry` 注册，渲染 / 碰撞 / 音效 / 图标只查属性，不硬编码 id。
- **三通道网格**：不透明（含镂空植物 alphaTest，以及 `aTint=2` 的自发光方块）/ 半透明 / 水。
- **烘焙光照**：面定向明暗 + 逐顶点 AO 写入顶点色，世界用 `MeshBasicMaterial`，无实时阴影开销；
  天空光 / 方块光也随顶点传入 shader，昼夜与火把照明不增加 draw call。
- **流式加载背压 + 自愈**：dirty 积压超 24 暂停生成；视距内「已生成但无网格」的区块
  每帧自动重新入队；卸载按 `world.chunks` 遍历，杜绝幽灵区块与内存泄漏。
- **性能预算**：像素比封顶、每帧限时生成与网格化、编辑差分按 chunkKey 分桶、粒子单 draw call。
- **高性能服务体系**：主循环系统统一经 `FrameScheduler` 分阶段 / 优先级调度，支持软帧预算下
  让位 `background` 系统（带防饿死）与系统级异常隔离；`PerfService` 逐系统采样 p50 / p95，
  经 F3「性能」行与运行时诊断（`perf.counters` / `perf.systemErrors`）暴露热点。
- **运行时诊断**：`CraftAPI.diagnostics.run()` / F3 面板 / 每 10 秒自动采样，覆盖 Worker 配置 ACK、
  幽灵网格、插件依赖悬空、生存数值一致性、存档脏标记老化等不变量；高风险不变量配套注入式回归。
- **存档差分 + 全量校验**：只记录玩家改动；`validateSave()` 一次校验所有字段，坏档当作无存档。

## 地形生成

`DefaultGenerator` 的全部特征都由「世界坐标 + seed」决定，**区块生成顺序不影响结果**。

生成过程拆成固定五阶段 `columns → ores → trees → decorate → structures`
（`TERRAIN_STAGES`，实例 `gen.stageNames` 可读）：矿石只替换石头，树木先于花草，
装饰不覆盖树冠，`structures` 阶段按世界网格哈希放置村庄小屋 / 废弃矿井 / 地牢等静态结构
（跨区块确定性裁剪，Worker 逐位一致）。地表 / 填充 / 花草 / 浅滩黏土 / 仙人掌 / 甘蔗统一收进
`BIOME_PROFILES` 一张表，新增群系或地表方块不再散落在 `if` 分支里。

- **域扭曲**：先用低频噪声扰动采样坐标，消除值噪声的轴对齐方格感。
- **大陆 / 海洋 + 脊线山脉 + 河道**：大陆度控制海陆，`ridged fBm` 生成连续山脊，`|n|≈0` 等值线切出蜿蜒河谷；河谷按「距海平面高度」平滑淡出，在海岸自然收口，不会在海床上拉出深沟；高度范围约 4~66，海平面 30。
- **温度 × 湿度群系**：共 18 个（`ocean / beach / desert / plains / forest / taiga / alpine` 与竹林 / 白桦林 / 樱花林 / 黑森林 / 丛林 / 恶地 / 蘑菇洞窟 / 热带草原 / 积雪针叶林 / 积雪冻原 / 沼泽）。边界用噪声抖动打散；雪线、陡坡露石、沙滩与水下沙层由群系 + 坡度共同决定。
- **出生点保底陆地**：原点附近把低洼地形平滑抬到「海平面 + 3」，抬升半径带噪声扰动，岛岸不是正圆；40 个 seed 实测全部落在陆地。
- **渐隐洞穴**：脊线隧道 + 团块洞穴两种 3D 噪声，按「距地表深度」渐隐；**水下地层完全不挖**，避免形成被海水压住的空气袋（地表塌陷坑 / 水下空洞都已排除）。
- **分层矿脉**：煤（y≤52）/ 铁（≤40）/ 金（≤26）/ 钻石（≤16）/ 深层萤石晶洞；
  铜（≤50）/ 红石（≤22）/ 青金石（≤32）/ 花岗岩（≤44），绿宝石（≤42）只在高山且逐格校验群系边界。
  所有矿脉只替换石头，不会填回洞穴，统一受 `oreRichness` 控制。
- **群系地表与装饰**：针叶林地表为灰化土（掉泥土），高山为雪，沙滩 / 沙漠 / 海床为沙；
  浅海海床按概率铺黏土，沙漠沙面成列长仙人掌，临水浅岸长甘蔗，草甸 / 森林 / 针叶林按权重
  长草丛 / 虞美人 / 蒲公英 / 蕨。
- **跨区块树木**：按 6×6 世界格候选点扫描邻域，把树冠裁剪写入每个覆盖到的区块，±x 双向都不出现「半棵树」；树密度随群系变化，陡坡不长树。
- **性能**：每区块先算一次 24×24 列信息并缓存，坡度由网格差分得到；实测约 **2~6 ms / 区块**（Node，纯逻辑，随 seed 与机型浮动）。

可调参数（`TerrainOptions`，构造 `DefaultGenerator` 时第三参传入）：

```js
new DefaultGenerator(seed, registry, {
  warp: 26,            // 域扭曲强度，0 = 关闭
  baseHeight: 32,
  continentAmp: 19,
  hillAmp: 8,
  mountainLift: 16, mountainRidgeAmp: 27,
  riverDepth: 7,
  spawnUplift: 3, spawnRadius: 82,
  treeDensity: { plains: 0.08, forest: 0.42, taiga: 0.34 },
  oreRichness: 1,      // 0 关闭矿脉
});
```

> **旧存档提示**：地形算法变更后，旧存档的 `edits` 差分仍按坐标生效，但周围自然地形会变；载入时会自动把玩家抬到新地形之上，避免卡在方块里。

## 生态扩展点与插件

`CraftAPI.botany` 是插件专用的生态扩展面，写操作需要 `botany:register` 权限
（读操作 `listRules()` / `stats()` 始终可用）：

```js
// 注册一株插件植物：先注册纹理 / 方块，再登记特性与规则
CraftAPI.registerTile('my_flower', (set) => { /* 逐像素绘制 */ });
CraftAPI.registerBlock({ name: 'my_flower', /* ... */ });
CraftAPI.botany.registerPlant('my_flower', {
  metabolism: 'solar', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12,
});
CraftAPI.botany.registerRule({
  id: 'me:my-pack:rule', owner: 'me:my-pack', plants: ['my_flower'],
  priority: 0, // 可选：按 (priority, id) 双键稳定排序，越小越先执行
  tick: (ctx) => {
    // 读环境：ctx.day() / season() / weather() / soil(x,y,z)
    // 写土壤：ctx.enrichSoil(x,y,z,delta)；生长仍走 ctx.grow / boost / write
    return false;
  },
});
CraftAPI.botany.unregisterRules('me:my-pack'); // 停用插件时整体注销
```

`Botany` 只在内置规则全部未命中时按方块 id 兜底分派插件规则，因此扩展不会
改变任何既有生态行为。内置插件 `core:botany-expansion` 就是用这套接口注册了
6 种植物（id 92~97）与 4 条规则（含雨天补能演示），并订阅 `chunk:generated` 按群系补种。
控制台可用 `CraftAPI.plugins.disable('core:botany-expansion')` 验证停用后规则立即失效。

## 扩展 API（为未来预留的接口）

所有接口挂在 `window.CraftAPI`，控制台即可试玩：

```js
// 1. 监听事件
CraftAPI.on('block:break', e => console.log('破坏了', e));

// 2. 注册自定义纹理 + 方块
CraftAPI.registerTile('ruby_ore', (set, rng) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = 120 + rng() * 20;
    set(x, y, (v << 16) | (v << 8) | v);           // 石头底
  }
  for (let i = 0; i < 6; i++) set(2 + (rng()*12|0), 2 + (rng()*12|0), 0xe0356a); // 红宝石
});
CraftAPI.registerBlock({
  name: 'ruby_ore', label: '红宝石矿', shape: 'cube',
  solid: true, opaque: true, liquid: false, transparentPass: false,
  lightEmission: 0, hardness: 3, sound: 'stone',
  tiles: { top: 'ruby_ore', bottom: 'ruby_ore', side: 'ruby_ore' },
});
// 新方块立即出现在方块库（E）中

// 3. 注册新实体
CraftAPI.registerEntity({
  id: 'cow', label: '牛', width: 0.9, height: 1.3, speed: 0.9,
  build() { /* 返回 { group: THREE.Group, animate(phase, moving) } */ },
});
CraftAPI.entities.spawn('pig', 5, 40, 5);

// 4. 替换地形生成器（只影响未生成区块）
CraftAPI.setGenerator({ seed: 1, generateChunk(cx, cz, data) {...}, surfaceHeight(x, z) {...} });

// 5. 世界 / 玩家 / 时间脚本
CraftAPI.world.biomeAt(120, -40);    // 群系 id，共 18 个，见 BIOME_PROFILES
CraftAPI.world.terrain(120, -40);    // { x, z, height, biome, temperature, humidity, slope }
CraftAPI.world.setBlock(0, 45, 0, CraftAPI.blocks.byNameGet('glowstone').id);
CraftAPI.player.teleport(0, 50, 0);
CraftAPI.player.setFly(true);
CraftAPI.time.set(0.75);            // 日落
CraftAPI.time.setDayLength(120);    // 2 分钟一天
CraftAPI.tnt.ignite(2, 40, 2);

// 6. 替换存档后端（云存档 / IndexedDB）
CraftAPI.save.setProvider({ async load(){...}, async save(d){...}, async clear(){...} });
const data = CraftAPI.save.export();

// 7. 生存模式
CraftAPI.survival.mode();                   // 'survival' | 'creative'（函数）
CraftAPI.survival.setMode('survival');      // 切换模式
CraftAPI.survival.damage(4, '测试');         // 扣血，带无敌帧
CraftAPI.survival.heal(4);
CraftAPI.survival.give('apple', 3);         // 给物品（'apple' / 'porkchop' / 'cobblestone' ...）
CraftAPI.survival.count('apple');
CraftAPI.survival.inventory();              // [{ key, count }]
CraftAPI.survival.respawn();
CraftAPI.player.breakBlock();               // 直接破坏准星方块（走掉落与背包）

// 8. 挂入自定义更新系统
CraftAPI.engine.addSystem({ update(dt, t) { /* 每帧调用 */ } });
```

事件契约位于 `src/services/events/GameEvents.ts`（`src/core/events.ts` 保留兼容再导出）。
除原有玩法事件外，还有 `chunk:unloaded` / `stream:backpressure` / `service:ready` /
`plugin:registered` / `plugin:enabled` / `plugin:disabled` / `plugin:error`，
并支持用 TypeScript 声明合并追加自定义事件类型。

### 插件与事件服务

`CraftAPI` 之上新增两组服务入口（旧 22 项能力签名完全不变）：

```js
// 1) 插件：有 id / 版本 / 依赖 / 权限 / 生命周期，可热插拔
CraftAPI.plugins.register({
  manifest: {
    id: 'demo:mining-log', version: '1.0.0',
    permissions: ['api:emit'], dependencies: [],
  },
  setup(ctx) {
    // ctx.events 是命名空间通道，停用插件时订阅自动撤销
    ctx.events.on('block:break', (e) => ctx.log('破坏方块', e.block));
    ctx.onDispose(() => ctx.log('已停用'));
    return () => ctx.log('teardown');   // 也可直接返回清理函数
  },
});
await CraftAPI.plugins.enable('demo:mining-log');
CraftAPI.plugins.list();                    // [{ manifest, state: 'enabled' }]
CraftAPI.plugins.disable('demo:mining-log');
CraftAPI.plugins.unload('demo:mining-log');

// 2) 事件服务：异步等待 / 全局观测 / 派发统计 / 作用域订阅
await CraftAPI.events.waitFor('chunk:meshed', 3000);
const off = CraftAPI.events.onAny((type, payload) => console.log(type, payload));
CraftAPI.events.stats();                    // { emitted, subscribers, channels }
CraftAPI.events.scope('demo:ns');           // 返回 EventChannel，dispose() 一键清理
```

权限白名单 `world:write` / `player:write` / `save:write` / `api:emit` / `blocks:register` /
`time:write` / `settings:write` / `plugins:manage`：
未声明的写能力在插件上下文里会被拦截并抛错，读能力默认开放。
`api:emit` 同时约束 `ctx.events.emit` 与 `api.events.scope(...).emit`；
`api.on / off` 与 `api.events.waitFor / onAny` 都归属插件通道，停用时一并清理。
`disable(A)` 会级联停用依赖 A 的下游插件。
内置插件 `core:autosave`、`core:hud-feedback` 就是用同一套契约实现的，见
`src/plugins/builtin/`。完整契约与迁移路径见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 已预留的未来方向

- **光照**：天空光 / 方块光已落地（`src/world/light.ts`），平滑光照（逐角点取空气侧 4 格均值）已落地；后续可扩展彩色光源。
- 合成 / 工具耐久 / 护甲 / 更多怪物：生存循环已跑通，可在 `src/player/survival.ts` 与
  `src/world/blocks.ts` 的 `drops` 字段上继续叠加（见 `CraftAPI.survival`）。
- 更多生物群系 / 结构：实现 `IWorldGenerator` 即可整体替换。
- 多人联机：世界读写集中在 `World`，编辑差分天然是同步消息格式。
- 纹理包：`registerTile` 可运行时重绘图集，注册后自动刷新 Worker 配置。
- **Worker 网格化已落地**（Worker 池 + Greedy）；后续可做跨区块网格缓存或 GPU 侧合并。

## 测试

一条命令完成全量核验（版本一致性 → 类型检查 → 构建 → 重建测试快照 → 纯逻辑回归 → 光照回归 → 浏览器实景）。
测试体系、固定种子与新增测试的规则见 [docs/TESTING.md](docs/TESTING.md)。

```bash
npm run verify
```

| 命令 | 内容 |
|---|---|
| `npm run check:version` | `package.json` / `version.ts` 一致 + README 含当前版本 + 源码唯一版本源扫描 |
| `npm run typecheck` / `build` | TypeScript strict + 单文件 `dist/index.html` |
| `npm run lint` | Biome 静态检查（recommended 规则集，91 文件 ≈100ms）；`lint:fix` 自动修复 |
| `npm run check` / `check:fix` | lint + format + import 排序一站式；`format` 仅格式化（可选） |
| `npm run test:snapshot` | **从当前 TS 源码现场编译** `test/logic` / `test/terrain-logic`，杜绝手工同步漂移 |
| `npm run test:logic` | 生存状态机 9 组 + 地形基础 23 组 + 篮球弹跳 / 拾取 76 项 |
| `npm run test:vitest` | Vitest 全量（直接消费 `src` TS）：fire / warmth / campfire / survival-saturation / ai / logic / terrain / crafting / jei |
| `npm run test:light` | 天空光 / 方块光 21 项 |
| `npm run test:mesher` | 网格快照保真、Greedy 面覆盖与光照逐格等价、quad 下降比例、slab / candle 盒几何、N4 未知来源液面 |
| `npm run test:perf` | 火焰系统每拍成本守卫（`fireSpread` 开 / 关对照，超 5 ms/拍即失败） |
| `npm run test:services` | 服务容器 / 事件 / 插件 / 存档 59 项 |
| `npm run test:diagnostics` | 运行时诊断 48 组（健康快照 + 异常注入，含摄影相机归属 / 性能服务快照） |
| `npm run test:perf-services` | 高性能服务体系纯逻辑 32 项：采样分位数 / 报告排序 + 调度器阶段·优先级·软预算·防饿死·异常隔离 |
| `npm run test:worker-pool` | Worker 池构造失败整体回退的注入式回归 |
| `npm run test:edits` | 编辑差分数值分桶：负坐标 / 跨区块边界 / 覆盖 / 存档导出 |
| `npm run test:terrain-system` | 方块扩充（id 45~147 + 火光地基 174~177，总数 165）、`TERRAIN_STAGES` 顺序、`BIOME_PROFILES` 18 群系、104 组 |
| `npm run test:botany` | 植物随机刻：生长 / 蔓延 / 枯萎 / 树苗长树 / 攀爬 / 发光植物 34 组 |
| `npm run test:plant-energy` | 植物内在能量：代谢 / 蓄能 / 开花 / 采集 / 根系共享 54 组 |
| `npm run test:crafting` | 合成系统 99 项：配方表 / 有序与无序匹配 / 偏移摆放 / 材料组 / 背包取放闭环 |
| `npm run test:smelting` | 远端熔炉烧炼纯逻辑 35 项（配方 / 燃料 / `putFuelFrom` / tick / 序列化） |
| `npm run test:smoke` | Chromium 实景（桌面 + 移动端），产物写 `test/artifacts/` |
| `npm run test:photo` | 摄影模式纯逻辑与源码契约 50 项：FOV / 时刻 / 天气 / 相机边界 / 元数据 / 伪 pause 来源 / 移动端入口 |
| `npm run test:experiments3d` | 3D 实验 23 项：密度地形 / 8 位光照打包 / 材质包路径·首帧·ZIP 过滤上限（独立入口，先重建快照） |
| `npm run test:jei:vitest` | JEI 只读索引 10 项（倒排表 / 材料组展开 / 搜索）；独立入口，暂未挂 `verify` |
| `npm run test:mobile` | 移动端组合：mesher + 旋转引导 + 手感 + 裂纹覆盖层 |
| `npm run test:visual` | 像素级视觉回归：昼夜 / 火光 / 方块墙 / 天穹 |

Linux 无 GPU 环境用软件渲染跑实景（需要 `--disable-gpu-sandbox` 与 `--enable-unsafe-swiftshader` 两个 flag）：

```bash
CHROME_PATH=/usr/bin/chromium MC_HEADLESS=0 MC_GL=desktop \
  xvfb-run -a -s "-screen 0 1280x760x24" npm run verify
```

`.github/workflows/verify.yml` 按此配置接入 CI，要求浏览器测试 **100% PASS**。
断言总数与 benchmark 数字以 `test/artifacts/results.json` 实际输出为准；下文各版本记录里的
具体数字只代表当时环境，不应作为当前验收口径。

覆盖：模式选择、血量/鸡腿/氧气 HUD、挖掘进度与掉落入包补位、放置与消耗、伤害与死亡重生、
进食、夜间僵尸生成与攻击、模式切换、存档 v2 与继续游戏、移动端摇杆/长按挖掘/按钮语义/安全区布局；
另覆盖版本一致性、服务容器注册、内置插件启用、事件派发统计、插件热注册/停用清理，
以及传送后「流式加载队列收敛且生成的区块都有网格」的轮询断言（取代固定 sleep）；
还包括网格化确实跑在 Worker、Greedy 生效且有合并收益，以及 `?mesher=main&greedy=0`
的**降级路径仍能正常出网格**（Worker 在受限环境创建失败时的兜底）。

## 技术栈

- TypeScript 5.6（strict）
- three.js 0.170（唯一运行时依赖）
- Vite 5 + vite-plugin-singlefile（构建为单文件 HTML）



## 关于本项目（诚实说明）

### 生成方式

本项目——包括**全部源码、测试、构建脚本、CI 配置与文档**——**完全由 AI 生成**。
人类维护者的角色仅限于提出方向、拆分任务与决定何时合并，不进行逐行人工编写。

### 关于自动化审核与本文档的改进

- 仓库此前的测试体系、CI 全绿结果、诊断组与「工程化」承诺，**同样是 AI 产出的一部分**，
  不构成人工代码审计。测试通过只证明既有断言未被违反，不等于没有缺陷。
- 本文档此前的**工程化改进**（贡献指南、Issue/PR 模板、CHANGELOG、徽章、英文版、
  「参与贡献」区块）与本节的诚实说明，**也由 AI 分析生成**——包括对项目历史提交、
  PR 记录与代码质量的审核结论，均来自 AI，请以审慎态度对待。

### 质量边界

- **激进改进阶段**：接口、存档格式与玩法仍在快速演进，破坏性变更是常态，
  请勿将本项目作为依赖或用于生产。
- **已知限制**：透明通道未按距离排序、15 级硬边光照、缺少 AABB 脱困、
  软件渲染约 10 FPS；部分子系统仅有 AI 编写的测试覆盖。
- **最好的验证方式不是相信本文件，而是亲手跑 `npm run verify` 或打开
  [在线试玩](https://qwerrrtttyyy.github.io/minecraft-web-replica/) 实际体验**，
  并以 Issue / PR 指出问题——外部反馈比任何 AI 自评都可靠。

## 参与贡献

欢迎任何形式的贡献——报告缺陷、提议功能、改进文档或提交代码。
请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中包含动代码前必读的**硬规则清单**
（方块 id 只追加、PR 不动版本号、Worker 数据纯度等，源自
[docs/PROJECT-EXPERIENCE.md](docs/PROJECT-EXPERIENCE.md)）。

- 🐛 [报告缺陷](../../issues/new?template=bug_report.yml) · [提议功能](../../issues/new?template=feature_request.yml)
- 📜 [更新日志](CHANGELOG.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全策略](SECURITY.md)
- 🔒 发现安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，**不要**公开提 Issue

AI 辅助的贡献同样欢迎：请由提交者逐行核验、如实标注 `Co-authored-by`，并对照硬规则自查。

内容由 AI 生成