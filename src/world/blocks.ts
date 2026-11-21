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
  /** 最小数量（与 max 搭配时覆盖 count，闭区间） */
  min?: number;
  /** 最大数量（与 min 搭配时覆盖 count，闭区间） */
  max?: number;
  /** 只在夜晚（daylight < 0.3）掉落 */
  nightOnly?: boolean;
  /** 只在指定群系掉落 */
  biome?: string;
}

export interface BlockDefinition {
  id: BlockId;
  /** 程序名（API 注册用，唯一） */
  name: string;
  /** 显示名（HUD） */
  label: string;
  shape: BlockShape;
  /**
   * 十字面植物的可视高度（0~1，默认 1）。
   * 只影响渲染几何：矮花草不再顶满整格，花海层次更自然。
   */
  crossHeight?: number;
  /** 是否参与碰撞 */
  solid: boolean;
  /** 是否完全遮光（用于面剔除与环境光遮蔽） */
  opaque: boolean;
  /** 非遮光方块是否剔除与自身同材质的相邻面（树叶等，减少内部面） */
  cullSame?: boolean;
  /** 液体：可游泳穿过，不可被准星选中 */
  liquid: boolean;
  /** 水生植物：占据水格，玩家在其中仍视为入水（海草 / 海带） */
  waterPlant?: boolean;
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
  /**
   * 群系染色（草 / 叶 / 藤蔓）：图集纹理画成灰度，
   * 区块 shader 按世界坐标噪声乘群系色（chunkManager.injectLight）。
   */
  tint?: boolean;
  /** 受重力下落（沙子 / 沙砾）：失去支撑时转为下落实体（FallingSystem） */
  falling?: boolean;
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
    // 区块数据用 Uint8Array 存储，id 超过 255 会被静默截断成别的方块
    if (id < 1 || id > 255) throw new Error(`方块 id 超出 1~255: ${id}`);
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
    { sound: 'dirt', hardness: 0.6, drops: [{ name: 'dirt' }], tint: true });
  cube('dirt', '泥土', {}, { sound: 'dirt', hardness: 0.5 });
  cube('stone', '石头', {}, { hardness: 1.5, drops: [{ name: 'cobblestone' }] });
  cube('cobblestone', '圆石', {}, { hardness: 2 });
  cube('sand', '沙子', {}, { sound: 'sand', hardness: 0.5, falling: true });
  cube('oak_log', '橡木原木', { top: 'log_top', bottom: 'log_top', side: 'log_side' }, { sound: 'wood', hardness: 2 });
  cube('oak_planks', '橡木木板', {}, { sound: 'wood', hardness: 2 });
  cube('oak_leaves', '橡树树叶', {}, {
    opaque: false, cullSame: true, sound: 'plant', hardness: 0.2, tint: true,
    drops: [
      { name: 'oak_sapling', chance: 0.08 },
      { name: 'oak_leaves', chance: 0.5 },
      { name: 'item:apple', chance: 0.2 },
    ],
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

  /**
   * 植物可视高度表：十字面贴图本身画满 16px，按方块渲染时缩放高度。
   * 矮花 / 地被 / 苔藓贴近地面，穗状花与作物长满整格，观感层次更接近真实草甸。
   */
  const PLANT_HEIGHTS: Readonly<Record<string, number>> = {
    tall_grass: 0.9, poppy: 0.72, dandelion: 0.68,
    red_mushroom: 0.55, brown_mushroom: 0.6, dead_bush: 0.72,
    sugar_cane: 1, fern: 0.58, bamboo: 1,
    bluebell: 0.62, allium: 0.72, azure_bluet: 0.46, oxeye_daisy: 0.66,
    cornflower: 0.7, lily_of_the_valley: 0.68,
    tulip_red: 0.6, tulip_orange: 0.6, tulip_white: 0.6, tulip_pink: 0.6,
    sunflower: 1, lilac: 0.92, rose_bush: 0.86, peony: 0.9, tall_fern: 0.95,
    vine: 1, lily_pad: 0.32,
    glow_lichen: 0.55, moss_carpet: 0.3,
    wheat_seedling: 0.3, wheat_growing: 0.55, wheat: 0.9,
    sweet_berry_bush: 0.7, sweet_berry_bush_ripe: 0.7, pumpkin_stem: 0.82,
    oak_sapling: 0.7, birch_sapling: 0.7, spruce_sapling: 0.72,
    // v1.6.0 花海扩充
    lavender: 0.9, buttercup: 0.5, forget_me_not: 0.44, marigold: 0.58,
    foxglove: 1, hollyhock: 1, violet: 0.4,
    wood_anemone: 0.46, wild_garlic: 0.52, hyacinth: 0.68, ivy: 1, glow_moss: 0.34,
    lingonberry_bush: 0.58, snowdrop: 0.5,
    edelweiss: 0.42, snow_lily: 0.58, crocus: 0.38, gentian: 0.5,
    yucca: 0.92, desert_marigold: 0.5, ghost_flower: 0.66,
    beach_grass: 0.84, sea_thrift: 0.42,
    duckweed: 0.16, sea_anemone: 0.5, red_algae: 0.62,
    moonflower: 0.6, glow_fern: 0.78,
  };

  const plant = (name: string, label: string, drops?: DropSpec[], extra: Partial<BlockInput> = {}) =>
    reg.register({
      name, label, shape: 'cross', solid: false, opaque: false, liquid: false,
      transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant',
      tiles: { top: name, bottom: name, side: name }, drops,
      crossHeight: PLANT_HEIGHTS[name] ?? 0.8, ...extra,
    });
  // 草丛是生存模式最早的小麦种子来源（对应原版打草掉种子）
  plant('tall_grass', '草丛', [{ name: 'self' }, { name: 'item:wheat_seeds', chance: 0.25 }], { tint: true });
  plant('poppy', '虞美人');
  plant('dandelion', '蒲公英');

  // 矿石追加在末尾：不改动已有方块 id，保证旧存档 edits 差分仍指向同一方块
  cube('coal_ore', '煤矿石', {}, { hardness: 2.5 });
  cube('iron_ore', '铁矿石', {}, { hardness: 3 });
  cube('gold_ore', '金矿石', {}, { hardness: 3 });
  cube('diamond_ore', '钻石矿石', {}, { hardness: 4 });

  // ---- 追加方块（id 27 起，末位追加，旧存档差分保持有效） ----
  // 光源方块：火把（地面十字面）与南瓜灯（完整方块）
  reg.register({
    name: 'torch', label: '火把', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 14, hardness: 0.1, sound: 'wood',
    tiles: { top: 'torch', bottom: 'torch', side: 'torch' },
  });
  cube('jack_o_lantern', '南瓜灯', { top: 'pumpkin_top', bottom: 'pumpkin_bottom', side: 'pumpkin_face' },
    { lightEmission: 15, sound: 'wood', hardness: 1 });

  // 建材
  cube('stone_bricks', '石砖', {}, { hardness: 2 });
  cube('mossy_cobblestone', '苔石圆石', {}, { hardness: 2 });
  cube('obsidian', '黑曜石', {}, { hardness: 12 });
  cube('gravel', '沙砾', {}, { sound: 'sand', hardness: 0.6, falling: true });
  cube('sandstone', '砂岩', {}, { sound: 'sand', hardness: 1.2 });
  cube('ice', '冰', {}, {
    // cullSame：相邻冰方块之间的内部面与玻璃一样剔除，避免透明通道多出无用面片。
    opaque: false, cullSame: true, transparentPass: true, sound: 'glass', hardness: 0.5, drops: [],
  });
  cube('spruce_planks', '云杉木板', {}, { sound: 'wood', hardness: 2 });
  cube('birch_planks', '白桦木板', {}, { sound: 'wood', hardness: 2 });
  cube('crafting_table', '工作台', { top: 'crafting_top', bottom: 'oak_planks', side: 'crafting_side' },
    { sound: 'wood', hardness: 3.5 });
  // 植物（十字面，需放在实心方块上）
  plant('red_mushroom', '红蘑菇');
  plant('brown_mushroom', '棕蘑菇');
  plant('dead_bush', '枯灌木');
  // 羊毛补充色
  cube('orange_wool', '橙色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('green_wool', '绿色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('purple_wool', '紫色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
  cube('black_wool', '黑色羊毛', {}, { sound: 'cloth', hardness: 0.8 });

  // ---- v1.4.0 方块扩充（id 45 起，仍为末位追加，旧存档差分保持有效） ----
  // 矿石：与既有矿脉一起由地形阶段配置生成（绿宝石仅高山）
  cube('copper_ore', '铜矿石', {}, { hardness: 2.5 });
  cube('emerald_ore', '绿宝石矿石', {}, { hardness: 3 });
  cube('lapis_ore', '青金石矿石', {}, { hardness: 2.6 });
  cube('redstone_ore', '红石矿石', {}, { hardness: 2.4 });
  // 地表 / 建材
  cube('clay', '黏土', {}, { sound: 'dirt', hardness: 0.6 });
  cube('podzol', '灰化土', { top: 'podzol_top', bottom: 'dirt', side: 'podzol_side' },
    { sound: 'dirt', hardness: 0.5, drops: [{ name: 'dirt' }] });
  cube('cactus', '仙人掌', {}, { sound: 'plant', hardness: 0.4 });
  // 植物（十字面，地形装饰生成）
  plant('sugar_cane', '甘蔗');
  plant('fern', '蕨', undefined, { tint: true });
  cube('granite', '花岗岩', {}, { hardness: 1.5 });

  // ---- 新增方块（id 55、56，末位追加，旧存档 edits 差分保持有效） ----
  cube('pumpkin', '南瓜', { top: 'pumpkin_top', bottom: 'pumpkin_bottom', side: 'pumpkin_side' },
    { sound: 'wood', hardness: 1 });
  cube('bookshelf', '书架', { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf_side' },
    { sound: 'wood', hardness: 1.5 });

  // ---- v1.4.1 植物大扩充（id 57 起，仍为末位追加，旧存档差分保持有效） ----
  // 花卉：全部走群系配置表自然生成，也会由邻近同类随机蔓延
  plant('bluebell', '蓝铃花');
  plant('allium', '绒球葱');
  plant('azure_bluet', '蓝花美耳草');
  plant('oxeye_daisy', '滨菊');
  plant('cornflower', '矢车菊');
  plant('lily_of_the_valley', '铃兰');
  plant('tulip_red', '红色郁金香');
  plant('tulip_orange', '橙色郁金香');
  plant('tulip_white', '白色郁金香');
  plant('tulip_pink', '粉色郁金香');
  plant('sunflower', '向日葵');
  plant('lilac', '丁香');
  plant('rose_bush', '玫瑰丛');
  plant('peony', '牡丹');
  plant('tall_fern', '高蕨', undefined, { tint: true });

  // 攀爬 / 水生 / 洞穴植物：藤蔓向下蔓延、睡莲在水面铺开、海草与海带成片生长
  plant('vine', '藤蔓', undefined, { tint: true });
  plant('lily_pad', '睡莲');
  reg.register({
    name: 'seagrass', label: '海草', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant', waterPlant: true,
    tiles: { top: 'seagrass', bottom: 'seagrass', side: 'seagrass' }, crossHeight: 1,
  });
  reg.register({
    name: 'kelp', label: '海带', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant', waterPlant: true,
    tiles: { top: 'kelp', bottom: 'kelp', side: 'kelp' }, crossHeight: 1,
  });
  plant('bamboo', '竹子');
  reg.register({
    name: 'glow_lichen', label: '发光地衣', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 7, hardness: 0, sound: 'plant',
    tiles: { top: 'glow_lichen', bottom: 'glow_lichen', side: 'glow_lichen' }, crossHeight: 0.55,
  });
  plant('moss_carpet', '苔藓地毯');

  // 生长阶段：小麦（麦苗 → 抽穗 → 成熟）与甜浆果丛（青果 → 成熟）
  const growthPlant = (name: string, label: string, drops: DropSpec[]) =>
    reg.register({
      name, label, shape: 'cross', solid: false, opaque: false, liquid: false,
      transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant',
      tiles: { top: name, bottom: name, side: name }, drops,
      crossHeight: PLANT_HEIGHTS[name] ?? 0.8,
    });
  growthPlant('wheat_seedling', '麦苗', [{ name: 'item:wheat_seeds', chance: 0.6 }]);
  growthPlant('wheat_growing', '小麦（抽穗）', [{ name: 'item:wheat_seeds', chance: 0.9 }]);
  growthPlant('wheat', '小麦（成熟）',
    [{ name: 'self' }, { name: 'item:wheat_seeds', count: 2 }]);
  growthPlant('sweet_berry_bush', '甜浆果丛', [{ name: 'self' }]);
  growthPlant('sweet_berry_bush_ripe', '成熟甜浆果丛',
    [{ name: 'self' }, { name: 'item:sweet_berries', count: 2 }]);
  growthPlant('pumpkin_stem', '南瓜藤', [{ name: 'self' }]);

  // 树苗：随机刻后长成对应树种（橡树 / 白桦 / 云杉）
  plant('oak_sapling', '橡树树苗');
  plant('birch_sapling', '白桦树苗');
  plant('spruce_sapling', '云杉树苗');

  // 树种方块：由森林 / 针叶林生成阶段按权重种植，也可由树苗长成
  cube('birch_log', '白桦原木', { top: 'birch_log_top', bottom: 'birch_log_top', side: 'birch_log_side' },
    { sound: 'wood', hardness: 2 });
  cube('birch_leaves', '白桦树叶', {}, {
    opaque: false, cullSame: true, sound: 'plant', hardness: 0.2, tint: true,
    drops: [{ name: 'birch_sapling', chance: 0.08 }, { name: 'birch_leaves', chance: 0.5 }],
  });
  cube('spruce_log', '云杉原木', { top: 'spruce_log_top', bottom: 'spruce_log_top', side: 'spruce_log_side' },
    { sound: 'wood', hardness: 2 });
  cube('spruce_leaves', '云杉树叶', {}, {
    opaque: false, cullSame: true, sound: 'plant', hardness: 0.2, tint: true,
    drops: [{ name: 'spruce_sapling', chance: 0.08 }, { name: 'spruce_leaves', chance: 0.5 }],
  });

  // ---- 群系扩充（id 98~110，末位追加） ----
  // 恶地彩色陶瓦：按深度分层，构成彩色丘陵地貌
  cube('terracotta_red', '红色陶瓦', {}, { id: 98, sound: 'stone', hardness: 1.5 });
  cube('terracotta_orange', '橙色陶瓦', {}, { id: 99, sound: 'stone', hardness: 1.5 });
  cube('terracotta_yellow', '黄色陶瓦', {}, { id: 100, sound: 'stone', hardness: 1.5 });
  cube('terracotta_white', '白色陶瓦', {}, { id: 101, sound: 'stone', hardness: 1.5 });
  cube('terracotta_blue', '蓝色陶瓦', {}, { id: 102, sound: 'stone', hardness: 1.5 });
  cube('red_sand', '红沙', {}, { id: 103, sound: 'sand', hardness: 0.5, falling: true });
  // 沼泽泥：沼泽群系的地表 / 填充
  cube('mud', '泥', {}, { id: 104, sound: 'dirt', hardness: 0.6 });
  // 干草原草皮：暖黄草色由 shader 的群系色调制
  cube('dry_grass', '干草方块', { top: 'dry_grass_top', bottom: 'dirt', side: 'dry_grass_side' },
    { id: 105, sound: 'dirt', hardness: 0.6, drops: [{ name: 'dirt' }], tint: true });
  // 金合欢：热带草原的伞形乔木
  cube('acacia_log', '金合欢原木',
    { top: 'acacia_log_top', bottom: 'acacia_log_top', side: 'acacia_log_side' },
    { id: 106, sound: 'wood', hardness: 2 });
  cube('acacia_leaves', '金合欢树叶', {}, {
    id: 107, opaque: false, cullSame: true, sound: 'plant', hardness: 0.2, tint: true,
    drops: [{ name: 'self' }],
  });
  // 樱花：樱花林的粉冠乔木
  cube('cherry_log', '樱花原木',
    { top: 'cherry_log_top', bottom: 'cherry_log_top', side: 'cherry_log_side' },
    { id: 108, sound: 'wood', hardness: 2 });
  cube('cherry_leaves', '樱花树叶', {}, {
    id: 109, opaque: false, cullSame: true, sound: 'plant', hardness: 0.2,
    drops: [{ name: 'self' }],
  });

  // ---- 堆肥桶（id 110~118，末位追加；等级编码进 block id，借 world.edits 免费持久化） ----
  for (let i = 0; i <= 7; i++) {
    cube(i === 0 ? 'composter' : `composter_${i}`, i === 0 ? '堆肥桶' : `堆肥桶 ${i}/7`,
      { top: 'composter_top', bottom: 'composter_bottom', side: 'composter_side' },
      { id: 110 + i, sound: 'wood', hardness: 1.2, drops: [{ name: 'self' }] });
  }
  cube('composter_ready', '堆肥桶（成熟）',
    { top: 'composter_ready_top', bottom: 'composter_bottom', side: 'composter_side' },
    { id: 118, sound: 'wood', hardness: 1.2, drops: [{ name: 'self' }] });
  // ---- 熔炉（E03，堆肥桶之后末位追加；右键打开烧炼界面） ----
  cube('furnace', '熔炉', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side' },
    { id: 119, hardness: 2 });
  // ---- v1.6.0 花海扩充（熔炉之后自动顺延 120~147，仍为末位追加，旧存档差分保持有效） ----
  // 移植自 AtomGit v1.6.0（原 id 92~119，顺延至 120~147）
  // 温带花甸：从矮丛到高穗，和既有花卉一起组成成片花圃
  plant('lavender', '薰衣草');
  plant('buttercup', '金凤花');
  plant('forget_me_not', '勿忘我');
  plant('marigold', '万寿菊');
  plant('foxglove', '毛地黄');
  plant('hollyhock', '蜀葵');
  plant('violet', '紫罗兰');
  // 林下阴湿：耐荫花草与垂挂藤本
  plant('wood_anemone', '林地银莲花');
  plant('wild_garlic', '野蒜');
  plant('hyacinth', '风信子');
  plant('ivy', '常春藤', undefined, { tint: true });
  reg.register({
    name: 'glow_moss', label: '荧光苔', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 4, hardness: 0, sound: 'plant',
    tiles: { top: 'glow_moss', bottom: 'glow_moss', side: 'glow_moss' }, crossHeight: 0.34,
  });
  // 针叶林 / 高山：低矮灌木与雪线花卉
  plant('lingonberry_bush', '越橘丛',
    [{ name: 'self' }, { name: 'item:sweet_berries', chance: 0.35 }]);
  plant('snowdrop', '雪滴花');
  plant('edelweiss', '雪绒花');
  plant('snow_lily', '雪莲');
  plant('crocus', '番红花');
  plant('gentian', '高山龙胆');
  // 沙漠 / 海岸：旱生与盐生植物
  plant('yucca', '丝兰');
  plant('desert_marigold', '沙漠金盏');
  reg.register({
    name: 'ghost_flower', label: '幽灵花', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 6, hardness: 0, sound: 'plant',
    tiles: { top: 'ghost_flower', bottom: 'ghost_flower', side: 'ghost_flower' }, crossHeight: 0.66,
  });
  plant('beach_grass', '海滩草', undefined, { tint: true });
  plant('sea_thrift', '海石竹');
  // 水下 / 水面：浮萍铺水面，海葵与红藻成片生长
  plant('duckweed', '浮萍');
  reg.register({
    name: 'sea_anemone', label: '海葵', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant', waterPlant: true,
    tiles: { top: 'sea_anemone', bottom: 'sea_anemone', side: 'sea_anemone' }, crossHeight: 0.5,
  });
  reg.register({
    name: 'red_algae', label: '红藻', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 0, hardness: 0, sound: 'plant', waterPlant: true,
    tiles: { top: 'red_algae', bottom: 'red_algae', side: 'red_algae' }, crossHeight: 0.62,
  });
  // 洞穴弱光植物：自发光，给地下一点生气
  reg.register({
    name: 'moonflower', label: '月光花', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 7, hardness: 0, sound: 'plant',
    tiles: { top: 'moonflower', bottom: 'moonflower', side: 'moonflower' }, crossHeight: 0.6,
  });
  reg.register({
    name: 'glow_fern', label: '荧光蕨', shape: 'cross', solid: false, opaque: false, liquid: false,
    transparentPass: false, lightEmission: 5, hardness: 0, sound: 'plant',
    tiles: { top: 'glow_fern', bottom: 'glow_fern', side: 'glow_fern' }, crossHeight: 0.78,
  });
}
