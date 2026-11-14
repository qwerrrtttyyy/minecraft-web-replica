/**
 * 地形生成回归（纯逻辑，不需要 WebGL / 浏览器）。
 * 运行：node test/terrain-check.cjs
 */
const assert = require('assert');
const { DefaultGenerator, DEFAULT_TERRAIN } = require('./.build/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./.build/world/blocks.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H, SEA_LEVEL } = require('./.build/core/types.js');

const idx = (x, y, z) => (y * CS + z) * CS + x;
const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

function make(seed, opts) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  return { reg, gen: new DefaultGenerator(seed, reg, opts) };
}
function chunk(gen, cx, cz) {
  const data = new Uint8Array(CS * CS * H);
  gen.generateChunk(cx, cz, data);
  return data;
}
const ids = (reg) => ({
  air: 0,
  water: reg.byNameGet('water').id,
  grass: reg.byNameGet('grass').id,
  stone: reg.byNameGet('stone').id,
  log: reg.byNameGet('oak_log').id,
  leaves: reg.byNameGet('oak_leaves').id,
  coal: reg.byNameGet('coal_ore').id,
  iron: reg.byNameGet('iron_ore').id,
  gold: reg.byNameGet('gold_ore').id,
  diamond: reg.byNameGet('diamond_ore').id,
  glowstone: reg.byNameGet('glowstone').id,
});

log('地形生成回归');

// 1) 确定性 + 生成顺序无关（跨区块树冠的关键性质）
{
  const a = make(12345);
  const b = make(12345);
  const left = chunk(a.gen, 0, 0);
  // 故意先生成邻区块，再生成目标区块
  chunk(b.gen, 1, 0);
  chunk(b.gen, 0, 1);
  chunk(b.gen, 1, 1);
  const left2 = chunk(b.gen, 0, 0);
  ok('同 seed 区块完全一致', Buffer.from(left).equals(Buffer.from(left2)));
  const c = make(12346);
  ok('不同 seed 产生不同地形', !Buffer.from(left).equals(Buffer.from(chunk(c.gen, 0, 0))));
}

// 2) 高度范围 + 出生点保底陆地
{
  const { gen } = make(2026);
  const h0 = gen.surfaceHeight(0, 0);
  ok('出生点 (0,0) 是陆地', h0 > SEA_LEVEL, `h=${h0}`);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const x = ((i * 37) % 2001) - 1000;
    const z = ((i * 91) % 2001) - 1000;
    const h = gen.surfaceHeight(x, z);
    min = Math.min(min, h); max = Math.max(max, h);
  }
  ok('高度始终在合法区间', min >= 4 && max <= H - 14, `${min}..${max}`);
  ok('地形有明显起伏', max - min >= 18, `跨度 ${max - min}`);
  const ci = gen.columnInfo(31, -17);
  ok('columnInfo 返回坡度与群系', ci.slope >= 0 && ci.slope <= 1 && ci.biome === gen.biomeAt(31, -17));
}

// 3) 地形柱与水面一致性、洞穴不穿地表
{
  const { reg, gen } = make(777);
  const I = ids(reg);
  for (const [cx, cz] of [[0, 0], [1, 0], [-2, 3], [5, -4]]) {
    const data = chunk(gen, cx, cz);
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const wx = cx * CS + lx, wz = cz * CS + lz;
        const h = gen.surfaceHeight(wx, wz);
        const top = data[idx(lx, h, lz)];
        assert.ok(top !== 0 && top !== I.water,
          `列 ${wx},${wz} 地形顶不应是空气/水 (top=${top})`);
        // 地表 4 层必须是实心，洞穴不能塌陷到地表
        for (let y = Math.max(1, h - 3); y <= h; y++) {
          assert.ok(data[idx(lx, y, lz)] !== 0, `列 ${wx},${wz} 第 ${y} 层被洞穴挖穿`);
        }
        if (h < SEA_LEVEL) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) {
            assert.strictEqual(data[idx(lx, y, lz)], I.water, `列 ${wx},${wz} 缺少海水`);
          }
          assert.notStrictEqual(data[idx(lx, SEA_LEVEL + 1, lz)], I.water, '海平面以上不应有水');
        }
      }
    }
  }
  ok('地形柱 / 水面 / 洞穴顶连续（4 区块 × 256 列）', true);
}

