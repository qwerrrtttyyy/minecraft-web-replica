# 设计：11 → 18 群系扩展（零新方块）

日期：2026-11-22
状态：定稿（仅设计 / 任务卡，不含实现）
工作规模：中等（`generator.ts` + `botanyContent.ts` + 两组测试）

## 意图与原因

世界已经足够漂亮，但 `BIOME_PROFILES` 只有 11 个群系，气候空间里留着湿热、寒冷平坦、真菌、竹林等明显空位。本轮把群系扩到 18 个，让探索更有惊喜，同时让 botany 生态随新群系连贯变化。

约束来自已确认的决策：**0 个新方块 id / 0 个新图集 tile**，全部靠现有方块的表层/填充/植物/树种组合做区分；**botany 只补 6 个既有插件植物的 spawn 权重**，不加新植物或品系。

## 基线事实（已核实源码）

| 主题 | 现状 | 位置 |
|---|---|---|
| 群系枚举 | `BiomeId` 恰好 11 项，`BIOME_PROFILES` 逐项配置 | `src/world/generator.ts:20-22,131-327` |
| 气候输入 | `t = clamp(0.5 + temperature.fbm2(x/300+17,z/300-29,3)*1.15 + jitter,0,1)`、`m` 同理（`humidity` 尺度 240）、`alt = smoothstep(46,60,height)` | `generator.ts:602-609` |
| 级联规则 | 11 条有序短路，末尾 `forest (m>0.56)` / `plains (else)` 为宽泛兜底 | `generator.ts:611-626` |
| 树密度 | `DEFAULT_TERRAIN.treeDensity` 逐群系概率；缺 key 视为不生成树 | `generator.ts:58-73` |
| 可达性测试 | seed 777、x/z ∈ [-112,112) step 4，断言 4 个群系有地表实例 | `test/terrain-system-check.cjs:244-252` |
| 配置表断言 | 11 个群系全部有 profile；所有引用的方块名必须 `reg.byNameGet` 命中 | `test/terrain-system-check.cjs:190-236` |
| 插件植物 | 6 种 `EXPANSION_PLANTS` id 159~164，各带 `spawn: Partial<Record<BiomeId,number>>` | `src/plugins/builtin/botanyContent.ts:26-50,50-128` |
| 方块储备 | `snow`/`ice`/`podzol`/`bamboo`/`moss_carpet`/`ivy`/`glow_moss`/`red_mushroom`/`birch_leaves`/`spruce_leaves` 等全部已注册 | `src/world/blocks.ts` |
| 树种 | `TreeSpecies = 'oak' \| 'birch' \| 'spruce' \| 'acacia' \| 'cherry'` | `src/world/trees.ts:9` |

## 目标 / 非目标 / 反目标

**目标**

- 新增 7 个群系：`jungle`、`snowy tundra`、`mushroom grove`、`bamboo grove`、`dark forest`、`birch forest`、`snowy taiga`（总数 18）。
- 每个新群系在 `BIOME_PROFILES` 有完整、可渲染、可测试的配置，视觉上彼此及与旧群系可区分。
- 确定性、seed 派生、生成阶段顺序完全不变；7 个新群系按既有验收口径可达。
- 6 个既有插件植物在新群系里有合理 spawn 权重。

**非目标**

- 不新增方块 id / 图集 tile / 树种；不改 `blocks.ts`、`atlas.ts`、`trees.ts`。
- 不新增植物、品系、杂交组合；不改 `plantTraits.ts` / `plantStrains.ts` / `botany.ts` 的能量模型。
- 不碰 mesher / worker / 存档 / DOM / 版本号。

**反目标（做了就算失败）**

- 为凑可达性去改气候噪声阈值或故意缩小旧群系的判定谓词。
- 把地形规则散进 `if (biome === ...)` 而不是写进配置表。
- 新增任何 `Math.random`。

## 约束

- 群系是**末尾追加**：`BiomeId` 只能在 union 末尾加 7 项，既有 11 项顺序不变（存档/诊断对 biome 名是字符串，但仍禁止重排）。
- 地形规则一律进 `BIOME_PROFILES`；`treeDensity` 逐群系补齐。
- `TERRAIN_STAGES = ['columns','ores','trees','decorate']` 顺序契约不变。
- 0 新方块 id、0 新 tile：profile 引用的每个名字必须已在注册表存在。
- 生成层无 DOM；所有随机沿用 seed 派生的 Noise / rng。
- 先红后绿；每卡 `npm run test:snapshot` 必须先于任何 require 快照的测试。

