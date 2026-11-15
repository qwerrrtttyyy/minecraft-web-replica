# Minecraft TS —— TypeScript 体素引擎复刻

一个架构清晰、依赖极轻的前端 Minecraft 基础复刻。运行时唯一依赖为 **three.js**（渲染），
其余全部手写：体素世界、区块流式加载、带 AO 的网格生成、程序化像素纹理、昼夜天空、
物理碰撞、实体 AI、触控适配、存档与扩展 API。

> 当前正式版：v1 ｜ 当前非正式版：1.4.2（双轨版本号，规则见下方「版本规范」）

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
npm run build    # 类型检查 + 构建为单文件 dist/index.html（可直接双击打开）
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
| Esc | 菜单 |

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
| 敌对生物 | 夜晚在玩家附近生成僵尸（绿皮、双臂前伸、白天会燃烧），追击距离 26 格，接触造成 3 点伤害、冷却 1.05 秒；创造模式左键秒杀，生存模式 3 下击杀 |
| 死亡重生 | 生命归零 → 死亡界面（死因 + 重生 / 返回标题），重生回到出生点、满血满饥饿，**背包保留** |
| 存档 | v2 版存档记录模式、生存状态（生命/饥饿/氧气/背包）、快捷栏堆叠；旧 v1 存档自动升级并进入创造模式 |

食物：苹果（+4 饥饿）、猪排（+6 饥饿）。生存模式初始携带 2 个苹果 + 8 支火把；生存模式下飞行被禁用。

## 方块扩充与美术（v1.3.0 移植）

在原有 26 种方块之后追加 **18 种**（id 27 起，全部末尾追加，旧存档 `edits` 差分保持有效）：

| 类别 | 方块 |
| --- | --- |
| 光源 | 火把（十字面，自发光 14）、南瓜灯（自发光 15） |
| 建材 | 石砖、苔石圆石、黑曜石（硬度 12）、沙砾、砂岩、冰（半透明）、云杉木板、白桦木板、工作台（顶面 3×3 网格） |
| 植物 | 红蘑菇、棕蘑菇、枯灌木（十字面，需放在实心方块上） |
| 羊毛 | 橙、绿、紫、黑 |

美术优化：树叶改为 4×4 叶簇 + 边缘镂空，草方块 / 石头 / 水 / 砖块重绘，云层随昼夜压暗。
所有新方块都走 `BlockRegistry` 数据驱动注册：创造模式方块库（E）直接可见，生存模式可用
`CraftAPI.survival.give('obsidian')` 获取，破坏 / 放置 / 音效 / 掉落自动生效。

### v1.4.0 再追加 10 种方块（id 45~54）

| 类别 | 方块 | 自然生成位置 |
| --- | --- | --- |
| 矿石 | 铜矿石、绿宝石矿石、青金石矿石、红石矿石 | 地下矿脉；绿宝石只在高山（alpine），逐格校验群系边界 |
| 地表 / 建材 | 黏土、灰化土、花岗岩、仙人掌 | 黏土在浅海海床；灰化土是针叶林地表；花岗岩为地下岩脉；仙人掌在沙漠沙面成列 1~3 格 |
| 植物 | 甘蔗、蕨 | 甘蔗在临水浅岸（1~2 格高）；蕨是草甸 / 森林 / 针叶林装饰 |

图集从 8×8 扩到 **16×16（256 槽）**，内置纹理 64 张后仍可继续 `registerTile()`。
方块 id 继续 append-only，`test:terrain-system` 会机械校验 45~54 与旧 id 44 不变。

> 说明：天空光 / 方块光传播已在本版本接入 Worker + Greedy 管线（见下节）；逐方块色差
> （`colorVariance`）与 Greedy 合并天然冲突，留待后续用逐顶点色实现。

### v1.4.1 植物大扩充与能量体系（id 57~91）

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

#### 植物内在能量（v1.4.1）

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

## 光照系统（v1.3.0 移植）

天空光 + 方块光双通道（0~15），由主线程 `LightEngine` 维护，区块加载与方块变化时增量更新：

| 项 | 内容 |
| --- | --- |
| 天空光 | 按列初始化（露天 15，水和树叶逐格衰减），只把影子边界与区块边界放入 BFS 队列做水平扩散；未加载区块按露天处理，世界边缘不发黑 |
| 方块光 | 火把 14、南瓜灯 / 萤石 15，每格衰减 1（水衰减 2），可跨区块传播；移除光源走「清空 + 边界重扩散」 |
| 增量更新 | `World.setBlock` 同步更新光照并标记受影响区块，Greedy 只重算脏区块 |
| 网格契约 | `MeshSnapshot` / `MeshSource` 增加 `sky` / `block`，Worker 侧不访问 `World` 也能取光 |
| Greedy | mask key 加入天空光 / 方块光档位：光照不同的面不合并，避免插值把「火把照亮的三格」拉成整面亮 |
| Shader | 顶点属性 `aLight = (sky, block)`；亮度 `max(sky × daylight, block)`，最低 0.07 保留轮廓；夜间天空光偏蓝，日出 / 日落按太阳色染色 |
| 自发光 | 萤石 / 南瓜灯走 emissive 通道常亮；火把为十字面，同样不受昼夜影响 |
| 手持物 | 按眼睛所在格的天空光 / 方块光着色，进洞后会随火把变亮 |
| 出生点 | 优先露天、非沙滩 / 沙漠 / 海洋的陆地，避免一睁眼被树冠糊脸 |

性能：单区块光照初始化约 3~6 ms（Node 实测，已过滤无效边界种子），方块变化的光照更新约 1 ms；
`test/light-check.cjs` 用 14 组断言覆盖天空光列、方块光衰减、跨区块传播与增量回收。

## 移动端优化

