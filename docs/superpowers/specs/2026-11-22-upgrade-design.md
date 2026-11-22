# 简单 PRD — Minecraft Web 复刻四项升级设计

| 项 | 内容 |
|---|---|
| Language | 简体中文 |
| Programming Language | TypeScript + three.js（现有栈，不引入新运行时依赖） |
| Project Name | `minecraft_web_replica_four_upgrades_2026_11` |
| 仓库 / 基线 | `/workspace/minecraft-web-replica`，main HEAD `1f06d5e`，typecheck 0 error，verify 全绿 |
| 文档类型 | 简单 PRD（不含竞品 / 市场分析） |
| 原始需求 | ① 添加 4 种植物，各有生长特色；② 大幅优化总体性能并采取多种措施；③ 革新代码质量；④ 优化总体建模，提供总体性的 3D 优化（参考会话由主理人解析） |

**已拍板决策（本 PRD 不推翻、不再征求）**：4 种植物由团队自主设计、走插件扩展、id 165-168；3D 走现有 three.js 的务实增量优化，**不做** 9 模块分层重建；性能先统一顶点字节口径再逐项量化优化，每项带受控实验数据；验收三件套 = verify 全绿 + 实验前后数据 + 截图人工确认。

---

## 1. 产品目标

**一句话愿景**：在不更换引擎、不破坏既有存档与生态的前提下，让世界"长出四种会思考的植物"，并让渲染更快、代码更干净、画面更精致，且每一项改动都可被数据证明。

| 编号 | 目标 | 可量化判据 |
|---|---|---|
| G1 植物生态 | 新增 4 种机制正交的植物，填补现有生态位空白 | id 165-168 各 1 种；4 种生长机制两两不同；插件路径实现，**对 `blocks.ts` / `atlas.ts` / `plantTraits.ts` 零改动**；`botany` / `plant-energy` / `botany-rules` 三组全绿且新增 ≥12 条确定性断言 |
| G2 性能 | 统一口径后逐项落地多种可验证优化 | 顶点字节口径收敛为**单一来源**（现网 48 B → aLight 量化后 44 B 双档）；≥4 项优化各有 A/B 前后数据；每项像素签名噪声底 B→D = 0；至少 1 项端到端指标（帧率 / renderMs / 缓冲字节）可量化改善且无劣化项 |
| G3 代码质量 | 消除过期口径与失效闸门，让契约自动生效 | 5 处已知过期注释/闸门 100% 修复；代码中不再硬编码 44 / id 区间 / 规则条数；tsc strict 0 error、biome + eslint 0 warning；`npm run verify` 100% PASS |
| G4 3D 建模 | 在现有引擎上做可逐项验收的建模与画面改进 | ≥2 项可视改进落地（包围球剔除 + 植物几何/风摆细化）；`test:mesher` 等价断言全过；同视角前后截图经人工确认；不引入 9 模块内核重构 |

---

## 2. 用户故事

1. 作为玩家，我希望在森林里看到藤蔓沿石壁向上攀爬，而不是所有植物都贴地生长，这样世界更有层次。
2. 作为玩家，我希望寄生花会围着宿主生长、风信草顺风成片、日晷花随晨昏开合，这样我能从植物外观推断生态规律并获得采集回报。
3. 作为开发者，我希望新植物全部通过 `registerPlant` / `registerRule` 插件接口接入，这样我不用改内置方块表就能继续扩展第十一种植物。
4. 作为性能工程师，我希望每项优化都能用 `npm run test:experiment` 在同页 A/B 翻转并测出噪声底，这样"看起来更快"不会变成无法证实的口号。
5. 作为验收者，我希望用 verify 全绿、实验前后数据、同视角截图三件套判断交付质量，这样主理人和架构师可以快速逐项签字。

---

## 3. 四种新植物设计（重点）

