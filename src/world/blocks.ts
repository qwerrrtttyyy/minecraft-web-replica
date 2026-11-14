import type { BlockId } from '../core/types';

/** 方块音效材质（扩展点：新方块可声明自己的音效类别） */
export type SoundMaterial = 'stone' | 'dirt' | 'wood' | 'sand' | 'glass' | 'cloth' | 'liquid' | 'plant';
export type BlockShape = 'cube' | 'cross';

/**
 * 掉落规则：name 可以是方块名、物品名（'item:apple'），'self' 表示掉落自身。
 * 生存模式破坏方块时按顺序判定概率，可掉落多项。
 */
export interface DropSpec {
  name: string;
  /** 0~1，默认 1 */
  chance?: number;
  /** 数量，默认 1 */
  count?: number;
}

export interface BlockDefinition {
  id: BlockId;
  /** 程序名（API 注册用，唯一） */
  name: string;
  /** 显示名（HUD） */
  label: string;
  shape: BlockShape;
  /** 是否参与碰撞 */
  solid: boolean;
  /** 是否完全遮光（用于面剔除与环境光遮蔽） */
  opaque: boolean;
  /** 非遮光方块是否剔除与自身同材质的相邻面（树叶等，减少内部面） */
  cullSame?: boolean;
  /** 液体：可游泳穿过，不可被准星选中 */
  liquid: boolean;
  /** 是否走透明渲染通道（水、玻璃） */
  transparentPass: boolean;
  /** 自发光强度 0~15（走独立高亮通道，夜晚不暗） */
  lightEmission: number;
  /** 硬度：生存模式挖掘耗时 ≈ hardness * 1.1 秒（徒手），Infinity 不可破坏 */
  hardness: number;
  sound: SoundMaterial;
  /** 三个面使用的纹理名（atlas 中注册） */
  tiles: { top: string; bottom: string; side: string };
  /** 生存模式掉落表，缺省掉落自身 */
  drops: DropSpec[];
}

export type BlockInput = Omit<BlockDefinition, 'id' | 'drops'> & {
  id?: BlockId;
  drops?: DropSpec[];
};

export const AIR: BlockId = 0;

/** 数组快通道的最大 id；更大的自定义 id 回退到 Map，避免稀疏大数组 */
const FAST_ID_LIMIT = 65536;

/**
 * 方块注册表（扩展点：CraftAPI.registerBlock）。
 * 所有 gameplay 与渲染都通过注册表查询方块属性，不硬编码 id。
 */
export class BlockRegistry {
  private byId = new Map<BlockId, BlockDefinition>();
  private byName = new Map<string, BlockDefinition>();
  private nextId = 1;
  /** 稠密 id → 定义：热路径（物理 / 射线 / 网格配置）避免 Map 查找 */
  private byIdArr: (BlockDefinition | undefined)[] = [];
  /** 预计算标志位，isOpaque/isSolid 只读一个字节 */
  private opaqueFlags = new Uint8Array(64);
  private solidFlags = new Uint8Array(64);

  readonly air: BlockDefinition = {
    id: AIR, name: 'air', label: '空气', shape: 'cube', solid: false, opaque: false,
    liquid: false, transparentPass: false, lightEmission: 0, hardness: 0, sound: 'dirt',
    tiles: { top: '', bottom: '', side: '' }, drops: [],
  };

  constructor() {
    this.byId.set(AIR, this.air);
    this.byName.set('air', this.air);
    this.byIdArr[AIR] = this.air;
  }

  private ensureFlagCapacity(id: number) {
    if (id < this.opaqueFlags.length) return;
    let n = this.opaqueFlags.length;
    while (n <= id) n <<= 1;
    const opaque = new Uint8Array(n);
    opaque.set(this.opaqueFlags);
    this.opaqueFlags = opaque;
    const solid = new Uint8Array(n);
    solid.set(this.solidFlags);
    this.solidFlags = solid;
  }

  register(input: BlockInput): BlockDefinition {
    if (this.byName.has(input.name)) throw new Error(`方块名重复: ${input.name}`);
    const id = input.id ?? this.nextId;
    if (this.byId.has(id)) throw new Error(`方块 id 重复: ${id}`);
    const def: BlockDefinition = { ...input, id, drops: input.drops ?? [{ name: 'self' }] };
    this.byId.set(id, def);
    this.byName.set(def.name, def);
    if (id >= 0 && id < FAST_ID_LIMIT) {
      this.ensureFlagCapacity(id);
      this.byIdArr[id] = def;
      this.opaqueFlags[id] = def.opaque ? 1 : 0;
      this.solidFlags[id] = def.solid ? 1 : 0;
    }
    if (id >= this.nextId) this.nextId = id + 1;
    return def;
  }