## 群系清单（精确配置）

`BiomeId` 末尾追加顺序：`| 'jungle' | 'snowy_tundra' | 'mushroom_grove' | 'bamboo_grove' | 'dark_forest' | 'birch_forest' | 'snowy_taiga'`。

| id | surface / filler | plants（权重） | trees | treeDensity |
|---|---|---|---|---|
| `jungle` | `grass` / `dirt` | `bamboo` .03, `tall_fern` .02, `vine` .012, `fern` .01, `moss_carpet` .02 | `oak` 1 | 0.38 |
| `snowy_tundra` | `snow` / `dirt` | `snowdrop` .01, `edelweiss` .008, `snow_lily` .006 | 无 | 0 |
| `mushroom_grove` | `grass` / `dirt` | `red_mushroom` .02, `brown_mushroom` .02, `moss_carpet` .04, `glow_moss` .02, `ivy` .004 | `oak` 1 | 0.18 |
| `bamboo_grove` | `grass` / `dirt` | `bamboo` .06, `tall_grass` .03, `sugar_cane` .01, `vine` .01 | 无 | 0 |
| `dark_forest` | `grass` / `dirt` | `ivy` .006, `moss_carpet` .03, `red_mushroom` .008, `brown_mushroom` .008, `fern` .012 | `oak` .7 / `birch` .3 | 0.45 |
| `birch_forest` | `grass` / `dirt` | `fern` .015, `tall_grass` .03, `azure_bluet` .008, `lily_of_the_valley` .006 | `birch` 1 | 0.4 |
| `snowy_taiga` | `podzol` / `dirt` | `snowdrop` .01, `lingonberry_bush` .012, `fern` .02, `tall_fern` .02 | `spruce` 1 | 0.3 |

附加配置：`snowy_tundra` / `snowy_taiga` 配 `flowerBeds`（snowdrop/edelweiss/snow_lily 与 snowdrop/lingonberry）；`mushroom_grove` / `dark_forest` / `snowy_taiga` 配 `cavePlants` + `caveChance`（沿用 forest 的 4 项权重表，总和 1）；`jungle` / `bamboo_grove` 的 `caneChance` 分别 0.03 / 0.04；其余 `clayChance`/`cactusChance` 为 0。所有 `flowerBeds.plants` 与 `cavePlants` 权重总和 ≤ 1。

## 级联插入（精确规则 + 抢占台账）

**不缩旧域的含义**：既有 11 条规则的谓词与相对顺序**一字不改**；新规则只插在它们之间。由于级联是穷举的，新群系必然从某些旧群系取走格子——台账逐条列出被抢占者及理由。优先从宽泛兜底域（`forest` / `plains`）细分；只有两个雪地群系从 `taiga` 取走部分低温格，这是可接受的（taiga 仍占中温/中湿区间）。

`base()` 新顺序（`S` = SEA_LEVEL = 30）：

1. `height < S` → ocean（不变）
2. `height <= S+1` → beach（不变）
3. `m > 0.62 && t >= 0.30 && t <= 0.62 && height <= S+8` → swamp（不变）
4. `alt > 0.55 || (t < 0.2 && height > 50)` → alpine（不变）
5. **新** `t < 0.30 && m < 0.40 && height <= S+12` → snowy_tundra
6. **新** `t < 0.20 && m >= 0.40 && height <= 50` → snowy_taiga
7. `t < 0.3` → taiga（不变）
8. `t > 0.68 && m < 0.28` → mesa（不变）
9. `t > 0.68 && m < 0.45` → desert（不变）
10. `m >= 0.60 && m < 0.70 && t >= 0.40 && t <= 0.68` → cherry（不变）
11. **新** `t > 0.68 && m >= 0.62 && m < 0.78` → jungle
12. **新** `t > 0.60 && t <= 0.68 && m > 0.70 && height <= S+16` → bamboo_grove
13. **新** `t >= 0.30 && t <= 0.60 && m > 0.70 && height <= S+20` → mushroom_grove
14. **新** `t >= 0.30 && t <= 0.55 && m > 0.56 && m <= 0.70 && height <= S+24` → dark_forest
15. **新** `t >= 0.30 && t <= 0.55 && m > 0.45 && m <= 0.56 && height <= S+24` → birch_forest
16. `t > 0.6 && m >= 0.45 && m < 0.62` → savanna（不变）
17. `m > 0.56` → forest（不变）
18. else → plains（不变）