- **动态分辨率**：`engine.setQualityScale()` 按帧率自动调整渲染缩放（低于 40fps 每步降 0.1，高于 58fps 每步升 0.05，下限 0.6），像素比上限 1.5，并监听 `visualViewport` 变化。
- **更省的默认预算**：渲染距离 3（桌面 5）、粒子池 380（桌面 800）、TNT 爆炸粒子 55、僵尸夜间上限 4。
- **触控体验**：按钮加大（`pointer:coarse` 媒体查询）、摇杆推满疾跑、破坏键长按持续挖、放置键随手持物切换为“进食”图标、关键操作（受伤/破坏/放置/死亡）触发 `navigator.vibrate` 震动反馈、`env(safe-area-inset-*)` 适配刘海与手势条、560px 与横屏 520px 两套紧凑布局。
- **交互修正**：拖动视角与按钮区域分离（右侧空白拖动），首次点击不会“只锁定指针不干活”。

## 架构（v1.3.0）

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
│   └── plugins/
│       ├── PluginContext.ts manifest / permissions / PluginContext 契约
│       └── PluginService.ts 注册 / 依赖解析 / 权限裁剪 / 启停 / 生命周期事件
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
- **三通道网格**：不透明（含镂空植物，alphaTest）/ 自发光 / 半透明（水、玻璃）。
- **烘焙光照**：面定向明暗 + 逐顶点 AO 写入顶点色，世界用 `MeshBasicMaterial`，无实时阴影开销；
  天空光 / 方块光也随顶点传入 shader，昼夜与火把照明不增加 draw call。
- **流式加载背压 + 自愈**：dirty 积压超 24 暂停生成；视距内「已生成但无网格」的区块
  每帧自动重新入队；卸载按 `world.chunks` 遍历，杜绝幽灵区块与内存泄漏。
- **性能预算**：像素比封顶、每帧限时生成与网格化、编辑差分按 chunkKey 分桶、粒子单 draw call。
- **存档差分 + 全量校验**：只记录玩家改动；`validateSave()` 一次校验所有字段，坏档当作无存档。

## 地形生成（v1.1.2，v1.4.0 整合为阶段管线）

`DefaultGenerator` 的全部特征都由「世界坐标 + seed」决定，**区块生成顺序不影响结果**。

v1.4.0 起生成过程拆成固定四阶段 `columns → ores → trees → decorate`
（`TERRAIN_STAGES`，实例 `gen.stageNames` 可读）：矿石只替换石头，树木先于花草，
装饰不覆盖树冠。地表 / 填充 / 花草 / 浅滩黏土 / 仙人掌 / 甘蔗统一收进
`BIOME_PROFILES` 一张表，新增群系或地表方块不再散落在 `if` 分支里。

- **域扭曲**：先用低频噪声扰动采样坐标，消除值噪声的轴对齐方格感。
- **大陆 / 海洋 + 脊线山脉 + 河道**：大陆度控制海陆，`ridged fBm` 生成连续山脊，`|n|≈0` 等值线切出蜿蜒河谷；河谷按「距海平面高度」平滑淡出，在海岸自然收口，不会在海床上拉出深沟；高度范围约 4~66，海平面 30。
- **温度 × 湿度群系**：`ocean / beach / desert / plains / forest / taiga / alpine`。边界用噪声抖动打散；雪线、陡坡露石、沙滩与水下沙层由群系 + 坡度共同决定。
- **出生点保底陆地**：原点附近把低洼地形平滑抬到「海平面 + 3」，抬升半径带噪声扰动，岛岸不是正圆；40 个 seed 实测全部落在陆地。
- **渐隐洞穴**：脊线隧道 + 团块洞穴两种 3D 噪声，按「距地表深度」渐隐；**水下地层完全不挖**，避免形成被海水压住的空气袋（地表塌陷坑 / 水下空洞都已排除）。
- **分层矿脉**：煤（y≤52）/ 铁（≤40）/ 金（≤26）/ 钻石（≤16）/ 深层萤石晶洞；v1.4.0 增加
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

> **旧存档提示**：地形算法变更后，v1.1.1 及更早存档的 `edits` 差分仍按坐标生效，但周围自然地形会变；载入时会自动把玩家抬到新地形之上，避免卡在方块里。方块 id 未变动（矿石追加在表尾）。

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
CraftAPI.world.biomeAt(120, -40);    // 'ocean'|'beach'|'desert'|'plains'|'forest'|'taiga'|'alpine'
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

// 7. 生存模式（v1.1.0）
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
除原有玩法事件外，v1.2.0 新增 `chunk:unloaded` / `stream:backpressure` / `service:ready` /
`plugin:registered` / `plugin:enabled` / `plugin:disabled` / `plugin:error`，
并支持用 TypeScript 声明合并追加自定义事件类型。

### v1.2.0：插件与事件成为独立服务

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

权限白名单 `world:write` / `player:write` / `save:write` / `api:emit` / `blocks:register`：
未声明的写能力在插件上下文里会被拦截并抛错，读能力默认开放。
内置插件 `core:autosave`、`core:hud-feedback` 就是用同一套契约实现的，见
`src/plugins/builtin/`。完整契约与迁移路径见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 已预留的未来方向

- **光照**：天空光 / 方块光已落地（`src/world/light.ts`）；后续可扩展彩色光源或平滑光照。
- 合成 / 工具耐久 / 护甲 / 更多怪物：生存循环已跑通，可在 `src/player/survival.ts` 与
  `src/world/blocks.ts` 的 `drops` 字段上继续叠加（见 `CraftAPI.survival`）。