**统一落地方式**：追加到 `src/plugins/builtin/botanyContent.ts` 的 `EXPANSION_PLANTS`（6 → 10，id 159-168），机制追加到 `EXPANSION_RULES`（4 → 8）；`botanyExpansion.ts` 现有循环自动注册方块/纹理/特性/规则与自然生成，**核心代码零分支改动**。四者分别占据「空间垂直轴 / 能量相互作用轴 / 传播方向轴 / 时间相位轴」，与已有 6 种插件植物及 82 种内置植物不重复。

| 名称 | id | 代谢 | 生长特色（一句话） | 群系 / 生成权重 | 采集 |
|---|---|---|---|---|---|
| 攀墙藤 `climbing_vine` | 165 | solar | 贴实心墙面向上攀援，越高越向光 | forest .006 / taiga .004 / plains .002 | `item:nectar` ×1 |
| 缢丝花 `parasite_bloom` | 166 | fungal | 从邻株吸取能量，宿主衰弱则停止 | forest .005 / taiga .003 | `item:glow_spore` ×1 |
| 风信草 `windseed_grass` | 167 | solar | 按当日风向定向传播，形成顺风条带 | plains .010 / beach .006 / alpine .004 | `item:wheat_seeds` ×1 |
| 日晷花 `sundial_flower` | 168 | solar | 晨蓄能 / 午成熟 / 昏播种 / 夜休眠 | plains .004 / forest .003 / alpine .003 | `item:nectar` ×2 |

- **生成权重安全**：追加在数组末尾，既有 6 种的命中区间不变；各群系累计权重上界为 forest .037 / beach .036 / plains .034 / alpine .019 / taiga .007（若 taiga 采用攀墙藤 .004 + 缢丝花 .003）、ocean .006，全部 ≤ `SPAWN_ROLL_CEILING = 0.04`，无需改闸门。
- **代谢分布**：新增后 solar 5 / hydro 2 / fungal 3，`botany-rules-check.cjs` 的"三类代谢都存在"断言仍成立。

### 3.1 攀墙藤（id 165）— 垂直攀援

- **Trait**：`solar, bloom 76, growthCost 16, shareRadius 2, sharePower 11, harvest item:nectar×1`，`shape: 'cross'`。
- **机制**：规则 `core:botany-expansion:climbing`。随机刻命中时，若水平四邻（`ctx.neighbors`）存在实心方块（`ctx.isSolid`）且 `ctx.canGrow(x, y+1, z, id)`、能量足够、`ctx.rng() ≤ 0.08`，则 `grow(x, y+1, z, id, 'grow')` 向上延伸；成功后 `boost` 自身 +2 表示"向光增益"。高度硬上限 `y ≤ ctx.surface(x,z) + 6`，无墙时退化为矮丛，不横向蔓延。
- **视觉**：16×16 逐像素——褐绿主茎、贴墙侧的小气生根、顶部两片亮叶；复用现有 `aSway`，摆幅随顶点高度从底部 0 渐变到顶部。
- **生态关系**：与内置 `vine` / `ivy`（地表蔓生）构成垂直分工，填充立面生态位；不侵占地面花草的生成格。
- **验收**：fake ctx 下"有墙+能量足→向上 grow"、"无墙→不 grow"、"到高度上限→不 grow"、同 seed 十次结果一致。

### 3.2 缢丝花（id 166）— 寄生吸取

