/**
 * 网格化热点护栏的固定 fixture（M01）。
 *
 * 运行前置：npm run test:snapshot（本文件只 require 编译后的快照，不 import TS）。
 *
 * 这里生成 6×4 = 24 个区块的「生产路径」输入：
 * - seed 2026，真实 DefaultGenerator + World.ensureChunk（含光照初始化）；
 * - config 用与 test/mesher-check.cjs 相同的确定性 UV 替身（图集在 Node 侧不可用）；
 * - greedy=true、mergeEmissive=true 为生产默认；
 * - 每个区块用 buildMeshSnapshot + SnapshotMeshSource，与 Worker 默认路径一致。
 *
 * makeMeshSet() 每次构造都走同一固定顺序（区块生成顺序影响跨块光照传播），
 * 因此 24 项及其哈希在同一份源码快照上是完全确定的。
 */
const { createHash } = require('node:crypto');
const { DefaultGenerator } = require('./terrain-logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { World } = require('./terrain-logic/world/world.js');
const { EventService } = require('./terrain-logic/core/events.js');
const { buildMeshConfig, buildMeshSnapshot } = require('./terrain-logic/world/meshSource.js');
const { packMesh } = require('./terrain-logic/world/meshTypes.js');

const SEED = 2026;
const CX_MIN = 0,
  CX_MAX = 5;
const CZ_MIN = 0,
  CZ_MAX = 3;
/** 保证 24 个目标块各有完整 3×3 邻域，halo 全部来自已生成区块 */
const HALO = 1;

/** 与 test/mesher-check.cjs 的 makeConfig 相同的确定性 UV 替身 */
function makeConfig(reg, greedy, mergeEmissive = true) {
  const order = new Map();
  const slot = (name) => {
    if (!name) return 0;
    if (!order.has(name)) order.set(name, order.size);
    return order.get(name);
  };
  const atlas = {
    uv(name) {
      const i = slot(name);
      const u0 = (i % 16) / 16;
      const v0 = Math.floor(i / 16) / 16;
      return [u0, v0, u0 + 1 / 16, v0 + 1 / 16];
    },
  };
  return buildMeshConfig(reg, atlas, greedy, 1, mergeEmissive);
}

/** 固定顺序构造 24 项 fixture：{ cx, cz, config, snapshot } */
function makeMeshSet() {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const world = new World(reg, new DefaultGenerator(SEED, reg), new EventService());

  // 生成目标块 + 一圈邻居；固定 cz 外层、cx 内层（LightEngine 扩散与顺序相关）
  for (let cz = CZ_MIN - HALO; cz <= CZ_MAX + HALO; cz++) {
    for (let cx = CX_MIN - HALO; cx <= CX_MAX + HALO; cx++) world.ensureChunk(cx, cz);
  }

  // 24 项共享同一份低频 config，与生产侧「配置只下发一次」一致
  const config = makeConfig(reg, true, true);
  const set = [];
  for (let cz = CZ_MIN; cz <= CZ_MAX; cz++) {
    for (let cx = CX_MIN; cx <= CX_MAX; cx++) {
      set.push({ cx, cz, config, snapshot: buildMeshSnapshot(world, cx, cz) });
    }
  }
  return set;
}

/**
 * 输出序列化格式（护栏 wire format，顺序写死，后续优化不得改）：
 *   通道：opaque, emissive, transparent, water
 *   属性：positions, uvs, shade, lights, tile, tints, sways, indices
 * 只拼接各 packed TypedArray 的精确字节区间；null 通道不占位。
 * stats.ms 是计时数据，不进哈希。
 */
const CHANNEL_ORDER = ['opaque', 'emissive', 'transparent', 'water'];
const ATTR_ORDER = ['positions', 'uvs', 'shade', 'lights', 'tile', 'tints', 'sways', 'indices'];

function serializeMesh(out) {
  const { mesh } = packMesh(out);
  const parts = [];
  for (const ch of CHANNEL_ORDER) {
    const g = mesh[ch];
    if (!g) continue;
    for (const key of ATTR_ORDER) {
      const view = g[key];
      parts.push(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    }
  }
  return Buffer.concat(parts);
}

/** 单块输出 sha256 hex（hex 字符固定 64 位，便于基线比对） */
function meshHash(out) {
  return createHash('sha256').update(serializeMesh(out)).digest('hex');
}

module.exports = { makeMeshSet, serializeMesh, meshHash };