- 更多生物群系 / 结构：实现 `IWorldGenerator` 即可整体替换。
- 多人联机：世界读写集中在 `World`，编辑差分天然是同步消息格式。
- 纹理包：`registerTile` 可运行时重绘图集，注册后自动刷新 Worker 配置。
- **Worker 网格化已落地**（v1.3.0 Worker 池 + Greedy；本次修复补齐构造期失败的整体回滚）；
  后续可做跨区块网格缓存或 GPU 侧合并。

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
| `npm run test:snapshot` | **从当前 TS 源码现场编译** `test/logic` / `test/terrain-logic`，杜绝手工同步漂移 |
| `npm run test:logic` | 生存状态机 8 组 + 地形 23 组（性能基准、旧 22 方块 id 兼容） |
| `npm run test:light` | 光照 21 组：天空光列、方块光衰减、跨区块传播、放置 / 破坏后的增量回收 |
| `npm run test:mesher` | **网格等价与收益**：快照保真、Greedy 面覆盖与光照逐格等价、quad 下降比例 |
| `npm run test:services` | 服务容器 / 事件服务 / 插件服务 / 存档校验 38 项 |
| `npm run test:diagnostics` | 运行时诊断组 20 组断言（健康快照 + 各类异常注入） |
| `npm run test:worker-pool` | Worker 池构造失败整体回滚的注入式回归 |
| `npm run test:edits` | 编辑差分数值分桶：负坐标 / 边界 / 覆盖 / 存档导出 |
| `npm run test:terrain-system` | **方块扩充 + 生成管线 + 群系配置表** 34 组：id 45~91、阶段顺序、35 种植物与自然生成位置 |
| `npm run test:botany` | **植物生态随机刻** 28 组：生长 / 蔓延 / 枯萎 / 树种 / `plant:grow` 事件 |
| `npm run test:plant-energy` | **植物内在能量** 29 组：日照蓄能 / 夜间下限 / 环境枯死 / 开花 / 采集 / 根系共享 |
| `npm run test:smoke` | Chromium 实景（桌面 + 移动端），结果与截图写入 `test/artifacts/` |
| `npm run test:visual` | 像素级视觉回归：昼夜 / 火光 / 方块展示墙 / 天穹状态断言（13 项） |

Linux 无 GPU 环境用软件渲染跑实景（v1.1.2 声称「本环境无法初始化 WebGL」其实是缺
`--disable-gpu-sandbox` 与 `--enable-unsafe-swiftshader`）：

```bash
CHROME_PATH=/usr/bin/chromium MC_HEADLESS=0 MC_GL=desktop \
  xvfb-run -a -s "-screen 0 1280x760x24" npm run verify
```

`.github/workflows/verify.yml` 按此配置接入 CI，要求浏览器测试 **100% PASS**。
断言总数与 benchmark 数字以 `test/artifacts/results.json` 实际输出为准；下文各版本记录里的
具体数字只代表当时环境，不应作为当前验收口径。

覆盖：模式选择、血量/鸡腿/氧气 HUD、挖掘进度与掉落入包补位、放置与消耗、伤害与死亡重生、
进食、夜间僵尸生成与攻击、模式切换、存档 v2 与继续游戏、移动端摇杆/长按挖掘/按钮语义/安全区布局；
v1.2.0 另加版本一致性、服务容器注册、内置插件启用、事件派发统计、插件热注册/停用清理，
以及传送后「流式加载队列收敛且生成的区块都有网格」的轮询断言（取代固定 sleep）。
v1.3.0 再补：网格化确实跑在 Worker、Greedy 生效且有合并收益，以及 `?mesher=main&greedy=0`
的**降级路径仍能正常出网格**（Worker 在受限环境创建失败时的兜底）。

## 技术栈

- TypeScript 5.6（strict）
- three.js 0.170（唯一运行时依赖）
- Vite 5 + vite-plugin-singlefile（构建为单文件 HTML）

## 审查修复记录（v1.1.1）

按源码审查报告落地的主要修复：

- **P0** 标题页「生存 / 创造」选择真正写回状态机；有存档时「新的世界」也遵循所选模式。
- **P0** 新生成区块自身入队网格化，未生成区块的脏标记不再被提前删除；生成 / 网格化改为「整帧累计限时 4ms / 6ms」。
- **P1** 触控灵敏度不再被平方；暂停 / 死亡态冻结昼夜；Esc 与指针锁定丢失的 pause 边沿去重；进食先扣物品；模式切换按背包重建快捷栏；中键取样与方块库指派不再把物品覆盖成孤儿，方块库支持重新指派食物；`give('apple')` / `count('apple')` 可用；`entity:hurt` / `game:pause` 事件正式发出；`setFly` 遵守生存限制。
- **P2** 树叶同材质内部面剔除、区块网格不再上传无用法线、图集容量溢出报错、DDA 起点零法线命中跳过、存档 v2 字段校验、粒子淡出与帧率无关、摔落阈值对齐「>3 格」、相机 far 随渲染距离收敛、动态分辨率仅在游玩时调整、受伤 / 破坏 / 放置 / 死亡补充震动反馈。
- 测试新增 4 项回归断言：标题 UI 模式接线、两个事件可订阅、远距离传送后区块均完成网格化。

> 仍待实施（本次源码复核）：透明通道按距离排序、AABB 脱困，详见「已知限制」。
> `meshChunk` 搬入 Worker、Greedy Meshing、编辑差分按区块分桶三项已在 v1.2.0~v1.3.0 落地。

## 地形升级记录（v1.1.2）

- 重写 `DefaultGenerator`：域扭曲高度场、脊线山脉与河道、温度/湿度群系、雪线与陡坡露石。
- 洞穴改为「随距地表深度渐隐」，新增分层矿脉与 4 种矿石方块/纹理（追加在注册表末尾，旧 id 不变）。
- 树木改为世界坐标候选点 + 邻域裁剪，**跨区块树冠连续**（原报告的遗留项已完成）。
- `World.surfaceHeight()` 与 `Player.spawn()` 改用地形高度，不再把树冠/草丛误判为地面；载入旧存档时自动抬升脱困。
- `CraftAPI.world.biomeAt()` / `terrain()` 开放群系与列信息查询。
- 出生岛抬升半径加噪声扰动，岸线不再是正圆；河道改为按陆地高度平滑淡出。
- 新增 `test/terrain-check.cjs`（**23 组断言**：确定性、生成顺序无关、群系多样性、洞穴不穿地表、矿脉分层、±x 双向跨区块树冠、参数开关、性能基准，以及下方核验项）。

