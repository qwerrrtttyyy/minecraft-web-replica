/**
 * 装备定义表（纯数据层，不含状态与交互）。
 *
 * 武器 / 工具 / 盔甲的数值、显示名与纹理名集中在这里，供生存状态、
 * 战斗 / 挖掘接入与 UI 共同读取。命名约定（atlas 纹理注册依赖它）：
 * - 武器 / 工具：`<前缀>_<sword|pickaxe|axe|shovel|hoe>`
 * - 盔甲：`<前缀>_<helmet|chestplate|leggings|boots>`
 * - 前缀：wooden / stone / iron / golden / diamond / leather / copper（仅铜有 hoe）
 */

export type EquipKind =
  | 'sword'
  | 'pickaxe'
  | 'axe'
  | 'shovel'
  | 'hoe'
  | 'helmet'
  | 'chestplate'
  | 'leggings'
  | 'boots';

export type EquipSlot = 'head' | 'chest' | 'legs' | 'feet';
export type EquipMaterial = 'wood' | 'stone' | 'iron' | 'gold' | 'diamond' | 'leather' | 'copper';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel';

export interface EquipmentDef {
  /** 稳定 id，同时是 ITEMS 的 key 与 atlas tile 名 */
  id: string;
  label: string;
  tile: string;
  kind: EquipKind;
  material: EquipMaterial;
  /** 盔甲槽位（仅盔甲） */
  slot?: EquipSlot;
  /** 武器总伤害（含徒手基础，区别于原版的「额外伤害」口径） */
  attack?: number;
  /** 工具挖掘倍率（徒手为 1） */
  miningSpeed?: number;
  /** 护甲点数（每点减伤 4%，上限 20 点） */
  armor?: number;
  /** 耐久上限 */
  durability: number;
}

interface Tier {
  material: EquipMaterial;
  prefix: string;
  label: string;
  attack: number;
  miningSpeed: number;
  durability: number;
}

/** 剑 / 工具的材质档位（铜为末位追加的新种类，数值取石与铁之间） */
const TOOL_TIERS: Tier[] = [
  { material: 'wood', prefix: 'wooden', label: '木', attack: 4, miningSpeed: 2, durability: 59 },
  { material: 'stone', prefix: 'stone', label: '石', attack: 5, miningSpeed: 4, durability: 131 },
  { material: 'iron', prefix: 'iron', label: '铁', attack: 6, miningSpeed: 6, durability: 250 },
  { material: 'gold', prefix: 'golden', label: '金', attack: 4, miningSpeed: 12, durability: 32 },
  { material: 'diamond', prefix: 'diamond', label: '钻石', attack: 7, miningSpeed: 8, durability: 1561 },
  // 铜：数值取石与铁之间（挖掘 4→5→6，耐久 131→190→250），既有档位一字不改
  { material: 'copper', prefix: 'copper', label: '铜', attack: 5, miningSpeed: 5, durability: 190 },
];

const TOOL_KINDS: { kind: ToolKind; label: string }[] = [
  { kind: 'pickaxe', label: '镐' },
  { kind: 'axe', label: '斧' },
  { kind: 'shovel', label: '锹' },
];

interface ArmorMaterial {
  material: EquipMaterial;
  prefix: string;
  label: string;
  armor: Record<EquipSlot, number>;
  durability: Record<EquipSlot, number>;
}

const ARMOR_MATERIALS: ArmorMaterial[] = [
  {
    material: 'leather', prefix: 'leather', label: '皮',
    armor: { head: 1, chest: 3, legs: 2, feet: 1 },
    durability: { head: 55, chest: 80, legs: 75, feet: 65 },
  },
  {
    material: 'iron', prefix: 'iron', label: '铁',
    armor: { head: 2, chest: 6, legs: 5, feet: 2 },
    durability: { head: 165, chest: 240, legs: 225, feet: 195 },
  },
  {
    material: 'gold', prefix: 'golden', label: '金',
    armor: { head: 2, chest: 5, legs: 3, feet: 1 },
    durability: { head: 110, chest: 165, legs: 150, feet: 130 },
  },
  {
    material: 'diamond', prefix: 'diamond', label: '钻石',
    armor: { head: 3, chest: 8, legs: 6, feet: 3 },
    durability: { head: 396, chest: 592, legs: 528, feet: 429 },
  },
];

const ARMOR_KINDS: { kind: EquipKind; slot: EquipSlot; label: string }[] = [
  { kind: 'helmet', slot: 'head', label: '头盔' },
  { kind: 'chestplate', slot: 'chest', label: '胸甲' },
  { kind: 'leggings', slot: 'legs', label: '护腿' },
  { kind: 'boots', slot: 'feet', label: '靴子' },
];

function buildEquipment(): Record<string, EquipmentDef> {
  const out: Record<string, EquipmentDef> = {};
  for (const tier of TOOL_TIERS) {
    const sword = `${tier.prefix}_sword`;
    out[sword] = {
      id: sword, label: `${tier.label}剑`, tile: sword, kind: 'sword',
      material: tier.material, attack: tier.attack, durability: tier.durability,
    };
    for (const tool of TOOL_KINDS) {
      const id = `${tier.prefix}_${tool.kind}`;
      out[id] = {
        id, label: `${tier.label}${tool.label}`, tile: id, kind: tool.kind,
        material: tier.material, miningSpeed: tier.miningSpeed, durability: tier.durability,
      };
    }
  }
  // 铜锄：现有档位没有锄，只为铜单独补一件，其他材质结构保持不变
  out.copper_hoe = {
    id: 'copper_hoe', label: '铜锄', tile: 'copper_hoe', kind: 'hoe',
    material: 'copper', durability: 190,
  };
  for (const mat of ARMOR_MATERIALS) {
    for (const kind of ARMOR_KINDS) {
      const id = `${mat.prefix}_${kind.kind}`;
      out[id] = {
        id, label: `${mat.label}${kind.label}`, tile: id, kind: kind.kind,
        material: mat.material, slot: kind.slot,
        armor: mat.armor[kind.slot], durability: mat.durability[kind.slot],
      };
    }
  }
  return out;
}

export const EQUIPMENT: Record<string, EquipmentDef> = buildEquipment();

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

export function equipmentDef(id: string): EquipmentDef | undefined {
  return EQUIPMENT[id];
}

export function isEquipmentId(id: string): boolean {
  return equipmentDef(id) !== undefined;
}

/** 盔甲种类 → 槽位 */
export function slotOfKind(kind: EquipKind): EquipSlot | null {
  return kind === 'helmet' || kind === 'chestplate' || kind === 'leggings' || kind === 'boots'
    ? (kind === 'helmet' ? 'head' : kind === 'chestplate' ? 'chest' : kind === 'leggings' ? 'legs' : 'feet')
    : null;
}

/** 工具种类（剑返回 null） */
export function toolKindOf(kind: EquipKind): ToolKind | null {
  return kind === 'pickaxe' || kind === 'axe' || kind === 'shovel' ? kind : null;
}

/** 护甲减伤比例：每点 4%，上限 80% */
export function armorReduction(armor: number): number {
  return Math.min(0.8, Math.max(0, armor) * 0.04);
}

/**
 * 手持工具对某类方块的挖掘倍率。
 * 工具类别与方块类别不匹配、或手持非工具时返回 1（徒手速度）。
 */
export function miningSpeedFor(toolId: string | null | undefined, blockTool: string | undefined): number {
  if (!toolId || !blockTool) return 1;
  const def = equipmentDef(toolId);
  if (!def) return 1;
  return toolKindOf(def.kind) === blockTool ? (def.miningSpeed ?? 1) : 1;
}
