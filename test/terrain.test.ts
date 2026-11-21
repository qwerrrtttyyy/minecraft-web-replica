/**
 * 地形生成回归（Vitest，直接消费 src TS 源码）。
 * 运行：npm run test:terrain:vitest
 * 断言语义与 test/terrain-check.cjs 一一对应（迁移，未改动断言行为）。
 */
import { describe, expect, it } from 'vitest';

import { DefaultGenerator, DEFAULT_TERRAIN } from '../src/world/generator';
import { BlockRegistry, registerBuiltinBlocks } from '../src/world/blocks';
import { CHUNK_SIZE as CS, WORLD_HEIGHT as H, SEA_LEVEL } from '../src/core/types';

const idx = (x: number, y: number, z: number) => (y * CS + z) * CS + x;

function make(seed: number, opts?: Record<string, unknown>) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  return { reg, gen: new DefaultGenerator(seed, reg, opts as never) };
}
function chunk(gen: DefaultGenerator, cx: number, cz: number) {
  const data = new Uint8Array(CS * CS * H);
  gen.generateChunk(cx, cz, data);
  return data;
}
const ids = (reg: BlockRegistry) => ({
  air: 0,
  water: reg.byNameGet('water')!.id,
  grass: reg.byNameGet('grass')!.id,
  stone: reg.byNameGet('stone')!.id,
  log: reg.byNameGet('oak_log')!.id,
  leaves: reg.byNameGet('oak_leaves')!.id,
  coal: reg.byNameGet('coal_ore')!.id,
  iron: reg.byNameGet('iron_ore')!.id,
  gold: reg.byNameGet('gold_ore')!.id,
  diamond: reg.byNameGet('diamond_ore')!.id,
  glowstone: reg.byNameGet('glowstone')!.id,
});

// 1) 确定性 + 生成顺序无关（跨区块树冠的关键性质）
describe('确定性', () => {
  it('同 seed 区块完全一致（生成顺序无关）', () => {
    const a = make(12345);
    const b = make(12345);
    const left = chunk(a.gen, 0, 0);
    // 故意先生成邻区块，再生成目标区块
    chunk(b.gen, 1, 0);
    chunk(b.gen, 0, 1);
    chunk(b.gen, 1, 1);
    const left2 = chunk(b.gen, 0, 0);
    expect(Buffer.from(left).equals(Buffer.from(left2))).toBe(true);
  });
  it('不同 seed 产生不同地形', () => {
    const left = chunk(make(12345).gen, 0, 0);
    const c = make(12346);
    expect(Buffer.from(left).equals(Buffer.from(chunk(c.gen, 0, 0)))).toBe(false);
  });
});

// 2) 高度范围 + 出生点保底陆地
describe('高度范围', () => {
  it('出生点 (0,0) 是陆地', () => {
    const { gen } = make(2026);
    const h0 = gen.surfaceHeight(0, 0);
    expect(h0).toBeGreaterThan(SEA_LEVEL);
  });
  it('高度始终在合法区间且有明显起伏；columnInfo 返回坡度与群系', () => {
    const { gen } = make(2026);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 37) % 2001) - 1000;
      const z = ((i * 91) % 2001) - 1000;
      const h = gen.surfaceHeight(x, z);
      min = Math.min(min, h); max = Math.max(max, h);
    }
    expect(min).toBeGreaterThanOrEqual(4);
    expect(max).toBeLessThanOrEqual(H - 14);
    expect(max - min).toBeGreaterThanOrEqual(18);
    const ci = gen.columnInfo(31, -17);
    expect(ci.slope).toBeGreaterThanOrEqual(0);
    expect(ci.slope).toBeLessThanOrEqual(1);
    expect(ci.biome).toBe(gen.biomeAt(31, -17));
  });
});

// 3) 地形柱与水面一致性、洞穴不穿地表
describe('地形柱 / 水面 / 洞穴顶连续', () => {
  it('4 区块 × 256 列：地表实心、海水填满、海平面以上无水', () => {
    const { reg, gen } = make(777);
    const I = ids(reg);
    for (const [cx, cz] of [[0, 0], [1, 0], [-2, 3], [5, -4]]) {
      const data = chunk(gen, cx, cz);
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const wx = cx * CS + lx, wz = cz * CS + lz;
          const h = gen.surfaceHeight(wx, wz);
          const top = data[idx(lx, h, lz)];
          expect(top !== 0 && top !== I.water).toBe(true);
          // 地表 4 层必须是实心，洞穴不能塌陷到地表
          for (let y = Math.max(1, h - 3); y <= h; y++) {
            expect(data[idx(lx, y, lz)] !== 0).toBe(true);
          }
          if (h < SEA_LEVEL) {
            for (let y = h + 1; y <= SEA_LEVEL; y++) {
              expect(data[idx(lx, y, lz)]).toBe(I.water);
            }
            expect(data[idx(lx, SEA_LEVEL + 1, lz)]).not.toBe(I.water);
          }
        }
      }
    }
  });
});

