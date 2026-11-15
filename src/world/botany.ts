import { CHUNK_SIZE, WORLD_HEIGHT, mulberry32, type BlockId } from '../core/types';
import type { EventService } from '../services/events';
import { AIR, type BlockRegistry } from './blocks';
import { buildTree, type TreeSpecies } from './trees';
import type { World } from './world';

/** 一次随机刻里最多处理的采样次数（移动端减半，避免持续占用帧预算） */
export interface BotanyOptions {
  /** 随机刻间隔（秒） */
  interval?: number;
  /** 每次随机刻的采样尝试数 */
  attempts?: number;
  /** 以玩家为中心的水平采样半径（格） */
  radius?: number;
  isMobile?: boolean;
}

type GrowKind = 'grow' | 'spread' | 'decay' | 'ripen';

/** 生态规则的方块 id 表：显式接口保证漏键在编译期暴露，而不是静默变成 0 */
interface BotanyIds {
  grass: BlockId; dirt: BlockId; podzol: BlockId; water: BlockId;
  sugarCane: BlockId; cactus: BlockId; bamboo: BlockId;
  kelp: BlockId; seagrass: BlockId; lilyPad: BlockId;
  vine: BlockId; glowLichen: BlockId; mossCarpet: BlockId;
  wheatSeedling: BlockId; wheatGrowing: BlockId; wheat: BlockId;
  berryBush: BlockId; berryBushRipe: BlockId; pumpkinStem: BlockId; pumpkin: BlockId;
  oakSapling: BlockId; birchSapling: BlockId; spruceSapling: BlockId;
  redMushroom: BlockId; brownMushroom: BlockId;
  tallGrass: BlockId; fern: BlockId; tallFern: BlockId;
}

const H = WORLD_HEIGHT;
const CS = CHUNK_SIZE;
const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * 植物生态引擎（随机刻）。
 *
 * 只对玩家附近的已生成区块采样：每次随机刻随机取若干「列 + 高度」，
 * 命中植物后按规则生长 / 蔓延 / 枯萎。单次代价与采样次数成正比，
 * 不随世界大小增长，也不会为全图植物建表。
 *
 * 规则一览：
 * - 生长：甘蔗 / 仙人掌 / 竹子 / 海带长高，小麦分阶段成熟，浆果成熟，树苗长成树；
 * - 蔓延：草方块 → 泥土、花草 → 邻近草地、蘑菇 → 阴暗地面、藤蔓垂挂、
 *   睡莲铺水面、海草成片、发光地衣 / 苔藓贴地扩散、南瓜藤结瓜；
 * - 枯萎：支撑方块被拆后植物自动脱落（连同上方整列）。
 */
export class Botany {
  private readonly rng: () => number;
  private readonly interval: number;
  private readonly attempts: number;
  private readonly radius: number;
  private acc = 0;

  /** 名称 → id 缓存（本引擎只认内置植物，运行时方块不会进入随机刻） */
  private readonly id: BotanyIds;
  private readonly flowers = new Set<BlockId>();
  private readonly spreadable = new Set<BlockId>();
  private readonly mushrooms = new Set<BlockId>();
  private readonly saplings = new Map<BlockId, TreeSpecies>();
  private readonly aquatic = new Set<BlockId>();
  private readonly columns = new Set<BlockId>();
  private readonly meadow: { id: BlockId; weight: number }[] = [];
  private meadowTotal = 0;

