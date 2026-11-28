# 护甲穿戴闭环 + 工具档位 — 设计文档（草案）

> 状态：**已确认（2026-11-22）**，§6 四项决策均按推荐方案定稿；任务卡见 §7（`docs/agent/tasks/A2-5..A2-8`）。
> 定位：V2 路线图「护甲 / 联机」中**护甲支柱的收尾**（承接 [DESIGN-V2-ARMOR.md](../../../../DESIGN-V2-ARMOR.md) 与任务卡 A2-1~A2-4）。

---

## 0. 基线事实（已核实源码）

| 主题 | 现状 | 位置 |
|---|---|---|
| 装备数据 | 5 档工具（剑/镐/斧/锹）+ 4 材质盔甲，带 `attack / miningSpeed / armor / durability`；已有纯函数 `miningSpeedFor()`、`armorReduction()` | `src/player/equipment.ts` |
| 装备配方 | 36 条，工作台 3×3 可合成；装备不可堆叠（合成 UI 拦截第二件） | `src/player/crafting.ts:84-115`、`src/ui/crafting.ts:384` |
| 装备状态 | `EquipmentState`：4 甲槽、背包耐久 Map、`equip / unequip / damageArmor / damageHeld`、序列化对称 | `src/player/equipmentState.ts` |
| armor 插件 | 已注册 `combat:damage-incoming` 减伤 + `survival:damage` 后扣甲耐久 + `ctx.storage` 持久化 | `src/plugins/builtin/armor.ts`（44 行） |
| **断点 1：穿不上** | 全仓库没有任何 `equipment.equip()` 调用点，也没有甲槽 UI；右键盔甲会走 `eat()` 并因无 `food` 静默返回 | `src/player/player.ts:669-703` |
| **断点 2：工具无效** | 挖掘耗时恒为 `hardness * 1.1`，攻击伤害恒为 `3`；`miningSpeedFor()` 与 `def.attack` 无调用点；`initDurability / damageHeld` 无调用点（工具不掉耐久） | `player.ts:529,583,922` |
| **缺陷 3：存档跨世界串档** | `ctx.storage` 是全局 localStorage 命名空间，与世界无关：新建世界 / 导入存档后装备原样带过去；导出存档不含装备 | `src/services/plugins/storage.ts`、`main.ts:1071 newWorld` |
| **缺陷 4：护甲减免一切伤害** | 管道 payload 只有中文 `source` 串；摔落 / 溺水 / 饥饿也被减伤且每次都扣甲耐久（饥饿掉血会持续磨损盔甲） | `survival.ts:225-245`、`player.ts:404`、`survival.ts:312,346` |
| **缺陷 5：死亡不清甲** | `die()` 只清背包；关闭 keepInventory 死亡后盔甲仍在身上 | `survival.ts:250-263` |
| UI 扩展 | 插件只能经 `BuiltinDeps.hud` 调 HUD 的既有方法，没有「插件面板」与「HUD 锚点」通用机制 | `src/plugins/builtin/deps.ts` |
| 方块分类 | `BlockDefinition` 无工具类别 / 采集等级字段；有 `sound` 材质（stone / wood / dirt / sand / ...） | `src/world/blocks.ts:30-70` |

## 1. 意图 / Why

装备链现在「能合成、不能用」：玩家攒铁锭做出铁甲和铁镐，结果盔甲穿不上、镐子和空手一样慢。
本轮把这条链接通：**合成 → 穿戴 / 手持 → 生效（减伤 / 加速 / 加伤）→ 耐久消耗 → 损坏**，
同时修掉护甲插件已有的 3 个缺陷（串档、全伤害减免、死亡不清甲）。

## 2. 目标 / 非目标 / 反目标

**目标**
- 右键手持盔甲即可穿戴（同槽已有则互换）；甲槽面板可查看 / 卸下；HUD 显示护甲值。
- 工具按类别加速挖掘、剑按档位加伤；工具 / 剑 / 盔甲都有耐久且会损坏，快捷栏显示耐久条。
- 装备状态随**世界存档**走（导出 / 导入 / 新建世界都正确）。
- 护甲只减免「攻击类」伤害；死亡且未开 keepInventory 时清空甲槽。