- **Trait**：`fungal, bloom 70, growthCost 12, shareRadius 1, sharePower 6, harvest item:glow_spore×1`。
- **机制**：规则 `core:botany-expansion:parasitism`（priority 1，先于其他插件规则）。每 tick 以 ≤0.1 概率扫描水平邻格：若存在非自身、能量 > 15 的植物，则 `boost(宿主, -4)` 并 `boost(自身, +6)`；自身能量被上限 85 钳制，宿主 ≤15 时停止吸取并 `write(self, ..., 'decay')` 退回不开花的营养体；无宿主时能量不得越过 `bloom`。**这是生态系统中首个负相互作用**，与既有异花传粉 / 根系共享的互利关系形成对照。
- **视觉**：苍白缠绕茎 + 指向邻格的暗红吸器，花冠不对称环状；无宿主时花瓣闭合（用 decay 阶段的 tile 表达，不新增 shader）。
- **生态关系**：只在林下 / 针叶林阴暗处生成（`fungal` 天然避强光），不会摧毁既有花海——吸取有下限、有概率、有自限。
- **验收**：宿主 -4 / 自身 +6 的定点断言；宿主 ≤15 停止；无宿主时能量 ≤ bloom；不与 cross-pollination 规则相互放大（同格命中两条规则时结果确定）。

### 3.3 风信草（id 167）— 风向传播

- **Trait**：`solar, bloom 68, growthCost 14, shareRadius 2, sharePower 9, harvest item:wheat_seeds×1`。
- **机制**：规则 `core:botany-expansion:wind_dispersal`。纯函数 `windDirection(season, day)`：季节给基准方位（春东 / 夏南 / 秋西 / 冬北），`day % 3 !== 0` 时顺时针偏转一格；只在下风方向 1~2 格、`get(...) === 0` 且下方 `isSolid` 时 `grow(..., 'spread')`，概率 ≤0.05 且受 `ctx.season()` 的 growth 倍率调制。传播方向**不依赖 rng**，同日历必然同方向，玩家可推断。
- **视觉**：茎顶穗向固定一侧倾斜（`aSway` 单向偏移），叶片沿风向排列；成熟时穗头转浅金色。
- **生态关系**：与香蒲（水媒）、蓟（虫媒）形成传播策略对照；在平原与小麦相邻时形成田间杂草带，不挤占水生植物格。
- **验收**：同 `day/season` 风向恒定；只在下风格写入；换季后方向按函数改变；概率上限与确定性断言。

### 3.4 日晷花（id 168）— 昼夜节律

- **Trait**：`solar, bloom 84, growthCost 20, shareRadius 2, sharePower 12, harvest item:nectar×2`。
- **机制**：规则 `core:botany-expansion:circadian_phase`，按 `ctx.daylight` 分相执行且每 tick 最多一类动作：
  - 黎明 `0.15 ≤ daylight < 0.4`：`boost(self, +8)` 蓄能加成；
  - 正午 `daylight ≥ 0.7`：且能量 ≥ bloom 时才允许 `ripen` 到可采状态；
  - 黄昏 `0.25 ≤ daylight < 0.5`：低概率 ≤0.04 向邻格 `grow(..., 'spread')`；
  - 夜间 `daylight < 0.15`：休眠，不写世界、不 boost。
  与既有 `nocturnal-bloom`（夜间扩散）互补：一个严格昼间分相，一个夜间扩散。
- **视觉**：金色放射花瓣 + 深色花盘，外圈按相位绘制冷暖渐层（同一 16×16 tile 内）；昼夜明暗沿用现有光照与太阳色调，不新增材质或通道。
- **生态关系**：首个显式依赖 `ctx.day()` / `ctx.season()` 日历的植物，让 6 日/季的生态历法在画面上可感知；与向日葵（能量枢纽）共同构成白天供能高峰。
- **验收**：四个 daylight 窗口各只触发对应动作；阈值边界值（0.15 / 0.4 / 0.5 / 0.7）确定性；夜间零写入。

---

## 4. 需求池