  constructor(
    private readonly world: World,
    private readonly registry: BlockRegistry,
    seed: number,
    private readonly events?: EventService,
    options: BotanyOptions = {},
  ) {
    this.rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    this.interval = options.interval ?? 0.3;
    this.attempts = options.attempts ?? (options.isMobile ? 24 : 56);
    this.radius = options.radius ?? 24;

    const byName = (name: string) => registry.byNameGet(name)?.id ?? 0;
    this.id = {
      grass: byName('grass'), dirt: byName('dirt'), podzol: byName('podzol'),
      water: byName('water'),
      sugarCane: byName('sugar_cane'), cactus: byName('cactus'), bamboo: byName('bamboo'),
      kelp: byName('kelp'), seagrass: byName('seagrass'), lilyPad: byName('lily_pad'),
      vine: byName('vine'), glowLichen: byName('glow_lichen'), mossCarpet: byName('moss_carpet'),
      wheatSeedling: byName('wheat_seedling'), wheatGrowing: byName('wheat_growing'),
      wheat: byName('wheat'),
      berryBush: byName('sweet_berry_bush'), berryBushRipe: byName('sweet_berry_bush_ripe'),
      pumpkinStem: byName('pumpkin_stem'), pumpkin: byName('pumpkin'),
      oakSapling: byName('oak_sapling'), birchSapling: byName('birch_sapling'),
      spruceSapling: byName('spruce_sapling'),
      redMushroom: byName('red_mushroom'), brownMushroom: byName('brown_mushroom'),
      tallGrass: byName('tall_grass'), fern: byName('fern'), tallFern: byName('tall_fern'),
    };

    const flowerNames = [
      'poppy', 'dandelion', 'bluebell', 'allium', 'azure_bluet', 'oxeye_daisy',
      'cornflower', 'lily_of_the_valley', 'tulip_red', 'tulip_orange', 'tulip_white',
      'tulip_pink', 'sunflower', 'lilac', 'rose_bush', 'peony',
    ];
    for (const name of flowerNames) {
      const id = byName(name);
      if (id) this.flowers.add(id);
    }
    for (const id of [this.id.tallGrass, this.id.fern, this.id.tallFern]) {
      if (id) this.spreadable.add(id);
    }
    // 花与草都能由草方块自然长出；权重大致对应野外观感
    for (const id of this.flowers) this.meadow.push({ id, weight: 0.7 });
    for (const id of [this.id.tallGrass, this.id.fern, this.id.tallFern]) {
      if (id) this.meadow.push({ id, weight: 3 });
    }
    this.meadowTotal = this.meadow.reduce((sum, m) => sum + m.weight, 0);
    for (const id of [this.id.redMushroom, this.id.brownMushroom]) {
      if (id) this.mushrooms.add(id);
    }
    if (this.id.oakSapling) this.saplings.set(this.id.oakSapling, 'oak');
    if (this.id.birchSapling) this.saplings.set(this.id.birchSapling, 'birch');
    if (this.id.spruceSapling) this.saplings.set(this.id.spruceSapling, 'spruce');
    for (const id of [this.id.kelp, this.id.seagrass]) if (id) this.aquatic.add(id);
    for (const id of [this.id.sugarCane, this.id.bamboo]) if (id) this.columns.add(id);
  }

  /** 主循环入口：只在玩家附近推进随机刻 */
  update(dt: number, focusX: number, focusZ: number, daylight: number): void {
    this.acc += Math.min(dt, 0.25);
    if (this.acc < this.interval) return;
    this.acc -= this.interval;
    for (let i = 0; i < this.attempts; i++) this.randomAttempt(focusX, focusZ, daylight);
  }

  /**
   * 在确切坐标执行一次随机刻（调试 / 回归测试用）。
   * 返回是否改变了世界。
   */
  tickAt(x: number, y: number, z: number, daylight = 1): boolean {
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return false;
    return this.applyAt(x, y, z, id, daylight);
  }

  // ---------- 采样 ----------

  private randomAttempt(focusX: number, focusZ: number, daylight: number): void {
    const r = this.rng;
    const angle = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * this.radius;
    const x = Math.floor(focusX + Math.cos(angle) * dist);
    const z = Math.floor(focusZ + Math.sin(angle) * dist);
    const chunk = this.world.getChunk(Math.floor(x / CS), Math.floor(z / CS));
    if (!chunk || !chunk.generated) return;

    const surface = this.world.surfaceHeight(x, z);
    // 大部分样本贴地表（花草 / 草方块 / 树苗），少量深入地下（蘑菇 / 地衣）
    const y = r() < 0.72
      ? surface - 1 + ((r() * 4) | 0)
      : 1 + ((r() * Math.max(1, Math.min(surface + 8, H - 1))) | 0);
    if (y < 1 || y >= H - 1) return;
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return;
    this.applyAt(x, y, z, id, daylight);
  }

