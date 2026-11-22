# 更新日志（Changelog）

本项目所有值得注意的变更都记录在此文件。
版本号遵循「双轨版本」约定：正式版 `vN`（里程碑）/ 迭代版 `X.Y.Z`（日常迭代），
唯一来源为 `src/core/version.ts`。更详细的演进实录见 README 各版本记录章节。

## [Unreleased]

### 新增（移植 PR #23 优良部分）
- **Java 1.20 HUD/UI**：深灰石板面板、立体按钮与悬停 `» «` 记号（修复了原 PR 中伪元素宽度恒为 0 导致记号不可见的缺陷）；新增标志性经验条（`HUD.setExperience(level, progress)` 为视觉占位，当前无调用点）。
- **横屏模式（实验性内容）**：锁定横屏 + 宽屏 HUD 重排 + 竖屏「请旋转设备」提示；提示卡片提供「关闭横屏模式」按钮（修复遮罩盖住设置页无法退出的缺陷）；提示显隐只由当前方向与开关决定，锁定成功后转回竖屏可重现（修复原 PR 的陈旧锁状态缺陷）。
- **设置修复**：重置全部设置时移动端 `autoJump` 不再被关；导入 / 重置会把 experimental 推送到 WASM 内核与插件载体；死亡界面文案随「死亡保留物品」开关动态显示；experimental 注释改为「即时生效」。

### 说明
- 未移植 PR #23 的 >1MB 截图与其自带变更文档（截图违反「大二进制不入库」硬规则；文档中的临时验证声称无法复现）。
- 浏览器回归断言已补进 `test/options-check.mjs`；本机无可运行 Chromium，`test:options` / `test:visual` / `test:smoke` 留待 CI 执行。

## [1.5.4-alpha.2] - 2026-11-22 · 审查清理

### 修复
- `verify` 去重：`test:mobile` 不再重复执行 `test/visual-check.mjs`（原本与 `test:visual` 各跑一次）。
- 文档一致性：篮球事件注释与 `test/basketball-check.cjs` 头部的过期「v1.5.2」字样改为版本无关措辞。
- 移动端投掷键图标由「圆圈 + X」换成篮球线条，与 aria-label「投掷篮球」一致。
- 创造模式拾取篮球时 `addItem` 不入库，现仅在确实入库时提示「篮球已收回」。
- 还原 PR #24 中 12 个文件被意外从 `100755` 改成 `100644` 的权限位。

### 流程 / 验证
- 修复提交 `2cf0528` 的 `verify` CI 全绿（含浏览器实景组）；版本推进 `1.5.4-alpha.1 → 1.5.4-alpha.2`，预发布标签 `v1.5.4-alpha.2`。

## [1.5.4-alpha.1] - 2026-11-22 · 篮球物理与移动端原版体验（PR #24）

### 新增
- **世界内篮球**：可拍可投的篮球实体（`src/entity/basketball.ts`），弹跳 / 滚动物理、走近拾取、程序化模型与音效；创造模式快捷栏无限取用。
- **原版 UI 与触控**：`vanillaUI` 默认开启，按钮 / 布局高仿 Java 1.20；触屏控件改为 PE 风格圆角方形按键 + 方形底盘摇杆。
- **移动端**：PWA 锁定横屏 + 竖屏引导兜底；10 阶段程序化挖掘裂纹覆盖层（`src/gfx/crackOverlay.ts`）。

### 修复
- 水体渲染穿透：区块边界未知邻居保守不生成水面。
- 背包 / 快捷栏点击穿透（`pointer-events`）与自动保存提示遮挡快捷栏。
- 移动端设置页触控目标补足到 44px，满足既有无障碍断言（合并期修正，未放宽测试）。

### 流程 / 验证
- PR #24 由旧基线 rebase 到最新 main，解决 `src/ui/hud.ts` 设置说明冲突；rebase 同时带入 main 的 jsdom 25.x 修复，消除 Node 20 下 undici 8 导致的 `verify` 红。
- 修复后 PR #24 两条 `verify` CI 全绿（含浏览器实景组），随后合并入 main（合并提交 `5a3ac25`）。
- 版本：`VERSION=1.5.4-alpha.1` / `RELEASE=v1`，预发布标签 `v1.5.4-alpha.1`。

