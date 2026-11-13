"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlockRegistry = exports.AIR = void 0;
exports.registerBuiltinBlocks = registerBuiltinBlocks;
exports.AIR = 0;
/**
 * 方块注册表（扩展点：CraftAPI.registerBlock）。
 * 所有 gameplay 与渲染都通过注册表查询方块属性，不硬编码 id。
 */
class BlockRegistry {
    constructor() {
        this.byId = new Map();
        this.byName = new Map();
        this.nextId = 1;
        this.air = {
            id: exports.AIR, name: 'air', label: '空气', shape: 'cube', solid: false, opaque: false,
            liquid: false, transparentPass: false, lightEmission: 0, hardness: 0, sound: 'dirt',
            tiles: { top: '', bottom: '', side: '' }, drops: [],
        };
        this.byId.set(exports.AIR, this.air);
        this.byName.set('air', this.air);
    }
    register(input) {
        if (this.byName.has(input.name))
            throw new Error(`方块名重复: ${input.name}`);
        const id = input.id ?? this.nextId;
        if (this.byId.has(id))
            throw new Error(`方块 id 重复: ${id}`);
        const def = { ...input, id, drops: input.drops ?? [{ name: 'self' }] };
        this.byId.set(id, def);
        this.byName.set(def.name, def);
        if (id >= this.nextId)
            this.nextId = id + 1;
        return def;
    }
    get(id) {
        return this.byId.get(id) ?? this.air;
    }
    byNameGet(name) {
        return this.byName.get(name);
    }
    all() {
        return [...this.byId.values()].filter((b) => b.id !== exports.AIR);
    }
    isOpaque(id) {
        return this.get(id).opaque;
    }
    isSolid(id) {
        return this.get(id).solid;
    }
}
exports.BlockRegistry = BlockRegistry;
/** 注册内置基础方块 */
function registerBuiltinBlocks(reg) {
    const cube = (name, label, tiles, extra = {}) => {
        const t = { top: name, bottom: name, side: name, ...tiles };
        reg.register({
            name, label, shape: 'cube', solid: true, opaque: true, liquid: false,
            transparentPass: false, lightEmission: 0, hardness: 1, sound: 'stone', tiles: t, ...extra,
        });
    };
    cube('grass', '草方块', { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, { sound: 'dirt', hardness: 0.6, drops: [{ name: 'dirt' }] });
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
    cube('tnt', 'TNT', { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, { sound: 'cloth', hardness: 0, drops: [] });
    cube('white_wool', '白色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
    cube('red_wool', '红色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
    cube('blue_wool', '蓝色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
    cube('yellow_wool', '黄色羊毛', {}, { sound: 'cloth', hardness: 0.8 });
    const plant = (name, label) => reg.register({
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