| 优先级 | 编号 | 需求 | 验收标准 |
|---|---|---|---|
| **P0** | 1 | 4 种植物按 §3 落地（id 165-168，插件路径） | `EXPANSION_PLANTS` 6→10、id 159-168 唯一且 ≤255；三类代谢齐全；4 种机制各有 fake ctx 确定性测试；`blocks.ts`/`atlas.ts`/`plantTraits.ts` diff 为空 |
| P0 | 2 | 新增 4 条生态规则（总数 4→8），owner 统一 | 经 `registerRule` 注入；`plugins.disable/enable` 幂等；既有生态回归逐值不变；规则表按 `(priority,id)` 排序确定性 |
| P0 | 3 | 统一顶点字节口径 | 在 `meshTypes.ts` 定义唯一常量（`VERTEX_FLOATS=12` / `VERTEX_BYTES=48` / 量化后 44）；`docs/EXPERIMENTS.md`、`experiment-3d.mjs`、`mesher` 断言全部引用该来源；E1 闸门改为"基线 48 B / 量化后 44 B"双档 |
| P0 | 4 | aLight 量化 2 B → 1 B | 受控实验：顶点缓冲字节下降；像素差在判据内；噪声底 B→D = 0；不达标即回滚 |
| P0 | 5 | `injectLight` 降噪（每像素 8 次 `foliageNoise` hash） | 受控实验：同页 A/B；`renderMs` 不劣化；像素签名与对照一致或差异在判据内；噪声底 = 0 |
| P0 | 6 | `drainResults` 限流（消除单帧尖峰） | 每帧处理上限可配置（默认建议 4），`BACKLOG_LIMIT=24` 背压语义不变；所有过期代次正确回退 busy；无区块永久饥饿；p95 帧耗时有前后数据 |
| P0 | 7 | 包围球优化（避免每帧全顶点遍历） | 缓存每个 mesh 的 `boundingSphere`，配置重建时失效；剔除正确性断言（无可见物消失）；`renderMs` 前后数据 |
| P0 | 8 | 过期口径与失效闸门清理（5 处） | `botanyContent.ts:16-17`、`botanyExpansion.ts:16-18`/manifest 描述、`botany-rules-check.cjs` 头注、"3 条规则"、`test/experiment-3d.mjs:5` 与 `:521-522` 全部改为从单一来源派生；无硬编码残留 |
| P0 | 9 | 3D 建模增量改进 + verify | 4 种植物的像素纹理 / 十字面 / 风摆纳入现有管线；`test:mesher` 全过；`npm run verify` 100% PASS |
| **P1** | 10 | 植物图鉴（可切换面板，展示 10 种扩展植物特性与生长特色） | 不影响主流程；停用插件后图鉴条目标记不可用 |
| P1 | 11 | 实验开关统一调试面板（`?aa` / `?emerge` / 新开关） | 保留五步钉场景流程；新增开关可单独翻转 |
| P1 | 12 | `RuntimeDiagnostics` 新增不变量（id ≤255、规则 owner、顶点字节） | 各配 1 条注入式回归（`test/diagnostics-check.cjs`） |
| P1 | 13 | 实验原始数据归档策略 | `test/artifacts/experiment-3d.json` 不入库；汇总表进 `docs/EXPERIMENTS.md` |
| **P2** | 14 | 新增专属采集物品（须改 `survival.ts` 内置表） | 仅在待确认问题 Q1 获准后启动 |
| P2 | 15 | 移动端画质档位 / 触控图鉴入口 | 不降低 `test:smoke` 移动端断言 |
| P2 | 16 | 截图自动 diff 与 WebP 归档（`docs/assets/`） | 单文件 ≤1 MB，符合硬规则 15 |

---

## 5. UI / 交互设计

- **主流程不改**：4 种植物复用现有右键采集 / 破坏掉落交互，不新增按键与菜单层级。
- **可选 P1 图鉴**：HUD 叠加层按 `F` 开关，按 id 排序列出 10 种扩展植物；每条显示代谢类型、蓄能阈值、独特机制一句话；插件停用时置灰，避免"图鉴有、世界无"的困惑。
- **可选 P1 实验面板**：把 `?aa` / `?emerge` / 新优化开关集中显示当前档位与一致性闸门状态，供人工截图时确认 A/B 场景一致。
- **截图要求**：每种植物各 1 张生长阶段图；3D 优化前后同坐标、同相机、同时间（dayTime 0.32）对比图各 ≥1 组。