## [1.5.3] - 2026-11-21 · 实体 AI 系统（行为树）

### 新增
- **AI 系统（方案 A：数据驱动行为树）**：新增 `src/ai/` 模块（Node/Blackboard/AIContext/composites/decorators/conditions/actions/Perception/BehaviorTree/registry/AIComponent/AIService），节点只依赖 `TickContext` 接口，不 import three / World / DOM；副作用经 `ctx.events` / `ctx.api` 发送。
- **行为树 JSON 配置**：`src/ai/behaviors.ts` + `behaviors/*.json` 为猪/羊/僵尸/骷髅提供行为树配置；猪/羊 wander，僵尸/骷髅 chase+attack+wander，与 v1.4.9 行为等价。
- **AIService 集成**：主循环每帧调 `aiService.update(dt, frameCtx)`，分帧预算 2ms；`EntityManager` spawn/despawn 时 attach/detach AIComponent；`Entity.update` 委托 AI 黑板决策（移动/攻击）。
- **测试**：新增 `test:ai`（53 项断言，覆盖节点状态/复合/装饰器/条件/动作/BehaviorTree JSON 编译/AIService 生命周期/4 种生物行为树冒烟）并挂进 `verify` 链；`validate.py` 新增 AI 系统 11 个契约关键词。

### 说明
- 确定性：AI 随机性走 `mulberry32(hash(worldSeed, entityId, label))`，无新增 `Math.random`；既有实体游荡/生成坐标的 `Math.random()` 技术债不动。
- 方块 id / 纹理不变；运行时唯一依赖仍为 three。

## [1.5.2] - 2026-11-21 · 内容体系完善（正式版）

### 新增
- **新动物**：牛 / 鸡 / 兔三种被动动物加入加权生成表（`ANIMALS` / `BREED_FOODS`，权重来自 `dropHash`）；猪 / 羊既有数值原样搬入。新动物掉落全部带 `item:` 前缀（皮革 / 牛肉 / 鸡蛋 / 羽毛 / 兔肉），与既有物品同键可堆叠。
- **繁殖**：猪 / 羊 / 牛 / 鸡 / 兔五种被动动物均可喂食进入求爱窗口，半径 8 格内同类成体双亲冷却结束后产幼崽，幼崽 120 秒长成（0.55 缩放）；择偶按实体 id 升序稳定选择，同种子同状态可复现。食物白名单与所有数值集中在 `src/core/tuning.ts`。
- **可见悬浮掉落物**：新增 `src/entity/droppedItem.ts`（`DropManager` / `DroppedItem`）与纯逻辑 `src/world/dropLogic.ts`；掉落物以小方块实体弹出、浮动自转，0.8 格内同类合并（上限 999），仅限 `playing` 推进 age，超时 / 掉出世界消失，入水终端下沉 `-waterSink` 且水平 `exp(-8*dt)` 衰减、出水恢复重力；拾取回背包并带粒子 / 音效反馈，**不进存档**。散开偏移由 `scatterOffset(seed, source, index)` 用 `dropHash` 生成。
- **物品与配方闭环**：煤矿石改掉 `item:coal`（1~2），新增 6 种物品（煤炭 / 皮革 / 牛肉 / 鸡蛋 / 羽毛 / 兔肉）与对应图集纹理（追加在末尾，既有 tile 索引不变）；新增「煤炭 + 木棍 → 4 火把」配方（`torch_fuel`）。**方块总数 152（原 141 基线 + v1.7.0 内容植物扩充 11 种，内置 id 到 158），本分支不新增方块**。
- **测试**：新增 `test:drop`（9 项：确定性散开 / 拾取半径与延迟 / 同类合并异类不合并 / 超时与掉出世界 / 入水出水 / 暂停不推进 age）并挂进 `verify`；`validate.py` 增加阶段-B CHECK。

### 说明
- 确定性硬规则范围澄清：只约束掉落判定（禁止在掉落路径写 `Math.random`，散开 / 加权抽取走 `dropHash`）；既有实体 AI 的游荡 / 生成坐标 `Math.random()` 属技术债，本轮不动。运行时唯一依赖仍为 three。