### 收尾核验补修（同版本）

专项核验用大范围采样发现并修复两个隐藏缺陷：

| 问题 | 修复前 | 修复后 |
|---|---|---|
| 水下地层被洞穴挖出空气袋（46587 体素采样） | 9.20% | **0%** |
| 河道切入深海床（远场 3471 列采样） | 141 列 | **0 列** |

对应做法：水下地层 `fade = 0` 不挖洞穴；河道深度乘 `smoothstep(SEA_LEVEL-1, SEA_LEVEL+4, h)` 平滑淡出。两项均已固化为回归断言，另补充「40 个 seed 出生点均为陆地」「旧 22 方块 id 未变 / 矿石 id 23–26」「存在成片海洋」等兼容性断言。

核验结果：`tsc --noEmit`（strict）0 error；`vite build` 通过；`logic-check.cjs` 8 组 + `terrain-check.cjs` 23 组全通过；图集 31/64 格未溢出。浏览器实景冒烟测试当时未执行——v1.2.0 已定位到真实原因（缺少 `--disable-gpu-sandbox` / `--enable-unsafe-swiftshader` 两个 flag，并非环境不支持 WebGL）并跑通。

## v1.2.0 架构革新与修复记录

### 架构

| 变化 | 说明 |
|---|---|
| `services/ServiceContainer.ts` | 类型安全服务注册表（provide / require / 逆序 dispose） |
| `services/events/` | EventService：错误隔离 / once / waitFor / onAny / stats / 递归深度保护；EventChannel 命名空间作用域 |
| `services/plugins/` | PluginService：注册 / 依赖解析 / 权限裁剪 / 启停 / 生命周期事件；PluginContext 契约 |
| `api/` | CraftAPI 退化为薄门面，新增 `plugins` / `events` 命名空间，旧 22 项能力签名完全不变 |
| `plugins/builtin/` | `core:autosave`、`core:hud-feedback` 从 800 行 `boot()` 抽出，成为一等公民插件 |
| `core/events.ts` | 兼容垫片（旧代码与纯逻辑测试快照仍可用） |
| `main.ts` / `core/version.ts` | 前者退化为组装根；后者成为全项目唯一版本来源 |

### 修复与优化

| 项 | 内容 |
|---|---|
| 幽灵区块竞态 | 删除 `initialLoad()` 末尾的 `dirty.clear()`；预载期间主循环让开；每帧兜底把「已生成但无网格」的区块重新入队 |
| 流式加载 | dirty 积压 > 24 触发背压暂停生成；卸载改按 `world.chunks` 遍历，未网格化区块同样释放 |
| Pointer Lock | `requestPointerLock()` 返回的 Promise 加 `.catch()`；实现 iframe / 无头环境的拖拽视角降级（v1.1.2 里 `lockFailed`/`dragging` 是死代码） |
| 版本一致性 | `version.ts` 单一来源 + `check-version` 机械校验，修复包名 / package.json / CraftAPI / F3 四处漂移 |
| 存档 | `validateSave()` 全量字段校验，供 `load()` 与 `CraftAPI.save.import()` 共用 |
| 存档差分 | `edits` 按 chunkKey 分桶，`ensureChunk()` 从 O(全档编辑数) 降到 O(本区块编辑数) |
| UI / 状态机 | 有存档时标题模式高亮同步真实模式；`openPalette()` 补发 `game:pause` |
| 测试工程化 | 快照自动从源码编译、`npm run verify`、31 项服务单测（v1.2.0 当时，v1.3.2 已扩到 38 项）、流式断言改轮询、CI 要求 100% PASS |

## v1.3.0 渲染管线升级记录

### Worker 化

| 项 | 内容 |
|---|---|
| 数据契约 | `meshTypes.ts`：`MeshSource` 接口 + `MeshConfig`（方块元数据 + UV 表）+ `MeshSnapshot`（1 格 halo，18×80×18 `Uint8Array`）+ `PackedGeo`（Transferable） |
| 同一份算法 | `mesher.ts` 只依赖 `MeshSource`；主线程 `WorldMeshSource` 与 Worker `SnapshotMeshSource` 共用，杜绝两套实现漂移 |
| 调度 | `?worker&inline` Blob Worker；请求代次（generation）去重、在途结果丢弃、每帧只投递预算内任务 |
| 降级 | Worker 创建/运行失败自动切主线程同步网格化；`?mesher=main` 可强制验证 |
| 卸载 | 区块卸载时取消在途任务，避免回传已删除区块的几何 |

### Greedy Meshing

| 项 | 内容 |
|---|---|
| 合并条件 | 按面方向建 mask，key = 方块 id + AO 档位 + 天空光 + 方块光；**仅四角 AO 与光照完全相等才合并**，保证合并后双线性插值与原逐面结果一致（`flip` 恒为 false，三角化方向也不变） |
| 特殊方块 | cross 植物、液体（水面降顶）、玻璃、自发光、AO 不均的面一律走原逐面路径 |
| UV 平铺 | 合并面局部 UV 为 `0..w / 0..h`，`tiledAtlas.ts` 用 `onBeforeCompile` 注入 `fract(vMapUv)`，避免图集越界或拉伸 |
| 对照开关 | `?greedy=0` 关闭合并，用于基准与回归对照 |

### 实测

| 核验 | 结果 |
|---|---|
| 面覆盖等价（3 种子 × 2 区块 × 4 通道） | 逐格一致，亮度差 `0.0e+0` |
| 快照 vs 直读数据源 | 逐字节一致（两种 greedy 设置） |
| quad 数 | 11,526 → 6,978（**-39.5%**），最大合并面 105 格（当时 A/B 环境的历史基准，随机型与场景浮动） |
| 浏览器实景 | 网格化 `mesherMode=worker`，`gen=89 / mesh=89 / dirty=0`，无幽灵区块 |

