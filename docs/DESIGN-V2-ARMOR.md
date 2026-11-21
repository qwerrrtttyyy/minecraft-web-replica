# V2 设计：护甲 / 装备插件化

> 状态：设计稿（对应路线图 `docs/ARCHITECTURE.md` v2.0 行「护甲 / 联机，以插件形式实现，不新增 `main.ts` 事件接线」）。
> 本文承接已被回退的 WIP 快照 `8281895`（E01–E03），提炼其可复用部分并按插件约束重构。

## 1. WIP 快照（8281895）提炼：可复用与需重做

### 可直接复用（纯逻辑层，与 DOM/three.js 解耦，质量合格）

| 资产 | 内容 | 复用方式 |
|---|---|---|
| `src/player/equipment.ts` | 装备定义表：5 材质档位（wood/stone/iron/gold/diamond）× 剑/镐/斧/锹 + 4 材质盔甲；`EquipKind/EquipSlot/EquipmentDef` 数据模型 | 原样迁入插件数据层 |
| `src/player/equipmentState.ts` | `EquipmentState`：4 甲槽 + 背包耐久 Map（`i:<id>` 键，不改背包 `Map<key,count>` 结构）；穿戴/卸下/受击扣耐久/序列化对称；旧档兼容（无字段清空） | 原样复用，作为插件私有状态 |
| `src/player/smelting.ts` | 烧炼状态机：燃料热值表 + 配方表 + 自动续料 + `SmeltingHost` 宿主接口（与 crafting.ts 同构） | 原样复用（若 V2 收熔炉） |
| 减伤口径 | 每护甲点减伤 4%、上限 20 点（80%）；总伤害为「含徒手基础」口径 | 数值不变 |
| 事件 | `equipment:change` / `equipment:broken`（`GameEvents` 增量追加） | 保留事件名，作为兼容承诺 |
| 纹理注册约定 | `<前缀>_<槽位>` 命名 + 图集末位追加 | 保留 |

### 需按插件约束重做的部分（上次被回退的根因）

| WIP 中的做法 | 问题 | 插件化改造 |
|---|---|---|
| E02/E03 直接改 `src/player/player.ts`、`src/ui/*`、`src/main.ts`（+75 行接线） | 违反「不新增 `main.ts` 事件接线」；插件能力写死在组装根 | 改走 `PluginContext` + 扩展点，见 §2 |
| 装备状态作为核心存档字段直接进 `src/save/save.ts` | 核心存档承载插件数据，插件卸载后残档 | 插件私有状态走 `PluginService` 存储（`src/services/plugins/storage.ts`），核心存档不含装备字段 |
| 甲槽 UI 直接写 `src/ui/hud.ts` | UI 无插件化通道 | 插件通过自带 UI 面板挂载（复用设置页/合成面板同款挂载机制） |

## 2. 扩展点设计

现有 `ExtensionRegistry`（`src/services/plugins/extensions.ts`）是**通知语义**（handler 返回值被忽略），护甲减伤需要**管道语义**（伤害先经插件改写再落账）。因此：

### 2.1 新增两个核心侧扩展点（核心引擎提供，与具体插件无关）

```
combat:damage-incoming   管道语义：payload { amount, source, target }
                         处理器可返回 { amount } 覆写；按 priority 降序依次累加改写
equipment:durability     通知语义：payload { id, slot|null, durability, broken? }
                         核心在装备耐久变化时派发，供 UI/音效/成就类插件订阅
```

- `combat:damage-incoming` 落在 `src/player/survival.ts` 受伤结算入口，核心自身不注册处理器——**未装插件时伤害路径零行为变化**（与 WASM 实验开关同一哲学）。
- payload 类型放 `src/core/types.ts`，核心只知道「伤害可被改写」，不知道「护甲」存在。护甲逻辑 100% 在插件内。

### 2.2 内置插件 `armor`

`src/plugins/builtin/armor.ts`，manifest 声明依赖 `player`，职责：

1. 注册 `combat:damage-incoming` 处理器：读 `EquipmentState.armorPoints`（截断 20）→ `amount *= 1 - 0.04 * points`。
2. 受击后调用 `damageArmor()` 扣甲耐久，派发 `equipment:durability`。
3. 装备栏 UI：经 `PluginContext` 挂 HUD 装备槽与操作接口（不做 `main.ts` 接线）。
4. 存档：`serialize()/restore()` 走插件存储；卸载插件 → 状态随 owner 撤销，旧档打开不受影响。

### 2.3 验收判据

- 卸载 armor 插件后：伤害路径行为与 `1.5.1` 完全一致（可用 `?plugin=off` 或运行时开关对照，像素/数值零差异测试沿用 `test/experiment-3d.mjs` 的 A/B 方法论）。
- `main.ts` 与 `src/ui/**` 在 armor 插件的 `touch.allow` 之外（E02/E03 卡的 deny 列表这次对核心侧同样生效）。
- 新增 `test/armor-check.cjs`：定义表完整性、减伤曲线（0/10/20 点）、耐久损坏、存档往返、插件卸载零残留。

## 3. 里程碑切分（重做版任务卡）

| 卡 | 内容 | 对应 WIP |
|---|---|---|
| A2-1 | 定义表 + 纹理 + 物品条目（纯数据） | E01 基本复用 |
| A2-2 | `EquipmentState` + 存档走插件存储 + 事件 | E02 重构存储路径 |
| A2-3 | `combat:damage-incoming` 扩展点落地 + armor 插件 + UI 挂载 | E02/E03 接线全部重写 |
| A2-4 | （可选）熔炉/烧炼，同构改造 | E03 复用状态机 |