### 验证
- `check:version` 三处一致（VERSION 1.5.2 / `package.json` / README；`RELEASE=v1` 正式版）；`typecheck` 0 error；非浏览器回归链（含 `test:drop`、`test:crafting`）全绿；`python3 docs/agent/validate.py --strict` 0 FAIL / 0 WARN。浏览器实景组 `test:smoke` / `test:visual` / `test:options` 因本机无可用 Chromium 未执行（用户决定放弃），故未宣称 `npm run verify` 全绿。

## [1.5.2] - 2026-11-21

### 新增（整合自 AtomGit v1.6.0 植物扩充线）
- **画面调参**：收敛黄昏过曝、云体积化、树叶镂空与星空；属受控实验硬规则 #14 范围，已在 Release Notes 标注需在 CI 复核。
- **28 种新植物（内置 id 120~147 末位追加）**：温带花甸（薰衣草 / 金凤花 / 勿忘我 / 万寿菊 / 毛地黄 / 蜀葵 / 紫罗兰）、林下阴湿（林地银莲花 / 野蒜 / 风信子 / 常春藤 / 荧光苔）、雪线花卉（雪滴花 / 雪绒花 / 雪莲 / 番红花 / 高山龙胆）、沙漠旱生（丝兰 / 沙漠金盏 / 幽灵花）、海岸盐生（海滩草 / 海石竹）、水生（浮萍 / 海葵 / 红藻）、洞穴发光（月光花 / 荧光蕨）。
- **成片花圃与植被表现力**：`BIOME_PROFILES` 新增 `flowerBeds` 按群系生成同色系花团；植物高度分层、世界坐标风摆动画、新花卉像素贴图；新植物接入能量体系与随机刻（常春藤垂挂 / 浮萍铺水 / 发光植物暗处扩散）。
- **装备与掉落**：猪 / 羊新增皮革掉落，装备非堆叠拾取接入背包；插件 6 种植物 id 顺延 159~164（内置方块扩充后）（`lavender` 更名 `thistle`）。
- **展示资源**：首屏演示 GIF 换 animated WebP（6.5MB → 2.8MB），确立「大二进制不入库」规则。

### 修复（整合自 v1.5.1 收尾线）
- 冰面内部面剔除、竹子扩繁坐标、AABB 碰撞切向、音效缓冲 3s、输入脱困/触摸守卫、手柄映射、存档数值范围校验、光照缓存失效、Worker 重建配置下发。


## [1.5.2-beta.1] - 2026-11-21

### 新增
- **季节与天气**：`src/world/ecology.ts` 提供 6 日一季的纯函数历法与 seed 派生的天气；季节 / 天气倍率按 solar / hydro / fungal 三代谢调制正向蓄能与生长概率，默认 spring/clear 对旧行为逐值中性。`Sky` 新增 `dayCount` 与 `setTime`。
- **确定性掉落**：`src/world/drops.ts` 的 `rollDrops()` 替代玩家 / 实体掉落里的 `Math.random`，支持 chance / 数量区间 / 昼夜 / 群系条件；`DropSpec` 增 `min/max/nightOnly/biome`。
- **土壤养分 + 肥料**：`src/world/soil.ts` 懒初始化 100 的第二资源；`grow()` 成功才扣、枯萎 / 破坏归还；新增 `item:fertilizer`（+35 养分）与 `item:bone_meal`（+55 养分且 +15 能量），`plant:soil` 事件与 F3 `soilAvg` 观测。
- **堆肥桶**：9 个方块（id 110~118，末位追加），等级编码进 block id 借 `world.edits` 持久化；`src/world/compost.ts` 提供 `levelOf/nextId/harvestOf`；满级收肥、手持可堆肥物投放；`compost:change` 接入存档脏标记。
- **肥料来源**：猪 / 羊 12% 掉有机肥；新增骷髅怪（夜间生成，75% 掉骨粉）。
- **插件扩展点**：`PlantRuleContext` 增 `day/season/weather/soil/enrichSoil`；`PlantRule.priority` 按 `(priority, id)` 双键排序；内置 `core:botany-expansion` 加雨天补能演示规则。
- **生态状态存档**：`Botany.serializeEcology()/restoreEcology()`，紧凑元组、逐条校验、去重、分别截断 1024；`SaveData` 加可选 `botany/dayCount`，旧档兼容；修复柱状植物中间段被拆后锚点储能残留。