---

## 6. 范围边界与约束

**做**
- 插件路径追加植物与规则；统一顶点字节口径；4 项性能措施逐项受控实验；过期注释/闸门修复；现有 three.js 管线内的建模、网格、画面增量改进。

**不做**
- 不做参考会话的"9 模块分层重建 3D 内核"；不更换渲染引擎；不新增运行时依赖。
- 不改既有方块 id（1..164 全部冻结）、不改 6 日/季历法、不改 `TERRAIN_STAGES` 顺序、不改存档结构。
- 不改 Worker/主线程共享 `mesher.ts` 的快照契约；不手改 `test/logic/`、`test/terrain-logic/` 生成快照；不提交 >1 MB 二进制。
- 不做竞品/市场分析（本次用户未要求）。

**必须遵守的仓库硬规则摘要**（见 `AGENTS.md` / `docs/PROJECT-EXPERIENCE.md`）
1. 版本双轨单一来源（`version.ts`：日常只动 `VERSION`，`RELEASE` 仅发布推进）。
2. 方块 id **只追加**，1..255，`Uint8Array` 存储；同步 `terrain-system-check.cjs` 与 `docs/TESTING.md`。
3. 合成 / 地形规则进配置表（`CRAFTING_RECIPES` / `BIOME_PROFILES`），不散落分支。
4. 数据/渲染解耦：Worker 侧**禁止 import three / World / TextureAtlas**，共用 `mesher.ts`。
5. 注册方块/纹理后必须 `ChunkManager.invalidateConfig()` + `postConfig()`，判据 `chunks.configReady`。
6. 快照契约：`data/sky/block` 三张 `18×80×18` 同拷；Greedy mask key 含 `id|ao<<8|sky<<10|block<<14`；四角光照不等必须退回逐面。
7. 画面类改动必须做受控实验：同页翻转、先验场景一致、单测噪声底。
8. Worker 池构造失败整体回退主线程；插件权限最小声明；新增高风险不变量配注入式回归。

---

## 7. 验收口径（三件套，缺一不可）

1. **`npm run verify` 100% PASS** — 含版本、lint、tsc strict、单文件构建、快照编译、30+ 测试组以及浏览器实景 / 视觉回归；植物相关三组（`botany` / `plant-energy` / `botany-rules`）需含本 PRD 新增断言。
2. **受控实验前后数据** — 每项优化（aLight 量化 / injectLight 降噪 / drainResults 限流 / 包围球优化）按 `docs/EXPERIMENTS.md` 五步钉场景，用 `npm run test:experiment` 产出：帧率、`renderMs`、draw calls、triangles、逐通道顶点缓冲字节、像素签名 MAD、变化采样数；**B→D 噪声底必须为 0**，否则该项数据作废。E4-E8 已列出但未在本机执行，本次优化按 E9-E12 编号继续。
3. **截图人工确认** — 4 种新植物 + 3D 改动前后同视角截图，由主理人确认"画面有实质改进且无退化"后方可合并。

---

## 8. 待确认问题（不重复已拍板决策）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 4 种植物的采集物是否允许新增 item（需改 `survival.ts` 内置 `ITEMS` 表）？本 PRD 暂定**复用现有 key**（nectar / glow_spore / wheat_seeds），以保持"插件零内置改动"。 | 决定 P2-14 是否启动，以及 P0-1 的 diff 边界 |
| Q2 | 受控实验需要 Chromium + SwiftShader；此前 E4-E8 因本机无浏览器未执行。请确认架构师执行环境可跑 `npm run test:experiment`，否则 G2 的数据验收无法闭环。 | 阻塞 G2 验收 |
| Q3 | 人工确认截图存放在哪里？建议只入 `test/artifacts/`（不入库），精简对比图转 WebP 后放 `docs/assets/`（≤1 MB）。 | 影响 P2-16 与硬规则 15 的合规判断 |