  get(id: BlockId): BlockDefinition {
    if (id >= 0 && id < FAST_ID_LIMIT) {
      const fast = this.byIdArr[id];
      if (fast) return fast;
    }
    return this.byId.get(id) ?? this.air;
  }

  byNameGet(name: string): BlockDefinition | undefined {
    return this.byName.get(name);
  }

  all(): BlockDefinition[] {
    return [...this.byId.values()].filter((b) => b.id !== AIR);
  }

  isOpaque(id: BlockId): boolean {
    if (id >= 0 && id < this.opaqueFlags.length) return this.opaqueFlags[id] === 1;
    return this.get(id).opaque;
  }

  isSolid(id: BlockId): boolean {
    if (id >= 0 && id < this.solidFlags.length) return this.solidFlags[id] === 1;
    return this.get(id).solid;
  }
}

/** 注册内置基础方块 */
export function registerBuiltinBlocks(reg: BlockRegistry) {
  const cube = (
    name: string, label: string, tiles: Partial<BlockDefinition['tiles']>,
    extra: Partial<BlockInput> = {},
  ) => {
    const t = { top: name, bottom: name, side: name, ...tiles };
    reg.register({
      name, label, shape: 'cube', solid: true, opaque: true, liquid: false,
      transparentPass: false, lightEmission: 0, hardness: 1, sound: 'stone', tiles: t, ...extra,
    });
  };

  cube('grass', '草方块', { top: 'grass_top', bottom: 'dirt', side: 'grass_side' },
    { sound: 'dirt', hardness: 0.6, drops: [{ name: 'dirt' }] });
  cube('dirt', '泥土', {}, { sound: 'dirt', hardness: 0.5 });
  cube('stone', '石头', {}, { hardness: 1.5, drops: [{ name: 'cobblestone' }] });
  cube('cobblestone', '圆石', {}, { hardness: 2 });
  cube('sand', '沙子', {}, { sound: 'sand', hardness: 0.5 });
  cube('oak_log', '橡木原木', { top: 'log_top', bottom: 'log_top', side: 'log_side' }, { sound: 'wood', hardness: 2 });
  cube('oak_planks', '橡木木板', {}, { sound: 'wood', hardness: 2 });
  cube('oak_leaves', '橡树树叶', {}, {
    opaque: false, cullSame: true, sound: 'plant', hardness: 0.2,
    drops: [{ name: 'oak_leaves', chance: 0.5 }, { name: 'item:apple', chance: 0.2 }],
  });
  cube('glass', '玻璃', {}, { opaque: false, transparentPass: true, sound: 'glass', hardness: 0.3, drops: [] });
  cube('bricks', '红砖块', {}, { hardness: 2 });
  cube('water', '水', {}, {
    solid: false, opaque: false, liquid: true, transparentPass: true, sound: 'liquid', hardness: 100, drops: [],
  });
  cube('bedrock', '基岩', {}, { hardness: Infinity, drops: [] });
  cube('glowstone', '萤石', {}, { lightEmission: 15, sound: 'glass', hardness: 0.3 });
  cube('snow', '雪块', {}, { sound: 'cloth', hardness: 0.2 });
  cube('tnt', 'TNT', { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' },
    { sound: 'cloth', hardness: 0, drops: [] });
  cube('white_wool', '白色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('red_wool', '红色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('blue_wool', '蓝色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('yellow_wool', '黄色羊毛', {}, { sound: 'cloth', hardness: 0.8 });

  const plant = (name: string, label: string) =>
    reg.register({
      name, label, shape: 'cross', solid: false, opaque: false, liquid: false,
      transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant',
      tiles: { top: name, bottom: name, side: name },
    });
  plant('tall_grass', '草丛');
  plant('poppy', '虞美人');
  plant('dandelion', '蒲公英');

  // 矿石追加在末尾：不改动已有方块 id，保证旧存档 edits 差分仍指向同一方块
  cube('coal_ore', '煤矿石', {}, { hardness: 2.5 });
  cube('iron_ore', '铁矿石', {}, { hardness: 3 });
  cube('gold_ore', '金矿石', {}, { hardness: 3 });
  cube('diamond_ore', '钻石矿石', {}, { hardness: 4 });
}