// 4) 群系多样性 + 矿石分层 + 洞穴确实存在
describe('群系 / 矿石 / 洞穴', () => {
  it('群系具备多样性', () => {
    const { gen } = make(4242);
    const biomes = new Set<string>();
    for (let x = -256; x < 256; x += 8) {
      for (let z = -256; z < 256; z += 8) biomes.add(gen.biomeAt(x, z));
    }
    expect(biomes.size).toBeGreaterThanOrEqual(3);
  });
  it('矿脉按深度分层，地下存在洞穴空腔', () => {
    const { reg, gen } = make(4242);
    const I = ids(reg);
    const data = chunk(gen, 0, 0);
    const counts = { coal: 0, iron: 0, gold: 0, diamond: 0, glowstone: 0, cave: 0 };
    const depthMax: Record<string, number> = { coal: 52, iron: 40, gold: 26, diamond: 16, glowstone: 24 };
    for (let y = 1; y < H; y++) {
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const v = data[idx(lx, y, lz)];
          if (v === 0 && y > 3 && y < 45) counts.cave++;
          if (v === I.coal) { counts.coal++; expect(y).toBeLessThanOrEqual(depthMax.coal); }
          else if (v === I.iron) { counts.iron++; expect(y).toBeLessThanOrEqual(depthMax.iron); }
          else if (v === I.gold) { counts.gold++; expect(y).toBeLessThanOrEqual(depthMax.gold); }
          else if (v === I.diamond) { counts.diamond++; expect(y).toBeLessThanOrEqual(depthMax.diamond); }
          else if (v === I.glowstone) { counts.glowstone++; expect(y).toBeLessThanOrEqual(depthMax.glowstone); }
        }
      }
    }
    expect(counts.coal).toBeGreaterThan(0);
    expect(counts.iron).toBeGreaterThan(0);
    expect(counts.cave).toBeGreaterThan(50);
  });
});

// 5 + 11) 跨区块树冠：邻区块必须补齐被裁掉的半个树冠（双向）
describe('跨区块树冠连续', () => {
  function findBorderTree(dir: 1 | -1) {
    const I = ids(make(1).reg);
    for (let seed = 1; seed <= 120; seed++) {
      const gen = make(seed).gen;
      const near = chunk(gen, 0, 0);
      const neighbor = chunk(gen, dir, 0);
      for (let lx = (dir === 1 ? CS - 4 : 0); (dir === 1 ? lx < CS : lx < 4); lx++) {
        for (let lz = 2; lz < CS - 2; lz++) {
          for (let y = SEA_LEVEL + 2; y < SEA_LEVEL + 14; y++) {
            if (near[idx(lx, y, lz)] !== I.log) continue;
            let leaves = 0;
            for (let dx = (dir === 1 ? 0 : -2); dx <= (dir === 1 ? 2 : 0); dx++) {
              for (let dz = -2; dz <= 2; dz++) {
                const zz = lz + dz;
                if (zz < 0 || zz >= CS) continue;
                for (let yy = y - 2; yy <= y + 8; yy++) {
                  const nx = dir === 1 ? dx : CS + dx;
                  if (yy >= 0 && yy < H && neighbor[idx(nx, yy, zz)] === I.leaves) leaves++;
                }
              }
            }
            if (leaves > 0) return { seed, lx, lz, y, leaves };
          }
        }
      }
    }
    return null;
  }

  it('跨区块树冠连续（无半棵树，+x 方向）', () => {
    const found = findBorderTree(1);
    expect(found).not.toBeNull();
  });
  it('跨区块树冠双向连续（-x 方向）', () => {
    const found = findBorderTree(-1);
    expect(found).not.toBeNull();
  });
});

// 6) 可调参数生效
describe('可调参数', () => {
  it('oreRichness=0 关闭矿脉；treeDensity={} 关闭树木；默认参数可导出', () => {
    const { gen } = make(99, { oreRichness: 0, treeDensity: {} });
    const I = ids(make(1).reg);
    const data = chunk(gen, 0, 0);
    let logs = 0, ores = 0;
    for (const v of data) {
      if (v === I.log) logs++;
      if (v === I.coal || v === I.iron || v === I.gold || v === I.diamond) ores++;
    }
    expect(ores).toBe(0);
    expect(logs).toBe(0);
    expect(DEFAULT_TERRAIN.warp).toBeGreaterThan(0);
    expect(DEFAULT_TERRAIN.oreRichness).toBe(1);
  });
});