抢占台账：

| 新规则 | 原本落到 | 理由 |
|---|---|---|
| snowy_tundra | taiga | 寒冷干燥低地本应是苔原，taiga 保留中湿低温格 |
| snowy_taiga | taiga | 最冷且较湿的格改为积雪针叶林，taiga 保留 `0.20 ≤ t < 0.30` |
| jungle | forest | `t>0.68 && m≥0.62` 是湿热阔叶林，原 forest 兜底过宽 |
| bamboo_grove | forest | cherry 湿度带以上（`m>0.70`）的暖区，cherry 自身谓词不变且优先 |
| mushroom_grove | forest | `m>0.70` 的温和高地；低海拔高湿仍归 swamp（规则 3 在前） |
| dark_forest | forest | cherry 带之外的中温高湿林；cherry 谓词不变且优先 |
| birch_forest | plains | `m∈(0.45,0.56]` 的温和格从 plains 细化 |

所有 11 条旧规则的文本与顺序保持原样；台账在 spec 与代码注释里各留一份。

## 可达性验收

- 沿用 `test/terrain-system-check.cjs:244-252` 的循环：seed 777，`x=-112..112 step 4`、`z=-112..112 step 4`，`gen.biomeAt(x,z)` 收集。
- 断言集合从 4 个扩展到 **18 个**（旧 11 + 新 7）全部出现。
- 若某个新群系在 seed 777 的 ±7 区块内不可达：**先扩大采样半径到 ±12 或增加 seed 2026/1234，并把实际半径/种子写进测试名与 spec**；不改气候阈值或级联条件去硬凑。

## botany 联动（只补 spawn 权重）

在 `EXPANSION_PLANTS` 各项的 `spawn` 里新增下列键（既有键不动）：

| 植物 | 新增权重 |
|---|---|
| thistle (159) | jungle .006, bamboo_grove .004, dark_forest .004, birch_forest .004, mushroom_grove .003 |
| cattail (160, nearWater) | jungle .008, bamboo_grove .012, mushroom_grove .006 |
| glow_mushroom (161) | mushroom_grove .012, dark_forest .008, jungle .005, snowy_taiga .004, birch_forest .003 |
| frost_bloom (162) | snowy_tundra .014, snowy_taiga .008 |
| ember_fern (163) | jungle .006, dark_forest .006, bamboo_grove .004, mushroom_grove .005 |
| moonlotus (164, nearWater) | jungle .006, bamboo_grove .006, mushroom_grove .004 |

不新增 id（仍止于 164），不改 `trait` / `EXPANSION_RULES` / `botanyExpansion.ts`。

## 测试计划（先红后绿）

- `test/terrain-system-check.cjs`：群系数 11→18；每个新群系 profile 存在；所有引用方块名可解析；新群系地貌特征（snowy_tundra.surface==='snow'、bamboo_grove.plants 含 bamboo 等）；`treeDensity` 键齐全；可达性集合扩到 18。
- `test/botany-rules-check.cjs`：6 个插件植物在指定新群系的 spawn 权重逐值断言；id 上限仍 164。
- 既有 `test:mesher` / `test:botany` / `test:plant-energy` / `test:crossbreed` 不得回归。

## 验收清单

- [ ] `npm run typecheck` / `npm run build` 绿
- [ ] `npm run test:snapshot && npm run test:terrain-system` 绿（18 群系 + 可达性）
- [ ] `node test/botany-rules-check.cjs` 绿（spawn 权重）
- [ ] `npm run test:mesher && npm run test:mobile` 绿（无回归）
- [ ] 完整 `npm run verify` 照跑一次，浏览器步骤失败如实记录（本机无可用 Chromium）
- [ ] `docs/EXPERIMENTS.md` / `CHANGELOG.md` / `validate.py` 由合并集成步骤处理，本线不改