// 4) 群系多样性 + 矿石分层 + 洞穴确实存在
{
  const { reg, gen } = make(4242);
  const I = ids(reg);
  const biomes = new Set();
  for (let x = -256; x < 256; x += 8) {
    for (let z = -256; z < 256; z += 8) biomes.add(gen.biomeAt(x, z));
  }
  ok('群系具备多样性', biomes.size >= 3, [...biomes].join('/'));

  const data = chunk(gen, 0, 0);
  const counts = { coal: 0, iron: 0, gold: 0, diamond: 0, glowstone: 0, cave: 0 };
  const depthMax = { coal: 52, iron: 40, gold: 26, diamond: 16, glowstone: 24 };
  for (let y = 1; y < H; y++) {
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const v = data[idx(lx, y, lz)];
        if (v === 0 && y > 3 && y < 45) counts.cave++;
        if (v === I.coal) { counts.coal++; assert.ok(y <= depthMax.coal, '煤矿超深'); }
        else if (v === I.iron) { counts.iron++; assert.ok(y <= depthMax.iron, '铁矿超深'); }
        else if (v === I.gold) { counts.gold++; assert.ok(y <= depthMax.gold, '金矿超深'); }
        else if (v === I.diamond) { counts.diamond++; assert.ok(y <= depthMax.diamond, '钻石超深'); }
        else if (v === I.glowstone) { counts.glowstone++; assert.ok(y <= depthMax.glowstone, '萤石超深'); }
      }
    }
  }
  ok('矿脉按深度分层', counts.coal > 0 && counts.iron > 0,
    `煤${counts.coal} 铁${counts.iron} 金${counts.gold} 钻${counts.diamond} 萤石${counts.glowstone}`);
  ok('地下存在洞穴空腔', counts.cave > 50, `空气体素 ${counts.cave}`);
}

// 5) 跨区块树冠：邻区块必须补齐被裁掉的半个树冠
{
  const I = ids(make(1).reg);
  let found = null;
  for (let seed = 1; seed <= 120 && !found; seed++) {
    const { gen } = make(seed);
    const left = chunk(gen, 0, 0);
    const right = chunk(gen, 1, 0);
    for (let lx = CS - 4; lx < CS; lx++) {
      for (let lz = 2; lz < CS - 2; lz++) {
        for (let y = SEA_LEVEL + 2; y < SEA_LEVEL + 14; y++) {
          if (left[idx(lx, y, lz)] !== I.log) continue;
          let leaves = 0;
          for (let dx = 0; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              const zz = lz + dz;
              if (zz < 0 || zz >= CS) continue;
              for (let yy = y - 2; yy <= y + 8; yy++) {
                if (yy >= 0 && yy < H && right[idx(dx, yy, zz)] === I.leaves) leaves++;
              }
            }
          }
          if (leaves > 0) { found = { seed, lx, lz, y, leaves }; break; }
        }
        if (found) break;
      }
      if (found) break;
    }
  }
  ok('跨区块树冠连续（无半棵树）', !!found,
    found ? `seed=${found.seed} 树干@lx${found.lx},lz${found.lz},y${found.y} 邻块树叶 ${found.leaves}` : '未找到边界树');
}

// 6) 可调参数生效
{
  const { gen } = make(99, { oreRichness: 0, treeDensity: {} });
  const I = ids(make(1).reg);
  const data = chunk(gen, 0, 0);
  let logs = 0, ores = 0;
  for (const v of data) {
    if (v === I.log) logs++;
    if (v === I.coal || v === I.iron || v === I.gold || v === I.diamond) ores++;
  }
  ok('oreRichness=0 关闭矿脉', ores === 0);
  ok('treeDensity={} 关闭树木', logs === 0);
  ok('默认参数可导出', DEFAULT_TERRAIN.warp > 0 && DEFAULT_TERRAIN.oreRichness === 1);
}