### 已知限制（带排期）

- Greedy 使单区块网格化 CPU 增加约 40%（多一次按面扫描 + 每个可见面一次 AO 计算）；因已移出主线程，
  渲染不再被阻塞。v1.3.0 已按 `navigator.hardwareConcurrency` 起 **Worker 池**（least-busy 派发，
  `?workers=N` 可覆盖）解除单 Worker 吞吐上限，8 核环境流式加载收敛随核数线性提升。
- 透明通道未按距离排序，重叠玻璃可能闪烁。
- 光照为 15 级硬边（无平滑插值）；区块卸载期间边界旧光可能被邻块保留，
  重新加载时偶尔出现一格偏亮，待后续用区块光照快照或边界重算解决。
- 无 AABB 脱困：被方块挤住时需手动挖开。
- 软件渲染下 FPS 约 10，引擎把 `dt` 钳制到 0.05 防穿墙，游戏时间流速约为真实的一半；
  不影响真实浏览器，但自动化测试必须按条件轮询而非固定 sleep。

## v1.3.0 网格化 Worker 池记录

v1.3.0 把网格化搬进单个 Blob Worker，解除了主线程阻塞，但单 Worker 仍是流式加载吞吐的上限
（多核机器只有一个核在干活）。v1.3.0 把单 Worker 升级为**多 Worker 池**：

| 项 | 内容 |
|---|---|
| 池大小 | 默认 `min(navigator.hardwareConcurrency - 1, 4)`（留 1 核给主线程，至多 4）；`?workers=N` 可覆盖，夹紧 1..8，便于基准对照 |
| 派发 | `pickWorker()` 选「在途任务数最少」的 Worker（least-busy），避免重区块堆积在某一核 |
| 计数 | 请求带 `wid`，Worker 原样回显；`drainResults` 按 `wid` 回退在途计数，保证计数与派发一致 |
| 降级 | 任一 Worker 构造或运行失败 → `fallbackToMain()` 终止整池并同步补算；`?mesher=main` 仍可强制 |
| 零改动 | `mesher.ts` / `mesh.worker.ts` / 契约（`MeshSource` / `MeshSnapshot` / `PackedGeo`）完全不动，池只是调度层 |

### 实测（v1.3.0 实景）

| 核验 | 结果 |
|---|---|
| 网格化默认在 Worker 池 | `mesherMode=worker`，`workerCount=4`（8 核机） |
| 流式收敛 | `gen=89 / mesh=89 / dirty=0`，无幽灵区块 |
| Greedy 收益不受影响 | `quads=223546 / merged=169465`，亮度差 `0.0e+0` |
| 降级路径 | `?mesher=main&greedy=0` 仍正常出网格（`mesh=89 / merged=0`），无运行时错误 |
| 回归 | 版本一致 / tsc 0 error / 构建单文件 638KB / 逻辑 23 / mesher 43 / 服务 31 / 实景 87 全部 0 失败 |

## v1.3.0 光照系统记录

在 Worker 池与 Greedy 管线上接入天空光 / 方块光，输出契约与旧存档保持不变：

| 项 | 内容 |
|---|---|
| 数据 | `Chunk.sky` / `Chunk.block`（`Uint8Array`，0~15）+ `lit` 标记；`World.getSkyLight` / `getBlockLight` 对未加载区块回退为「露天 / 全黑」 |
| 传播 | 天空光按列初始化 + 影子边界 BFS；方块光从 `lightEmission > 0` 的方块出发；跨区块只在已点亮区块间传播 |
| 增量 | 放置 / 破坏方块：清空受影响光、从边界重新扩散；光照变化的区块自动并入 `world.dirty` |
| 种子过滤 | 初始化时只把「确实能提升另一侧」的边界格入队，49 区块基准中天空光种子从 16.2 万降到 1.7 万（-90%） |
| 快照 | `buildMeshSnapshot` 一次拷贝 `data` / `sky` / `block` 三张 18×80×18 缓冲，随 Worker 消息 transfer |
| Greedy | mask key = `id | ao<<8 | sky<<10 | block<<14`，光照不同不合并；回归测试同时比对每面格的贴图与天空光 / 方块光 |
| 昼夜 | `uDaylight` 与 `uSunTint` 由 `Sky` 每帧写入；天空光乘昼夜，方块光取 `max`，自发光通道不参与 |
| 回退 | 无 Worker 时主线程 `WorldMeshSource` 直接读 `World` 光照，输出与 Worker 路径一致 |

### 实测

| 核验 | 结果 |
|---|---|
| 光照单测 | 14 组断言：露天 / 地下 / 火把衰减 / 跨区块 / 移除回收 / 石头遮挡恢复 |
| mesher 回归 | 43 项通过；面覆盖一致、亮度差 `0.0e+0`、逐字节快照保真（含光照） |
| 光照初始化 | 单区块约 3~6 ms（Node，49 区块稳态基准）；单次方块光照更新约 1 ms |
| Greedy 收益 | 实测区块 quad 减少 32%~50%，光照不同的面按预期保留为独立 quad |
| 构建 | `dist/index.html` 657.89 kB（较方块阶段 +8.85 kB） |

## v1.3.0 性能优化记录

同一版本号下的纯性能优化：玩法、确定性、公共 API 与网格输出均不变。
验收口径为「优化前后网格输出逐字节一致」——3 个种子 × 9 个区块 × greedy/legacy 两种配置，
共 270/270 项哈希完全一致。