**非目标**
- 附魔、铁砧修复、盔甲外观渲染到玩家 / 第一人称手臂模型。
- 生物穿甲、怪物掉落装备。
- 盾牌、弓箭、副手。

**反目标（做了就算失败）**
- 卸载（停用）`core:armor` / `core:tools` 后，伤害 / 挖掘 / 攻击行为与当前版本有任何数值差异。
- 在 `main.ts` 里新增护甲或工具专属的事件接线（DESIGN-V2-ARMOR 的核心约束）。
- 方块 id、图集既有 tile 索引变化；新增运行时依赖。
- 既有回归需要改断言才能绿。

## 3. 架构：核心只加「通用接口」，玩法全在插件

```
核心（一次性、与护甲/工具无关的通用接口）          插件（全部玩法）
──────────────────────────────────────          ─────────────────────────
survival.damage(amount, cause, iframes, kind)  ┐
  └─ combat:damage-incoming {amount,source,kind}├─→ core:armor  减伤 + 扣甲耐久
player.useSelected()                            │
  └─ player:use-item  {stack, handled}  ────────┼─→ core:armor  右键穿戴
player.mineTick()/tapBreak()                    │
  └─ player:mining    {block, toolId, time, harvest}─→ core:tools 挖掘倍率 / 采集等级
player.attack()                                 │
  └─ player:attack    {amount, toolId}  ────────┼─→ core:tools 剑伤害
  └─ notify player:used-tool {toolId, action} ──┼─→ core:tools 扣手持耐久
SaveData.plugins?: Record<id, unknown>          │
  └─ save:collect / save:restore（管道/通知）───┼─→ core:armor / core:tools 按世界持久化
PanelHost 服务 + HUD 锚点                        │
  └─ 暂停菜单按钮、hud 锚点、快捷栏格装饰 ───────┘─→ 甲槽面板 / 护甲条 / 耐久条
```

### 3.1 新增扩展点（`src/services/plugins/extensions.ts`）

| 扩展点 | 语义 | payload | 未注册处理器时 |
|---|---|---|---|
| `combat:damage-incoming`（扩充） | 管道 | 新增 `kind: DamageKind` | 不变 |
| `player:use-item` | 管道 | `{ stack, handled: false }`，处理器返回 `{ handled: true }` 即截断后续默认流程 | 走原 `useSelected` 流程 |
| `player:mining` | 管道 | `{ block, toolId, time, harvest: true }`，`time` 为核心算好的徒手耗时 | `time = hardness*1.1`、`harvest = true` |
| `player:attack` | 管道 | `{ amount, toolId }` | `amount = 3`（创造 999 不进管道） |
| `player:used-tool` | 通知 | `{ toolId, key, action: 'mine' \| 'attack' }` | 无 |
| `save:collect` / `save:restore` | 通知 | `{ data: Record<id, unknown> }` | 存档无 `plugins` 字段 |

`DamageKind = 'attack' | 'explosion' | 'fall' | 'drown' | 'starve' | 'other'`。
`survival.damage()` 新增可选第 4 参，缺省 `'other'`；调用方补参：实体攻击 `attack`、爆炸 `explosion`、
摔落 `fall`、溺水 `drown`、饥饿 `starve`、`CraftAPI.survival.damage` 维持 `other`。
`hurtPlayer(amount, cause)` 接口加可选 `kind`。改动是调用方补参，不是新增事件接线。

### 3.2 存档：插件数据袋 `SaveData.plugins?`

- `SaveData` 新增可选字段 `plugins?: Record<string, unknown>`（仿 `botany? / furnaces?` 先例，旧档缺省 = 空）。
- `collectSave()` 派发 `save:collect`，各插件把自己的数据写进 `data[ctx.id]`；读档时派发 `save:restore`。
- 核心只知道「有一袋插件数据」，不知道装备存在——满足 DESIGN-V2-ARMOR「核心存档不含装备字段」的本意，
  同时修掉 `ctx.storage` 全局串档。插件停用后其数据原样留在袋里、被忽略，重新启用可恢复。
- `validateSave`：`plugins` 必须是普通对象（非数组 / null），内容不校验（由插件自己 `restore` 做三态容错）。
- **迁移**：armor 首次 restore 时若袋里无数据而旧 `ctx.storage('equipment')` 有值，搬进当前世界并删除旧键（一次性）。