### 验证
- `typecheck` 0 error；`test:botany` 28/28、`test:plant-energy` 51/51、`test:botany-rules` 51/51、`test:logic` 9/9、`test:terrain-system` 49/49、`test:services` 55/55、`test:diagnostics` 28/28、`test:armor` 全绿（合并后）。

## [1.5.2-alpha.1] - 2026-11-21

### V2 预备工作

- **1.5.1 正式迭代版**：由预发布 `1.5.1-alpha.1` 转正，内容不变（PR #17 审查修复 / #18 实验性玩法 / #19 3D 优化）。
- **护甲插件化落地（v2.0 路线图第一支柱）**：
  - 新增管道语义扩展点 `combat:damage-incoming`（`ExtensionRegistry.reduce`，处理器可覆写伤害；
    错误隔离：抛错处理器被跳过，其余照常）与通知语义扩展点 `equipment:durability` 常量。
  - `SurvivalState` 伤害结算入口接入管道（可选注入 `extensions`，未注册处理器时零行为变化）。
  - 装备纯逻辑层自 WIP 快照 `8281895` 提炼落地：`EquipmentState`（4 甲槽 / 耐久 / 序列化对称 / 旧档清空）。
  - 新增内置插件 `core:armor`：每护甲点减伤 4%（20 点封顶 80%），受击扣甲耐久，
    状态经插件存储持久化，卸载后伤害路径与未安装完全一致。
  - 新增 `test:armor` 独立回归（12 组断言）。
- **设计文档**：`docs/DESIGN-V2-ARMOR.md`（护甲插件扩展点与 A2-1~A2-3 任务卡）、
  `docs/DESIGN-V2-MULTIPLAYER.md`（联机基础协作架构与协议草案：WebRTC 星型拓扑、
  `WELCOME` 全量同步 + `EDIT` 增量事件流，复用编辑差分模型与存档三态校验）。
- 已知限制：护甲穿戴 UI 与熔炉/烧炼（WIP E03）尚未迁移，分别由 A2-3 后续与 A2-4 卡承接。

## [1.5.2-alpha.1] - 2026-11-21

### 新增

- **护甲插件化（v2.0 路线图第一支柱）**：
  - 管道语义扩展点 `combat:damage-incoming`（`ExtensionRegistry.reduce`，处理器可依次覆写伤害，
    抛错处理器被隔离跳过）与通知语义扩展点 `equipment:durability` 常量。
  - `SurvivalState` 伤害结算入口接入管道（可选注入扩展注册表；无处理器注册时伤害路径零行为变化）。
  - 装备纯逻辑层：`EquipmentState` 管理 4 甲槽 / 背包装备耐久（`i:<id>` 键，不改背包结构），
    序列化对称、旧档无字段时清空不残留。
  - 内置插件 `core:armor`：每护甲点减伤 4%（20 点截断上限，减伤 80% 封顶），受击扣甲耐久；
    状态经插件存储持久化，插件卸载后伤害路径与未安装完全一致。
  - 新增 `test:armor` 独立回归（12 组断言）与快照构建入口覆盖装备源文件。

### 设计文档

- `docs/DESIGN-V2-ARMOR.md`：护甲插件扩展点设计与 A2-1~A2-3 任务卡。
- `docs/DESIGN-V2-MULTIPLAYER.md`：联机「基础协作」里程碑架构与协议草案（WebRTC 星型拓扑、
  `WELCOME` 全量同步 + `EDIT` 增量事件流，复用编辑差分模型与存档三态校验）。

## [1.5.1] - 2026-11-21

本迭代版整合三个开放 PR（#17 审查修复、#18 实验性玩法、#19 3D 优化）并在合并后统一审查修正；由预发布 `1.5.1-alpha.1` 收敛而来，内容不变。

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