| 优化点 | 内容 |
|---|---|
| `buildMeshSnapshot` | 中心 16×16 按 y 行整段 `set`，halo 直接读 3×3 邻居的 `chunk.data`，移除逐格 `world.getBlock` 的字符串 key 查找 |
| 方块注册表 | 稠密 id 数组 + `opaque`/`solid` 字节标志快路径；自定义 id ≥ 65536 自动回退 `Map`，避免稀疏大数组 |
| Worker 数据源 | `SnapshotMeshSource` 预计算 id → 遮光字节表，AO 每面 12 次采样不再走 `def()` 属性链 |
| mesher 分配 | 逐面 / 逐顶点临时数组改为模块级 scratch，`pushQuad` 直接写入通道数组；AO 写入预分配 `Int32Array` |
| 生成器缓存 | 超限时淘汰最旧 1/4，而不是 `clear()` 整表，消除邻区块复用时周期性重算尖峰 |
| 天空 | 每帧不再 `new Vector3` / `new Color`，复用临时对象 |
| 实体 | 离场时释放每个实例新建的 geometry / material / texture，修复反复刷新种群的 GPU 资源泄漏 |

### A/B 基准

5 轮交替执行取全局最小值；本机为 3 核共享环境，绝对值受负载影响，只看相对变化。

| 项 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| `buildMeshSnapshot` | 0.928 ms/区块 | 0.173 ms/区块 | **-81%** |
| mesher 逐面（legacy） | 7.20 ms | 6.64 ms | -7.8% |
| mesher greedy | 10.03 ms | 8.68 ms | -13.5% |
| `BlockRegistry.isOpaque` | 25.1 ns | 8.1 ns | -68% |
| `BlockRegistry.isSolid` | 25.2 ns | 6.7 ns | -73% |
| `BlockRegistry.get` | 24.1 ns | 18.2 ns | -24% |
| `World.isSolidAt` | 149.4 ns | 111.5 ns | -25% |
| `World.getBlock` | 基本持平 | 基本持平 | — |

### 回归结果

| 项 | 结果 |
|---|---|
| 网格输出哈希 | 270/270 逐字节一致 |
| 版本一致 / 类型检查 | `check:version` 通过，`tsc --noEmit` 0 error |
| 逻辑 / mesher / 服务 | 23 / 43 / 31 项全部通过 |
| 构建 | `dist/index.html` 641.05 kB（单文件） |

## v1.3.0 画面润色记录（纯视觉，不改玩法与网格化）

只动 `src/gfx/sky.ts` 与 `src/main.ts` 的一行接线，不触碰 world / mesher / worker，
因此 `test:mesher` 的逐面等价断言与存档格式完全不受影响。

| 改进 | 位置 | 效果 |
|---|---|---|
| 天穹渐变去色带 + 平滑曲线 | `Sky` 天穹 fragment shader | 用 smootherstep 曲线替换 `pow(h, 0.58)`，并叠加每像素哈希抖动，消除大面积天空上肉眼可见的同心色带 |
| 地平线霞光带 | 同上 | 日出/日落的暖色被压向贴近地平线的窄带，并与太阳**方位**对齐（此前是全向泛光），黄昏天空不再整片糊成橙色 |
| 体素云立体化 | `Sky.buildClouds()` | 逐面烘焙顶点色（顶亮 / 底暗 / 侧面区分 x、z 轴）并开启 `depthWrite`，云从半透明「华夫格纸片」读成有厚度的体素板；夜间按日照压暗、黄昏染向霞光色 |
| 水下大气 | `Sky.update()` / `setUnderwater()`，`main.ts` 的 `ui` 系统接线 | 相机没入水中时，雾色切向深水蓝并收敛到 `near=2 / far=0.42R`，世界亮度乘上蓝色偏移，天穹与云同步压暗淡出；入/出水用约 0.2s 指数过渡，不硬切 |

## v1.3.1 集成复核与修复记录（画面润色 + 光照移植）

v1.3.1 不改玩法、不改网格化算法，只把当天落到 main 的四组画面润色、trae 分支的
**光照 / 新方块 / 图集美术 / 视觉回归**移植，以及集成复核中修掉的真实缺陷收进一个可回归的版本；
版本仍是单一来源（`package.json` / `src/core/version.ts` / `CraftAPI.version` / F3 / README），
由 `scripts/check-version.mjs` 在 `npm run verify` 中机械校验。

### 新增

| 项 | 位置 | 说明 |
|---|---|---|
| 天空光 / 方块光双通道 | `src/world/light.ts`、`src/world/mesher.ts` | 0~15 双通道 BFS（列初始化 + 阴影边界播种 + 跨区块边界种子），火把与南瓜灯真正照亮洞穴；亮度按面格进顶点属性，昼夜与点光源不增加 draw call，Greedy 只在贴图与亮度完全一致的面之间合并 |
| 18 个新方块 | `src/world/blocks.ts` | 火把、南瓜灯、石砖系、苔石、黑曜石、砂砾、沙岩、冰、云杉 / 白桦木板、工作台、蘑菇、枯草、四色羊毛，**追加为 id 27~44**，1~26 不变，旧存档的编辑记录依旧有效 |
| 图集美术重绘 | `src/gfx/atlas.ts` | 树叶簇、草 / 石 / 水 / 砖的逐像素重绘 + 新方块对应贴图；图集 8×8=64 槽位仍有富余，`registerTile()` 可注入自定义纹理 |
| 视觉回归测试 | `test/visual-check.mjs`、`npm run test:visual` | headless Chromium + swiftshader 截图比对，9 项断言（白天非纯色 / 夜间明显变暗且仍有细节 / 火把方块光与邻格发光 / 移除后归零 / 火光区域更亮 / 方块展示墙颜色丰富 / 无运行时错误），已挂进 `verify` 与 CI |
| MIT LICENSE | `LICENSE` | 明确授权与免责 |

### 改进