### 3.3 通用 UI 接口：`PanelHost`（`src/services/ui/PanelHost.ts`）

一次性加在核心，后续插件（联机房间面板等）可复用：

- `panels.register({ id, label, root, onShow?, onHide?, survivalOnly? })`：暂停菜单「工作台」旁自动出现按钮；
  打开 / 关闭复用组装根现有的面板状态机（`input.reset()`、指针锁、返回菜单），与合成面板同一路径。
- `hud.anchor('above-hotbar-left' | 'above-hotbar-right')`：返回 HUD 内一个空容器，供插件挂护甲条。
- `hud.decorateSlot(fn)`：快捷栏每次重绘后回调 `(slotEl, stack) => void`，供插件画耐久条。

这是本轮唯一需要动 `src/ui/hud.ts` 与 `main.ts` 的部分，且只做通用接口（见 §6 决策 1）。

## 4. core:armor（扩充现有插件）

| 功能 | 规则 |
|---|---|
| 右键穿戴 | `player:use-item`：手持盔甲 → 从背包扣 1 件、`equip(slot)`；同槽已有则旧甲（带耐久）退回背包。创造模式不处理（`addItem` 本就拒绝） |
| 甲槽面板 | 4 格（头 / 胸 / 腿 / 脚），显示图标 + 耐久条；点击已穿 → 卸下回背包（背包已有同种装备则提示「背包已有该装备」不卸） |
| 护甲条 | `above-hotbar-left` 锚点，10 个半格图标（原版口径：每 2 点 1 格）；0 点时隐藏 |
| 减伤范围 | 仅 `kind ∈ {attack, explosion}` 进减伤与扣耐久；`fall / drown / starve / other` 直通 |
| 扣耐久 | 每次被减伤的受击，各已穿甲槽扣 `max(1, floor(原伤害/4))`（原版口径） |
| 死亡 | `survival:death` 且 `keepInventory=false` → 清空甲槽与背包耐久表 |
| 持久化 | 改走 §3.2 插件数据袋；`EquipmentState.serialize/restore` 原样复用 |

## 5. core:tools（新内置插件 `src/plugins/builtin/tools.ts`）

### 5.1 工具规则表（插件内纯数据，`src/player/toolRules.ts`）

核心方块定义**不加字段**；插件按 `sound` 材质推断 + 少量按名覆写：

| 推断 | 工具 | 例 |
|---|---|---|
| `sound: 'stone'` | 镐 | 石头、圆石、矿石、石砖、黑曜石 |
| `sound: 'wood'` | 斧 | 原木、木板、工作台、南瓜灯 |
| `sound: 'dirt' \| 'sand'` | 锹 | 泥土、草方块、沙子、沙砾、黏土 |
| 其他（植物 / 羊毛 / 玻璃 …） | 无 | 徒手即可 |

采集等级（`harvestTier`，0 木 / 1 石 / 2 铁 / 3 钻石）只覆写需要的方块：
铁矿石 / 铜矿石 / 青金石 ≥ 石镐；金矿石 / 钻石 / 绿宝石 / 红石矿石 ≥ 铁镐；黑曜石 ≥ 钻石镐；
其余 `sound: 'stone'` 方块需「任意镐」。

### 5.2 挖掘与攻击

| 情况 | 挖掘耗时 | 掉落 |
|---|---|---|
| 方块不需要工具 | 不变（`hardness*1.1`），对口工具再 `/ miningSpeed` | 正常 |
| 需要镐、手持达标镐 | `hardness*1.1 / miningSpeed` | 正常 |
| 需要镐、未达标 | `hardness*1.1 * 3.3`（原版 5/1.5 比例） | **无掉落**（见 §6 决策 2） |

- 剑：`player:attack` 把 `amount` 改成 `def.attack`（木 4 / 石 5 / 铁 6 / 金 4 / 钻 7）；非剑工具不改伤害。
- 耐久：`player:used-tool` → `damageHeld(key, 1)`；工具用来打怪 / 剑用来挖方块扣 2；损坏时移除背包物品并播放破碎音效 + toast。
- 首次获得装备时 `initDurability`（订阅 `inventory:change`，键为 `i:<装备id>` 且计数从 0→1）。
- 快捷栏耐久条：`hud.decorateSlot`，满耐久不画，<25% 变红。