  // ---------- 调度 ----------

  private applyAt(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (id === this.id.grass) return this.tickGrass(x, y, z, daylight);
    if (id === this.id.dirt) return this.tickDirt(x, y, z);
    if (id === this.id.cactus) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickCactus(x, y, z);
    }
    if (id === this.id.lilyPad) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickLily(x, y, z);
    }
    if (id === this.id.vine) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickVine(x, y, z);
    }
    if (id === this.id.glowLichen) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickLichen(x, y, z);
    }
    if (id === this.id.mossCarpet) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickMoss(x, y, z);
    }
    if (this.aquatic.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickAquatic(x, y, z, id);
    }
    if (this.columns.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickColumn(x, y, z, id);
    }
    if (this.saplings.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickSapling(x, y, z, this.saplings.get(id)!, daylight);
    }
    if (id === this.id.wheatSeedling || id === this.id.wheatGrowing) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickWheat(x, y, z, id, daylight);
    }
    if (id === this.id.berryBush || id === this.id.berryBushRipe) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickBerry(x, y, z, id, daylight);
    }
    if (id === this.id.pumpkinStem) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickPumpkinStem(x, y, z, daylight);
    }

    const def = this.registry.get(id);
    if (def.shape !== 'cross') return false;
    if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
    if (this.mushrooms.has(id)) return this.tickMushroom(x, y, z, id);
    if (this.flowers.has(id) || this.spreadable.has(id)) return this.tickSpread(x, y, z, id, daylight);
    return false;
  }

  // ---------- 规则：支撑与枯萎 ----------

  private supported(id: BlockId, x: number, y: number, z: number): boolean {
    const below = this.world.getBlock(x, y - 1, z);
    if (id === this.id.vine || id === this.id.glowLichen) {
      // 藤蔓可以挂在实心方块或另一段藤蔓上（向下垂挂成串）
      if (below === id || this.world.getBlock(x, y + 1, z) === id || this.registry.isSolid(below)) return true;
      for (const [dx, dy, dz] of DIRS) {
        const n = this.world.getBlock(x + dx, y + dy, z + dz);
        if (n !== AIR && this.registry.isSolid(n)) return true;
      }
      return false;
    }
    if (id === this.id.lilyPad) {
      return this.registry.isSolid(below) || this.registry.get(below).liquid;
    }
    if (this.aquatic.has(id)) {
      return this.registry.isSolid(below) || below === this.id.kelp || below === this.id.seagrass;
    }
    if (this.columns.has(id)) {
      return this.registry.isSolid(below) || below === id;
    }
    return this.registry.isSolid(below);
  }

  private decay(x: number, y: number, z: number, id: BlockId): boolean {
    let changed = false;
    // 整列枯萎：甘蔗 / 竹子 / 仙人掌 / 海带被拆掉底格后不应留下一段悬空
    for (let yy = y; yy < H; yy++) {
      if (this.world.getBlock(x, yy, z) !== id) break;
      if (this.world.setBlock(x, yy, z, AIR)) {
        this.events?.emit('plant:grow', { x, y: yy, z, block: id, kind: 'decay' });
        changed = true;
      }
    }
    return changed;
  }

  // ---------- 规则：草方块与草地 ----------

  private tickGrass(x: number, y: number, z: number, daylight: number): boolean {
    const above = this.world.getBlock(x, y + 1, z);
    // 被实心方块压住的草方块退化为泥土
    if (this.registry.isOpaque(above)) return this.set(x, y, z, this.id.dirt, 'decay');
    const sky = this.world.getSkyLight(x, y + 1, z);
    if (daylight < 0.12 || sky < 6) return false;

    // 向邻近裸露泥土蔓延
    if (above === AIR && this.rng() < 0.14) {
      const [nx, nz] = this.pickNeighbor(x, z);
      if (this.world.getBlock(nx, y, nz) === this.id.dirt &&
        this.world.getBlock(nx, y + 1, nz) === AIR &&
        this.world.getSkyLight(nx, y + 1, nz) >= 6) {
        return this.set(nx, y, nz, this.id.grass, 'spread');
      }
    }

    // 草方块上自然长出花草
    if (above === AIR && sky >= 9 && this.rng() < 0.1 && this.meadowTotal > 0) {
      let r = this.rng() * this.meadowTotal;
      for (const m of this.meadow) {
        r -= m.weight;
        if (r > 0) continue;
        return this.set(x, y + 1, z, m.id, 'spread');
      }
    }
    return false;
  }

  private tickDirt(x: number, y: number, z: number): boolean {
    if (this.world.getBlock(x, y + 1, z) !== AIR) return false;
    if (this.world.getSkyLight(x, y + 1, z) < 6) return false;
    if (this.rng() > 0.2) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.world.getBlock(x + dx, y, z + dz) === this.id.grass) {
        return this.set(x, y, z, this.id.grass, 'spread');
      }
    }
    return false;
  }

  // ---------- 规则：花草蔓延 ----------

  private tickSpread(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (daylight < 0.15 || this.rng() > 0.09) return false;
    const spot = this.findGroundSpot(x, y, z, 2, true);
    return spot ? this.set(spot[0], spot[1], spot[2], id, 'spread') : false;
  }

  private tickMushroom(x: number, y: number, z: number, id: BlockId): boolean {
    // 蘑菇只在阴暗处蔓延（洞穴 / 树冠下）
    if (this.world.getSkyLight(x, y, z) >= 8 || this.world.getBlockLight(x, y, z) >= 8) return false;
    if (this.rng() > 0.12) return false;
    const spot = this.findGroundSpot(x, y, z, 2, false);
    return spot ? this.set(spot[0], spot[1], spot[2], id, 'spread') : false;
  }

  // ---------- 规则：柱状植物生长 ----------

  private tickColumn(x: number, y: number, z: number, id: BlockId): boolean {
    const max = id === this.id.bamboo ? 8 : 3;
    let top = y;
    let base = y;
    while (top + 1 < H && this.world.getBlock(x, top + 1, z) === id) top++;
    while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === id) base--;
    if (top - base + 1 >= max) {
      // 竹子长满后横向扩繁
      if (id !== this.id.bamboo || this.rng() > 0.06) return false;
      const spot = this.findGroundSpot(base, top, z, 2, true);
      return spot ? this.set(spot[0], spot[1], spot[2], id, 'spread') : false;
    }
    if (this.world.getBlock(x, top + 1, z) !== AIR) return false;
    if (this.rng() > (id === this.id.bamboo ? 0.42 : 0.3)) return false;
    return this.set(x, top + 1, z, id, 'grow');
  }

  private tickCactus(x: number, y: number, z: number): boolean {
    let top = y;
    let base = y;
    while (top + 1 < H && this.world.getBlock(x, top + 1, z) === this.id.cactus) top++;
    while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === this.id.cactus) base--;
    if (top - base + 1 >= 3) return false;
    if (this.world.getBlock(x, top + 1, z) !== AIR) return false;
    if (this.rng() > 0.22) return false;
    return this.set(x, top + 1, z, this.id.cactus, 'grow');
  }

  private tickAquatic(x: number, y: number, z: number, id: BlockId): boolean {
    if (id === this.id.kelp) {
      let top = y;
      let base = y;
      while (top + 1 < H && this.world.getBlock(x, top + 1, z) === id) top++;
      while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === id) base--;
      if (top - base + 1 >= 10) return false;
      const above = this.world.getBlock(x, top + 1, z);
      if (above !== this.id.water) return false;
      if (this.rng() > 0.3) return false;
      return this.set(x, top + 1, z, id, 'grow');
    }
    // 海草在海床上成片蔓延
    if (this.rng() > 0.14) return false;
    const [dx, dz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(dx, y, dz) !== this.id.water) return false;
    if (!this.registry.isSolid(this.world.getBlock(dx, y - 1, dz))) return false;
    return this.set(dx, y, dz, id, 'spread');
  }

  private tickLily(x: number, y: number, z: number): boolean {
    if (this.rng() > 0.1) return false;
    const [nx, nz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(nx, y, nz) !== AIR) return false;
    const below = this.world.getBlock(nx, y - 1, nz);
    if (below !== this.id.water) return false;
    return this.set(nx, y, nz, this.id.lilyPad, 'spread');
  }

  private tickVine(x: number, y: number, z: number): boolean {
    if (this.rng() > 0.3) return false;
    // 优先向下垂挂（y 减小），其次沿墙面横爬
    if (this.rng() < 0.6) {
      if (y - 1 >= 1 && this.world.getBlock(x, y - 1, z) === AIR) {
        return this.set(x, y - 1, z, this.id.vine, 'grow');
      }
      return false;
    }
    const [nx, nz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(nx, y, nz) !== AIR) return false;
    return this.set(nx, y, nz, this.id.vine, 'spread');
  }

  private tickLichen(x: number, y: number, z: number): boolean {
    if (this.world.getSkyLight(x, y, z) >= 8 || this.world.getBlockLight(x, y, z) >= 8) return false;
    if (this.rng() > 0.18) return false;
    for (let i = 0; i < 6; i++) {
      const nx = x + ((this.rng() * 5) | 0) - 2;
      const ny = y + ((this.rng() * 3) | 0) - 1;
      const nz = z + ((this.rng() * 5) | 0) - 2;
      if (ny < 1 || ny >= H - 1) continue;
      if (this.world.getBlock(nx, ny, nz) !== AIR) continue;
      if (!this.hasSolidNeighbor(nx, ny, nz)) continue;
      return this.set(nx, ny, nz, this.id.glowLichen, 'spread');
    }
    return false;
  }

  private tickMoss(x: number, y: number, z: number): boolean {
    if (this.world.getSkyLight(x, y, z) < 5) return false;
    if (this.rng() > 0.14) return false;
    const spot = this.findGroundSpot(x, y, z, 2, false);
    return spot ? this.set(spot[0], spot[1], spot[2], this.id.mossCarpet, 'spread') : false;
  }

  // ---------- 规则：作物 / 浆果 / 南瓜 ----------

  private tickWheat(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (daylight < 0.15 || this.world.getSkyLight(x, y, z) < 9) return false;
    if (this.rng() > 0.22) return false;
    const next = id === this.id.wheatSeedling ? this.id.wheatGrowing : this.id.wheat;
    return next ? this.set(x, y, z, next, 'grow') : false;
  }

  private tickBerry(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (id === this.id.berryBush) {
      if (daylight < 0.12 || this.rng() > 0.18) return false;
      return this.set(x, y, z, this.id.berryBushRipe, 'ripen');
    }
    if (this.rng() > 0.06) return false;
    const spot = this.findGroundSpot(x, y, z, 2, true);
    return spot ? this.set(spot[0], spot[1], spot[2], this.id.berryBush, 'spread') : false;
  }

  private tickPumpkinStem(x: number, y: number, z: number, daylight: number): boolean {
    if (daylight < 0.15 || this.rng() > 0.12) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (this.world.getBlock(nx, y, nz) !== AIR) continue;
      if (!this.registry.isSolid(this.world.getBlock(nx, y - 1, nz))) continue;
      return this.set(nx, y, nz, this.id.pumpkin, 'grow');
    }
    return false;
  }

  // ---------- 规则：树苗长成树 ----------

  private tickSapling(x: number, y: number, z: number, species: TreeSpecies, daylight: number): boolean {
    if (daylight < 0.12 || this.world.getSkyLight(x, y, z) < 9) return false;
    if (this.rng() > 0.08) return false;
    const below = this.world.getBlock(x, y - 1, z);
    if (!this.isSoil(below)) return false;

    const shape = buildTree(species, this.rng);
    let maxDy = 0;
    for (const b of shape) if (b.dy > maxDy) maxDy = b.dy;
    if (y + maxDy >= H) return false;
    // 净空检查：只要会覆盖非空气（树苗自身除外）就放弃，避免长进玩家建筑
    for (const b of shape) {
      const id = this.world.getBlock(x + b.dx, y + b.dy, z + b.dz);
      if (id !== AIR && !(b.dx === 0 && b.dz === 0 && b.dy === 0)) return false;
    }

    this.world.setBlock(x, y, z, AIR);
    let changed = false;
    for (const b of shape) {
      const tx = x + b.dx;
      const ty = y + b.dy;
      const tz = z + b.dz;
      if (ty < 1 || ty >= H) continue;
      if (b.kind === 'log') {
        if (this.world.setBlock(tx, ty, tz, this.logOf(species))) changed = true;
      } else if (this.world.getBlock(tx, ty, tz) === AIR) {
        if (this.world.setBlock(tx, ty, tz, this.leafOf(species))) changed = true;
      }
    }
    if (changed) this.events?.emit('plant:grow', { x, y, z, block: this.logOf(species), kind: 'grow' });
    return changed;
  }

  private logOf(species: TreeSpecies): BlockId {
    const name = species === 'birch' ? 'birch_log' : species === 'spruce' ? 'spruce_log' : 'oak_log';
    return this.registry.byNameGet(name)?.id ?? 0;
  }

  private leafOf(species: TreeSpecies): BlockId {
    const name = species === 'birch' ? 'birch_leaves' : species === 'spruce' ? 'spruce_leaves' : 'oak_leaves';
    return this.registry.byNameGet(name)?.id ?? 0;
  }

  // ---------- 工具 ----------

  private isSoil(id: BlockId): boolean {
    return id === this.id.grass || id === this.id.dirt || id === this.id.podzol;
  }

  private pickNeighbor(x: number, z: number): [number, number] {
    switch ((this.rng() * 4) | 0) {
      case 0: return [x + 1, z];
      case 1: return [x - 1, z];
      case 2: return [x, z + 1];
      default: return [x, z - 1];
    }
  }

  private hasSolidNeighbor(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of DIRS) {
      const n = this.world.getBlock(x + dx, y + dy, z + dz);
      if (n !== AIR && this.registry.isSolid(n)) return true;
    }
    return false;
  }

  private findGroundSpot(
    x: number, y: number, z: number, radius: number, needLight: boolean,
  ): [number, number, number] | null {
    for (let i = 0; i < 8; i++) {
      const nx = x + ((this.rng() * (radius * 2 + 1)) | 0) - radius;
      const ny = y + ((this.rng() * 3) | 0) - 1;
      const nz = z + ((this.rng() * (radius * 2 + 1)) | 0) - radius;
      if (ny < 1 || ny >= H - 1) continue;
      if (nx === x && ny === y && nz === z) continue;
      if (this.world.getBlock(nx, ny, nz) !== AIR) continue;
      if (!this.isSoil(this.world.getBlock(nx, ny - 1, nz))) continue;
      if (needLight && this.world.getSkyLight(nx, ny, nz) < 9) continue;
      return [nx, ny, nz];
    }
    return null;
  }

  private set(x: number, y: number, z: number, id: BlockId, kind: GrowKind): boolean {
    if (!id) return false;
    if (!this.world.setBlock(x, y, z, id)) return false;
    this.events?.emit('plant:grow', { x, y, z, block: id, kind });
    return true;
  }
}