// 7) 水下地层不得出现空气袋（洞穴必须避开海床）
{
  const { reg, gen } = make(2026);
  const I = ids(reg);
  const oceanChunks = [];
  for (let cx = -8; cx <= 8; cx++) {
    for (let cz = -8; cz <= 8; cz++) {
      let n = 0;
      for (let i = 0; i < CS; i++) {
        for (let j = 0; j < CS; j++) if (gen.surfaceHeight(cx * CS + i, cz * CS + j) < SEA_LEVEL) n++;
      }
      if (n > 100) oceanChunks.push([cx, cz]);
    }
  }
  ok('存在成片海洋', oceanChunks.length >= 3, `${oceanChunks.length} 个海洋区块`);
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
        assert.notStrictEqual(data[idx(lx, h, lz)], I.water, '海床顶面不应是水');
      }
    }
  }
  ok('水下地层无空气袋', total > 1000 && air === 0, `${total} 体素，空气 ${air}`);
}

// 8) 河道在海岸平滑收口，不切深海床
{
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
  ok('河道确实切出河谷', changed > 100 && maxDrop >= 4, `${changed} 列，最大降幅 ${maxDrop}`);
  ok('河道不切深海床', cutSeabed === 0, `越界列 ${cutSeabed}`);
}

// 9) 任意 seed 都出生在陆地
{
  const bad = [];
  for (let seed = 1; seed <= 40; seed++) {
    const h = make(seed).gen.surfaceHeight(0, 0);
    if (h <= SEA_LEVEL) bad.push([seed, h]);
  }
  ok('40 个 seed 出生点均为陆地', bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 4)) : '');
}

// 10) 旧存档兼容：内置方块 id 不变，矿石追加在表尾
{
  const { reg } = make(1);
  const legacy = ['grass', 'dirt', 'stone', 'cobblestone', 'sand', 'oak_log', 'oak_planks',
    'oak_leaves', 'glass', 'bricks', 'water', 'bedrock', 'glowstone', 'snow', 'tnt',
    'white_wool', 'red_wool', 'blue_wool', 'yellow_wool', 'tall_grass', 'poppy', 'dandelion'];
  const stable = legacy.every((n, i) => reg.byNameGet(n).id === i + 1);
  const ores = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'].map((n) => reg.byNameGet(n).id);
  ok('旧 22 种方块 id 未变（edits 差分兼容）', stable);
  ok('4 种矿石追加在表尾', ores.every((v, i) => v === legacy.length + 1 + i), ores.join(','));
}

// 11) 跨区块树冠双向对称（-x 方向也不能缺半边）
{
  const I = ids(make(1).reg);
  let found = null;
  for (let seed = 1; seed <= 120 && !found; seed++) {
    const gen = make(seed).gen;
    const right = chunk(gen, 0, 0);   // 树干在本区块左边界
    const left = chunk(gen, -1, 0);   // 树冠应延伸到左邻块
    for (let lx = 0; lx < 4 && !found; lx++) {
      for (let lz = 2; lz < CS - 2 && !found; lz++) {
        for (let y = SEA_LEVEL + 2; y < SEA_LEVEL + 14; y++) {
          if (right[idx(lx, y, lz)] !== I.log) continue;
          let leaves = 0;
          for (let dx = -2; dx <= 0; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              const zz = lz + dz;
              if (zz < 0 || zz >= CS) continue;
              for (let yy = y - 2; yy <= y + 8; yy++) {
                if (yy >= 0 && yy < H && left[idx(CS + dx, yy, zz)] === I.leaves) leaves++;
              }
            }
          }
          if (leaves > 0) { found = { seed, lx, lz, y, leaves }; break; }
        }
      }
    }
  }
  ok('跨区块树冠双向连续（-x 方向）', !!found,
    found ? `seed=${found.seed} 邻块树叶 ${found.leaves}` : '未找到边界树');
}

// 12) 性能基准（防止地形算法把 4ms 帧预算拖垮）
{
  const { gen } = make(31337);
  const t0 = Date.now();
  for (let cx = -2; cx < 2; cx++) {
    for (let cz = -2; cz < 2; cz++) chunk(gen, cx, cz);
  }
  const avg = (Date.now() - t0) / 16;
  ok('单区块平均生成耗时 < 40ms', avg < 40, `${avg.toFixed(1)} ms/区块`);
}

log(`\nPASS 地形生成回归：${passed} 组断言全部通过`);