// 7) 水下地层不得出现空气袋（洞穴必须避开海床）
describe('水下地层无空气袋', () => {
  it('存在成片海洋且海床下无空气；海床顶面不应是水', () => {
    const { reg, gen } = make(2026);
    const I = ids(reg);
    const oceanChunks: Array<[number, number]> = [];
    for (let cx = -8; cx <= 8; cx++) {
      for (let cz = -8; cz <= 8; cz++) {
        let n = 0;
        for (let i = 0; i < CS; i++) {
          for (let j = 0; j < CS; j++) if (gen.surfaceHeight(cx * CS + i, cz * CS + j) < SEA_LEVEL) n++;
        }
        if (n > 100) oceanChunks.push([cx, cz]);
      }
    }
    expect(oceanChunks.length).toBeGreaterThanOrEqual(3);
    let air = 0, total = 0;
    for (const [cx, cz] of oceanChunks.slice(0, 8)) {
      const data = chunk(gen, cx, cz);
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const h = gen.surfaceHeight(cx * CS + lx, cz * CS + lz);
          if (h >= SEA_LEVEL) continue;
          for (let y = 1; y <= h; y++) {
            total++;
            if (data[idx(lx, y, lz)] === 0) air++;
          }
          expect(data[idx(lx, h, lz)]).not.toBe(I.water);
        }
      }
    }
    expect(total).toBeGreaterThan(1000);
    expect(air).toBe(0);
  });
});

// 8) 河道在海岸平滑收口，不切深海床
describe('河道', () => {
  it('河道确实切出河谷且不切深海床', () => {
    const withRiver = make(2026, { riverDepth: 7 }).gen;
    const noRiver = make(2026, { riverDepth: 0 }).gen;
    let changed = 0, cutSeabed = 0, maxDrop = 0;
    for (let x = -400; x < 400; x += 3) {
      for (let z = -400; z < 400; z += 3) {
        if (x * x + z * z < 220 * 220) continue; // 排除出生抬升的耦合
        const a = withRiver.surfaceHeight(x, z);
        const b = noRiver.surfaceHeight(x, z);
        if (a < b) {
          changed++;
          maxDrop = Math.max(maxDrop, b - a);
          if (b <= SEA_LEVEL - 2) cutSeabed++;
        }
      }
    }
    expect(changed).toBeGreaterThan(100);
    expect(maxDrop).toBeGreaterThanOrEqual(4);
    expect(cutSeabed).toBe(0);
  });
});

// 9) 任意 seed 都出生在陆地
describe('出生点保底', () => {
  it('40 个 seed 出生点均为陆地', () => {
    const bad: Array<[number, number]> = [];
    for (let seed = 1; seed <= 40; seed++) {
      const h = make(seed).gen.surfaceHeight(0, 0);
      if (h <= SEA_LEVEL) bad.push([seed, h]);
    }
    expect(bad).toEqual([]);
  });
});

// 10) 旧存档兼容：内置方块 id 不变，矿石追加在表尾
describe('旧存档兼容（方块 id 只追加）', () => {
  it('旧 22 种方块 id 未变；4 种矿石追加在表尾', () => {
    const { reg } = make(1);
    const legacy = ['grass', 'dirt', 'stone', 'cobblestone', 'sand', 'oak_log', 'oak_planks',
      'oak_leaves', 'glass', 'bricks', 'water', 'bedrock', 'glowstone', 'snow', 'tnt',
      'white_wool', 'red_wool', 'blue_wool', 'yellow_wool', 'tall_grass', 'poppy', 'dandelion'];
    expect(legacy.every((n, i) => reg.byNameGet(n)!.id === i + 1)).toBe(true);
    const ores = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'].map((n) => reg.byNameGet(n)!.id);
    expect(ores.every((v, i) => v === legacy.length + 1 + i)).toBe(true);
  });
});

// 12) 性能基准（防止地形算法把 4ms 帧预算拖垮）
describe('性能基准', () => {
  it('单区块平均生成耗时 < 40ms', () => {
    const { gen } = make(31337);
    const t0 = Date.now();
    for (let cx = -2; cx < 2; cx++) {
      for (let cz = -2; cz < 2; cz++) chunk(gen, cx, cz);
    }
    const avg = (Date.now() - t0) / 16;
    expect(avg).toBeLessThan(40);
  });
});