| 项 | 位置 | 效果 |
|---|---|---|
| 天穹去色带 | `src/gfx/sky.ts` | smootherstep 曲线替换 `pow(h, 0.58)` 并叠加逐像素哈希抖动，消除大面积天空上的同心色带 |
| 地平线霞光方位化 | `src/gfx/sky.ts` | 日出 / 日落暖色压向贴近地平线的窄带并与**太阳方位**对齐，黄昏不再整片糊成橙色 |
| 体素云立体化 | `src/gfx/sky.ts` | 逐面烘焙顶点色 + `depthWrite`，夜间按日照压暗、黄昏染向霞光色 |
| 水下大气 | `src/gfx/sky.ts`、`src/main.ts` | 入水切深水蓝雾并收敛 `near/far`，天穹与云淡出，入 / 出水约 0.2s 指数过渡 |
| 光照回归覆盖 | `test/light-check.cjs` | 断言 14 → 21：跨区块密封天窗、遮光回收、幂等往返；`test:snapshot` 把 `light.ts` 纳入快照编译 |
| 生存初始配置 | `src/main.ts` | 创造栏补入火把，生存初始背包补 8 个火把，新方块开箱可用 |

### 修复

| 缺陷 | 位置 | 说明 |
|---|---|---|
| 堵死光源后天空光不回收 | `src/world/light.ts` | 旧实现只把本列清零再把水平邻居塞回队列：既漏掉光井里**等亮度**（相邻都是 15）的整列梯度，也漏掉回收后仍残留的水平依赖格。实测密封天窗封死后房间内残留 108 格亮光；树叶 / 水落进光井时因 `opacity` 同为 1，判据根本不触发。改为以「竖向衰减」`columnCost` 判据 + 沿列逐格 `removeLight` + BFS 出队时校验当前亮度丢弃陈旧种子 |
| 重复放置同一方块白扣背包 | `src/player/player.ts` | 火把这类非实心方块不会被「目标格已实心」拦住，而 `setBlock` 对同 id 返回 false 什么都不做，`consume` 却已经扣过——实测 10 个火把对着火把放置后变 9 个、世界上没多出任何东西。放置前先拦住同 id 目标格 |
| 方块 id 越界静默截断 | `src/world/blocks.ts` | 注册时校验 `1~255`，越界 id 会被 `Uint8Array` 截断成另一个方块，现在直接抛错 |
| `world.dirty` 无界增长 | `src/world/chunkManager.ts` | 派发半径外的脏键直接丢弃，靠近时由自愈入队补回；实测 400 次远端编辑后键数仍有界 |
| 存档写入失败被吞 | `src/save/save.ts`、`src/main.ts` | `save()` 返回写入字节数供 `save:done`，仅在写入成功后清脏标记、失败保留并重试；新建世界 / 导入存档后补挂 `beforeunload`，续档会复活已失效的存档 |
| 模式切换双轨 | `src/main.ts`、`CraftAPI` | 菜单与 `CraftAPI.setMode` 统一走 `applyMode`，不再有两套各自维护的状态 |
| 视角与指针锁 | `src/main.ts` | 指针锁在用户手势内申请；加载后丢弃残留的 look delta，避免进场瞬间视角甩动 |
| 实体上下浮动 | `src/entity/` | 浮动写回的是偏移量而非绝对 Y；`player:move` 事件节流 |
| 视觉检查火把取样歧义 | `test/visual-check.mjs` | 改在光照无歧义的邻格采样，消除偶发误判 |
| 放置消耗断言偶发失败 | `test/survival-smoke.mjs` | 按住右键跨过 `placeTimer=0.24s` 连放 2 次是预期行为，断言放宽为「确实消耗」并补一条确定性回归 |

### 复核结论（未发现问题之处）

- 合并未残留冲突标记与重复代码；Worker 池、`meshSource` / `SnapshotMeshSource` 回退、`tiledAtlas`
  与 `injectLight` 的 `onBeforeCompile` 链式接线（含 `customProgramCacheKey`）在移植后依旧自洽。
- 负坐标区块的 `>>4` / `&15` 位运算、`costCache` 哨兵、跨区块边界播种几何、方块光回收路径复核无误。
- 光照不落盘、按世界数据确定性重算：火把 / 南瓜灯等编辑重载后亮度一致，重载无页面错误。

### 验证结果

| 项 | 结果 |
|---|---|
| `check:version` / `typecheck` | 版本一致，`tsc --noEmit` 0 error |
| `test:snapshot` / `test:logic` / `test:light` | 快照编译通过；logic + terrain 全绿；光照 21/21 |
| `test:mesher` / `test:services` | 43 / 31 项全部通过（网格输出逐面等价，未受光照修复影响） |
| `test:smoke`（实景） | 88/88，含新增的同 id 放置回归 |
| `test:visual` | 9/9 |
| `build` | `dist/index.html` 659 kB（单文件） |

---

## v1.3.2 运行时诊断与修复记录

### 修复

