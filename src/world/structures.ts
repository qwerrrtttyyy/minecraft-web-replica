/**
 * 静态结构模板（纯数据）：村庄小屋 / 废弃矿井 / 地牢。
 *
 * 本模块只描述形状、方块名、配色与放置参数，不 import three / World / DOM，
 * 也不产生随机性。DefaultGenerator 在构造时把方块名解析为 id，Worker 通过
 * blockIdSource(config.ids) 复刻同一份生成器即可逐位得到相同的结构。
 */

export type StructureKind = 'village_house' | 'mineshaft' | 'dungeon';

export interface StructureBlock {
  dx: number;
  dy: number;
  dz: number;
  block: string;
}

export interface StructurePalette {
  wall: string;
  floor: string;
  roof: string;
  accent: string;
  light: string;
}

export interface StructureTemplate {
  kind: StructureKind;
  width: number;
  height: number;
  depth: number;
  blocks: readonly StructureBlock[];
}

export const STRUCTURE_KINDS: readonly StructureKind[] = ['village_house', 'mineshaft', 'dungeon'];

const OAK: StructurePalette = {
  wall: 'oak_planks',
  floor: 'oak_planks',
  roof: 'oak_planks',
  accent: 'glass',
  light: 'torch',
};
const BIRCH: StructurePalette = {
  wall: 'birch_planks',
  floor: 'birch_planks',
  roof: 'birch_planks',
  accent: 'glass',
  light: 'torch',
};
const SPRUCE: StructurePalette = {
  wall: 'spruce_planks',
  floor: 'spruce_planks',
  roof: 'spruce_planks',
  accent: 'glass',
  light: 'lantern',
};
const ACACIA: StructurePalette = {
  wall: 'acacia_planks',
  floor: 'acacia_planks',
  roof: 'acacia_planks',
  accent: 'glass',
  light: 'torch',
};
const CHERRY: StructurePalette = {
  wall: 'cherry_planks',
  floor: 'cherry_planks',
  roof: 'cherry_planks',
  accent: 'glass',
  light: 'lantern',
};
const SANDSTONE: StructurePalette = {
  wall: 'sandstone',
  floor: 'smooth_sandstone',
  roof: 'sandstone',
  accent: 'glass',
  light: 'lantern',
};

/** 16 个陆地群系的村庄配色；ocean / beach 不生成村庄 */
export const STRUCTURE_PALETTES: Readonly<Record<string, StructurePalette>> = {
  plains: OAK,
  forest: OAK,
  jungle: OAK,
  swamp: OAK,
  mushroom_grove: OAK,
  bamboo_grove: OAK,
  dark_forest: OAK,
  birch_forest: BIRCH,
  taiga: SPRUCE,
  snowy_taiga: SPRUCE,
  alpine: SPRUCE,
  snowy_tundra: SPRUCE,
  savanna: ACACIA,
  cherry: CHERRY,
  desert: SANDSTONE,
  mesa: SANDSTONE,
};

export const MINE_PALETTE: StructurePalette = {
  wall: 'oak_planks',
  floor: 'cobblestone',
  roof: 'oak_planks',
  accent: 'gravel',
  light: 'glow_torch',
};
export const DUNGEON_PALETTE: StructurePalette = {
  wall: 'mossy_cobblestone',
  floor: 'stone_bricks',
  roof: 'stone_bricks',
  accent: 'bookshelf',
  light: 'lantern',
};

export const STRUCTURE_CELL: Readonly<Record<StructureKind, number>> = {
  village_house: 64,
  mineshaft: 96,
  dungeon: 80,
};
export const STRUCTURE_CHANCE: Readonly<Record<StructureKind, number>> = {
  village_house: 0.32,
  mineshaft: 0.24,
  dungeon: 0.28,
};
export const STRUCTURE_SALT: Readonly<Record<StructureKind, number>> = {
  village_house: 0x1d01,
  mineshaft: 0x1d02,
  dungeon: 0x1d03,
};
export const STRUCTURE_DEPTH: Readonly<Record<StructureKind, number>> = {
  village_house: 0,
  mineshaft: 12,
  dungeon: 9,
};

/** 无表群系（含插件新群系）回退橡木，不因缺色板跳过结构 */
export function paletteFor(biome: string): StructurePalette {
  return STRUCTURE_PALETTES[biome] ?? OAK;
}