## 6. 决策（已确认）

1. **允许为通用 UI 接口动一次 `src/ui/hud.ts` / `main.ts`** —— ✅ 已确认允许（仅 A2-5，限通用接口）
   A2-3 卡把 `src/ui/**` 列为 deny；但没有通用挂载点，插件只能自己往 `document.body` 塞 DOM 并自行抢输入状态机，
   与合成面板行为不一致。推荐一次性加 PanelHost / 锚点 / 格装饰三个**与护甲无关**的接口，此后护甲 / 工具 / 联机插件都不再动 UI 层。
2. **未达标工具挖矿不掉落** —— ✅ 已确认：默认开启，受「实验性玩法」开关 `requireCorrectTool` 控制
   这是玩法上最大的变化：开局要先撸木头 → 木镐 → 才能拿到圆石。开关关闭时只保留加速、不做采集限制。
3. **护甲减伤口径** —— ✅ 已确认维持「每点 4%、上限 80%」（已有回归锁定），不引入原版韧性公式
4. **版本号** —— ✅ 已确认：A2-8 推进 `VERSION = 1.5.5`；`RELEASE` 维持 `v1`，等联机 M3 完成后再推进到 `v2`

## 7. 任务卡切分

| 卡 | 内容 | touch 重点 | 验收 |
|---|---|---|---|
| [A2-5](../../../../agent/tasks/A2-5-core-hooks.yaml) | 核心通用接口：`DamageKind`、5 个扩展点、`SaveData.plugins?` + `save:collect/restore`、PanelHost / 锚点 / 格装饰 | `survival.ts`、`player.ts`、`extensions.ts`、`save.ts`、`hud.ts`、`main.ts`（仅通用接线） | 无插件注册时伤害 / 挖掘 / 攻击数值与当前**逐项相等**（新增 `test/hooks-check.cjs`）；旧档 / 新档 `validateSave` 往返 |
| [A2-6](../../../../agent/tasks/A2-6-armor-closure.yaml) | core:armor 闭环：右键穿戴、甲槽面板、护甲条、伤害类型过滤、死亡清甲、数据袋持久化 + 旧 storage 迁移 | `plugins/builtin/armor.ts`、`armorPanel.ts` | `armor-check` 扩到：穿戴互换 / 类型过滤 / 死亡清甲 / 串档修复 / 迁移 / 停用零残留 |
| [A2-7](../../../../agent/tasks/A2-7-tools-plugin.yaml) | core:tools：规则表、挖掘倍率、采集等级、剑伤害、手持耐久、耐久条、`requireCorrectTool` 开关 | `player/toolRules.ts`、`plugins/builtin/tools.ts`、`core/options.ts` | 新增 `test/tools-check.cjs`：全方块都有规则归属 / 倍率 / 采集等级 / 耐久损坏 / 停用零差异 |
| [A2-8](../../../../agent/tasks/A2-8-armor-tools-release.yaml) | 浏览器实景 + 文档 + 版本 1.5.5 | `test/survival-smoke.mjs`、README / CHANGELOG / TESTING / ARCHITECTURE | smoke：合成铁甲 → 右键穿戴 → 僵尸攻击伤害下降；木镐挖石头掉圆石、空手不掉；`npm run verify` 全绿 |

A2-5 是前置；A2-6 与 A2-7 互不依赖可并行；A2-8 收尾并推进版本。
`docs/agent/validate.py` 已为四张卡的 outputs 加阶段 A 检查（关键词在卡中声明），各实现卡落地时收紧为真实符号检查。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 「无插件零差异」被无意破坏 | `hooks-check` 在无处理器时逐项比对徒手耗时 / 伤害 / 攻击数值；既有 `armor-check` 卸载用例保留 |
| `requireCorrectTool` 让老存档玩家突然挖不到矿 | 开关可关；首次进入生存且背包无镐时 toast 一次提示 |
| 存档体积 | 装备数据 < 1KB；`plugins` 袋只存启用插件写入的键 |
| 管道处理器抛错 | 沿用 `reduce` 的错误隔离（已有回归覆盖） |