| 缺陷 | 位置 | 说明 |
|---|---|---|
| 运行时注册方块后 Worker 配置不刷新 | `src/world/chunkManager.ts`、`mesh.worker.ts` | `invalidateConfig()` 旧实现把 config 置 null 后调用 `postConfig()`，后者因 config 为空直接返回；Worker 派发路径也不重建配置。现在立即重建、下发并重排全部网格，Worker 回传 `config-ack` 供诊断确认 |
| Worker busy 计数泄漏 | `src/world/chunkManager.ts` | 区块卸载后旧结果晚到会跳过 `busy--`；现在每条回传先回退派发计数，再判断是否过期 |
| 暂停 / 死亡期间按键卡住 | `src/input/input.ts`、`src/main.ts` | keyup 不再受 `enabled` 限制；暂停、死亡、返回标题、开始游戏时统一 `input.reset()` |
| 菜单 → 方块库关闭后直接恢复游戏 | `src/ui/hud.ts`、`src/main.ts` | 菜单按钮改走 `onPaletteOpen('menu')`，`paletteReturn` 正确回到菜单 |
| 入水 / 传送 / 切模式后残留摔落伤害 | `src/player/player.ts`、`src/main.ts` | 入水、`teleport()`、`spawn()`、切换飞行、模式切换均清零 `fallVy` |
| 插件并发启用误报循环依赖 | `src/services/plugins/PluginService.ts` | 用 `pending` Promise 表复用进行中的初始化，循环检测只沿当前递归链 |
| 初始化中 disable 后回写 enabled | `src/services/plugins/PluginService.ts` | 每次 enable/disable 递增 epoch；setup 返回后检测代次，只清理不回写 |
| `EventChannel.waitFor` 不受作用域管理 | `src/services/events/EventChannel.ts` | 改为通道内 `once` + 定时器，dispose 时统一退订并 reject |
| 权限可经 `blocks.register` 绕过 | `src/services/plugins/PluginService.ts` | 无 `blocks:register` 时暴露只读 Proxy；`tnt.ignite` / `entities.spawn` 归入 `world:write`，`survival` 写入口归入 `player:write` |
| 异步存档回调吞掉新编辑 | `src/main.ts` | 增加 `dirtyVersion` + `saveSeq`，只有最新保存且期间无新编辑时才清脏 |
| 天空光列回收平方级开销 | `src/world/light.ts` | 旧实现沿列逐格 `removeLight`，在洞穴/悬崖上方放置方块会重复遍历同一依赖链；改为整列清零 + 多源 BFS，每格只处理一次 |
| 云层每 96 格跳变 / 长时间挂机漂出视野 | `src/gfx/sky.ts` | 云块以世界格为锚点、按 1/4 网格宽度重建，漂移与移动均无接缝 |
| `surfaceHeight` 向上找平台分支不可达 | `src/world/world.ts` | 向下扫到基岩后再向上寻找玩家搭建的平台 |
| 最顶层放置白扣物品 | `src/player/player.ts` | 消耗背包前先校验 `1 <= y < WORLD_HEIGHT` |
| 存档校验过松 | `src/save/save.ts` | 校验 edits 坐标格式 / 方块 id、背包 key / 数量、dayTime 范围、快捷栏整数 id |
| 示例插件发光值溢出 | `src/plugins/example/welcome.ts` | `0.8` → `14`（0~15） |

### 运行时诊断组

- `CraftAPI.diagnostics.run()` / `.last()`：返回 `{ ok, checked, errors, warnings, issues, durationMs }`。
- F3 面板增加「运行时诊断」一行；`__mc.diagnostics` 可在控制台直接调用。
- 每 10 秒自动采样一次，异常集合变化时才输出 `console.groupCollapsed` 分组（warn 不触发
  浏览器 `pageerror` 断言，因此可在实景测试中安全开启）。
- 检查项：版本一致性、玩家坐标 / 摔落值、playing 输入状态、暂停态残留按键、Worker 配置 ACK、
  Worker 池大小、未初始化光照、幽灵网格、视距内缺网格、网格积压、插件 failed、事件订阅、
  生存数值与死亡状态一致、实体数量、存档脏标记老化。

### 验证

| 项 | 结果 |
|---|---|
| `test:services` | 38 项（新增并发启用 / 初始化中停用 / waitFor 清理 / 只读 blocks 权限） |
| `test:diagnostics` | 20 组断言（健康快照 + 各类异常注入） |
| `test:smoke` | 95/95；新增诊断组、运行时注册方块 Config ACK、菜单方块库返回、keyup 清理断言；固定 seed=2026 + 条件轮询，消除地形随机性导致的假失败 |
| `test:visual` | 9/9 |

---

## v1.4.0 方块扩充与地形体系整合

### 新增方块（id 45~54，末位追加）

| id | 方块 | 说明 |
|---|---|---|
| 45 | 铜矿石 | 地下矿脉，深度 ≤50（含矿脉漂移） |
| 46 | 绿宝石矿石 | 只在高山群系，逐格校验群系边界 |
| 47 | 青金石矿石 | 地下矿脉，深度 ≤32 |
| 48 | 红石矿石 | 地下矿脉，深度 ≤22 |
| 49 | 黏土 | 浅海海床（海平面下 3 格内）按概率铺 |
| 50 | 灰化土 | 针叶林地表，掉落泥土 |
| 51 | 仙人掌 | 沙漠沙面成列 1~3 格 |
| 52 | 甘蔗 | 临水浅岸 1~2 格高（十字面） |
| 53 | 蕨 | 草甸 / 森林 / 针叶林装饰（十字面） |
| 54 | 花岗岩 | 地下岩脉，深度 ≤44 |

### 地形生成体系

- **统一阶段管线**：`TERRAIN_STAGES = ['columns', 'ores', 'trees', 'decorate']`。
  `generateChunk` 只负责构建一次列信息上下文并按序派发；阶段顺序是契约——
  矿石只替换石头、树木先于花草、装饰不覆盖树冠。实例 `gen.stageNames` 可读，测试直接断言。
- **群系配置表**：`BIOME_PROFILES` 统一描述 7 个群系的 `surface / filler / plants /
  clayChance / cactusChance / caneChance`；构造时解析成方块 id，柱状与装饰阶段只读表。
  新增群系或地表方块不再散落在 `if` 分支里。
- **新自然生成**：铜 / 红石 / 青金石 / 花岗岩矿脉按深度分布，绿宝石限定高山；
  黏土只铺浅海床，灰化土替换针叶林草皮，仙人掌只长沙漠沙面，甘蔗要求四邻有更低水面，
  蕨按权重进入草甸 / 森林 / 针叶林。全部特征仍由「世界坐标 + seed」决定，生成顺序无关。
- **图集扩容**：`GRID 8 → 16`（256 槽），内置纹理 64 张 + 运行时 `registerTile()` 仍有富余。

### 验证

| 项 | 结果 |
|---|---|
| `test:logic` | 生存 8 组 + 地形 23 组全通过 |
| `test:terrain-system` | 18 组断言（id 45~54、阶段顺序、配置表覆盖、10 种新方块自然生成位置、oreRichness、顺序无关） |
| `test:light` / `test:mesher` / `test:services` / `test:diagnostics` | 全通过 |
| `test:smoke` | 95/95（版本断言更新为 1.4.0） |
| `test:visual` | 9/9（方块展示墙加入 10 种新方块） |

---

内容由 AI 生成