/** 按种类与配色产出完整模板；同一输入总是同一输出 */
export function buildStructure(kind: StructureKind, palette: StructurePalette): StructureTemplate {
  const blocks: StructureBlock[] = [];
  const put = (dx: number, dy: number, dz: number, block: string) => {
    blocks.push({ dx, dy, dz, block });
  };

  if (kind === 'village_house') {
    for (let dz = 0; dz < 6; dz++) {
      for (let dx = 0; dx < 9; dx++) put(dx, 0, dz, palette.floor);
    }
    for (let dy = 1; dy <= 4; dy++) {
      for (let dx = 0; dx < 9; dx++) {
        for (const dz of [0, 5]) {
          // 正门中间两列留空；窗户用玻璃
          if (dz === 0 && dx === 4 && dy <= 2) continue;
          const window = dy === 2 && (dx === 2 || dx === 6);
          put(dx, dy, dz, window ? palette.accent : palette.wall);
        }
      }
      for (let dz = 1; dz < 5; dz++) {
        for (const dx of [0, 8]) put(dx, dy, dz, palette.wall);
      }
    }
    for (let dz = 0; dz < 6; dz++) {
      for (let dx = 0; dx < 9; dx++) put(dx, 5, dz, palette.roof);
    }
    for (let dx = 2; dx <= 6; dx++) put(dx, 6, 2, palette.roof);
    put(4, 3, 3, palette.light);
    put(7, 1, 3, 'furnace');
    put(1, 1, 3, 'crafting_table');
    put(6, 1, 4, 'bookshelf');
    return { kind, width: 9, height: 7, depth: 6, blocks };
  }

  if (kind === 'mineshaft') {
    for (let dz = 0; dz < 13; dz++) {
      for (let dx = 0; dx < 11; dx++) {
        put(dx, 0, dz, dx === 5 ? palette.accent : palette.floor);
      }
    }
    for (let dy = 1; dy <= 3; dy++) {
      for (let dz = 0; dz < 13; dz++) {
        put(0, dy, dz, palette.wall);
        put(10, dy, dz, palette.wall);
      }
      for (const dx of [2, 5, 8]) {
        put(dx, dy, 0, palette.wall);
        put(dx, dy, 12, palette.wall);
        put(dx, dy, 6, palette.wall);
      }
    }
    for (const dx of [2, 5, 8]) {
      for (let dz = 0; dz < 13; dz++) put(dx, 4, dz, palette.roof);
    }
    put(5, 3, 3, palette.light);
    put(5, 3, 9, palette.light);
    put(3, 1, 10, 'gravel');
    return { kind, width: 11, height: 5, depth: 13, blocks };
  }

  for (let dz = 0; dz < 9; dz++) {
    for (let dx = 0; dx < 9; dx++) put(dx, 0, dz, palette.floor);
  }
  for (let dy = 1; dy <= 3; dy++) {
    for (let dx = 0; dx < 9; dx++) {
      put(dx, dy, 0, palette.wall);
      put(dx, dy, 8, palette.wall);
    }
    for (let dz = 1; dz < 8; dz++) {
      put(0, dy, dz, palette.wall);
      put(8, dy, dz, palette.wall);
    }
  }
  for (let dz = 0; dz < 9; dz++) {
    for (let dx = 0; dx < 9; dx++) put(dx, 4, dz, palette.roof);
  }
  put(4, 3, 4, palette.light);
  put(1, 1, 1, palette.accent);
  put(7, 1, 7, palette.accent);
  put(7, 1, 1, 'furnace');
  put(1, 1, 7, 'crafting_table');
  return { kind, width: 9, height: 5, depth: 9, blocks };
}

/** 所有模板实际会发出的方块名，由模板推导，避免第二份手写清单漂移 */
export const STRUCTURE_BLOCK_NAMES: ReadonlySet<string> = new Set(
  STRUCTURE_KINDS.flatMap((kind) =>
    [...new Set([...Object.values(STRUCTURE_PALETTES), MINE_PALETTE, DUNGEON_PALETTE])].flatMap((palette) =>
      buildStructure(kind, palette).blocks.map((b) => b.block),
    ),
  ),
);
