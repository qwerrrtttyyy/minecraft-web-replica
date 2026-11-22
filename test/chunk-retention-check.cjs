/**
 * 区块驻留策略回归（纯逻辑，不需要 three 运行时）。
 *
 * 覆盖：
 * - 视距内区块永不因上限被淘汰
 * - 硬外沿之外的区块无条件淘汰
 * - 上限触发时按 lastTouch 从旧到新淘汰，且同 touch 用 key 双键定序
 * - 最短驻留保护：年轻区块不参与 LRU 淘汰
 * - 输入顺序不影响淘汰结果（确定性）
 * - World 的生成/重复生成计数与逻辑时钟 touch
 */
const assert = require('node:assert');
const { selectEvictions } = require('./logic/world/chunkRetention.js');
const { World } = require('./logic/world/world.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const { parseChunkKey } = require('./logic/core/types.js');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

const chunk = (cx, cz, lastTouch = 0, createdAt = 0) => ({ cx, cz, lastTouch, createdAt });
const entries = (...chunks) => chunks.map((c) => [`${c.cx},${c.cz}`, c]);
const base = {
  centerX: 0, centerZ: 0, renderDistance: 4,
  keepRadius: 6, hardRadius: 12, maxResident: 10,
  minResidencySec: 0, now: 100,
};

// 1) keepRadius 内必留；硬外沿之外必卸
{
  const got = selectEvictions(entries(chunk(0, 0), chunk(6, 6), chunk(7, 0), chunk(13, 0)), base);
  ok('视距内（含边界）区块不因上限被淘汰', !got.includes('0,0') && !got.includes('6,6'));
  ok('超过硬外沿的区块无条件淘汰', got.includes('13,0'));
  ok('上限未超时缓冲区区块保留', got.includes('7,0') === false);
}

// 2) 上限触发：按 lastTouch 从旧到新
{
  const list = entries(
    chunk(7, 0, 5), chunk(8, 0, 2), chunk(9, 0, 4),
    chunk(10, 0, 1), chunk(11, 0, 3),
  );
  const got = selectEvictions(list, { ...base, maxResident: 2 });
  // 淘汰顺序为 touch 升序 [10,0(1), 8,0(2), 11,0(3)]；断言里排序后是字典序
  ok('超上限时淘汰最旧的缓冲区区块', JSON.stringify(got) === JSON.stringify(['10,0', '8,0', '11,0']));
}

// 3) 同 touch 用 key 定序 + 输入顺序无关
{
  const a = entries(chunk(10, 0, 1), chunk(-10, 0, 1));
  const b = [...a].reverse();
  const gotA = selectEvictions(a, { ...base, maxResident: 1 });
  const gotB = selectEvictions(b, { ...base, maxResident: 1 });
  ok('同 lastTouch 时按 key 字典序淘汰', gotA.length === 1 && gotA[0] === '-10,0');
  ok('输入顺序不影响淘汰结果', JSON.stringify(gotA) === JSON.stringify(gotB));
}

// 4) 最短驻留保护
{
  const list = entries(chunk(7, 0, 1, 50), chunk(8, 0, 2, 95));
  const got = selectEvictions(list, { ...base, maxResident: 0, minResidencySec: 10 });
  ok('未满最短驻留时间的区块不被 LRU 淘汰', JSON.stringify(got) === JSON.stringify(['7,0']));
}

// 5) 硬外沿不受最短驻留保护
{
  const got = selectEvictions(entries(chunk(13, 0, 1, 99)), {
    ...base, maxResident: 100, minResidencySec: 10,
  });
  ok('硬外沿之外的年轻区块仍被无条件淘汰', got.includes('13,0'));
}

// 6) World 生成计数 / 逻辑时钟
{
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const stone = reg.byNameGet('stone').id;
  const w = new World(reg, { generateChunk() {}, surfaceHeight() { return 32; } }, { emit() {} });

  w.time = 5;
  const first = w.ensureChunk(0, 0);
  ok('新区块创建时记录逻辑时钟', first.createdAt === 5 && first.lastTouch === 5);
  ok('首次生成计入 generatedCount', w.generatedCount === 1 && w.regeneratedCount === 0);

  w.ensureChunk(0, 0);
  ok('重复 ensureChunk 不重复计数', w.generatedCount === 1 && w.regeneratedCount === 0);

  w.time = 10;
  w.touchChunk(0, 0);
  ok('touchChunk 用逻辑时间刷新 lastTouch', first.lastTouch === 10 && first.createdAt === 5);

  w.time = 11;
  w.setBlock(3, 20, 3, stone);
  ok('setBlock 刷新所在区块的 lastTouch', first.lastTouch === 11);

  w.unloadChunk('0,0');
  w.time = 20;
  w.ensureChunk(0, 0);
  ok('卸载后重建计入 regeneratedCount', w.generatedCount === 2 && w.regeneratedCount === 1);
  ok('重建区块时钟取当前逻辑时间', w.getChunk(0, 0).createdAt === 20);
}

// 7) 来回走动仿真：新策略相对旧策略的重复生成次数下降（确定性，不依赖浏览器）
{
  const R = 4;
  const path = [0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0];

  const simulate = (evict) => {
    const resident = new Map();
    const seen = new Set();
    let generated = 0;
    let regenerated = 0;
    let now = 0;
    for (const centerX of path) {
      now += 1;
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dz * dz > R * R + 1) continue;
          const key = `${centerX + dx},${dz}`;
          const c = resident.get(key);
          if (!c) {
            generated++;
            if (seen.has(key)) regenerated++;
            seen.add(key);
            resident.set(key, { cx: centerX + dx, cz: dz, createdAt: now, lastTouch: now });
          } else {
            c.lastTouch = now;
          }
        }
      }
      for (const key of evict(resident, centerX, now)) resident.delete(key);
    }
    return { generated, regenerated, resident: resident.size };
  };

  // 旧策略：超出 R+2 无条件卸载
  const oldWay = simulate((resident, centerX) => {
    const out = [];
    for (const [key, c] of resident) {
      if (Math.max(Math.abs(c.cx - centerX), Math.abs(c.cz)) > R + 2) out.push(key);
    }
    return out;
  });
  // 新策略：视距必留 + 缓冲区 LRU + 硬外沿 R+8 + 上限 512 + 最短驻留 10s
  const newWay = simulate((resident, centerX, now) => selectEvictions(resident, {
    centerX, centerZ: 0, keepRadius: R + 2, hardRadius: R + 8,
    maxResident: 512, minResidencySec: 10, now,
  }));

  ok('仿真：旧策略确实发生重复生成', oldWay.regenerated > 0, `旧=${oldWay.regenerated}`);
  ok('仿真：新策略重复生成次数下降 ≥30%',
    newWay.regenerated <= oldWay.regenerated * 0.7,
    `旧=${oldWay.regenerated} 新=${newWay.regenerated}`);
  ok('仿真：新策略驻留区块不超过上限', newWay.resident <= 512, `驻留=${newWay.resident}`);
}

// 8) 热路径：无临时数组的 chunk key 解析（与 split+map 等价）
{
  const keys = ['0,0', '-1,-2', '15,-30', '1234567,-7654321'];
  const parsed = keys.map(parseChunkKey);
  const expected = keys.map((k) => k.split(',').map(Number));
  ok('chunk key 解析与 split+map 等价', JSON.stringify(parsed) === JSON.stringify(expected));
  ok('解析结果是 [x, z] 数值对', parsed.every((p) => p.length === 2 && p.every(Number.isFinite)));
}

console.log(`\nPASS 区块驻留策略回归：${passed} 组断言`);
