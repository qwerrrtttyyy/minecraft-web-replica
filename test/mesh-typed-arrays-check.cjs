/**
 * packMesh typed-array 回归（M02 / B.4）。
 *
 * 运行：node test/mesh-typed-arrays-check.cjs（前置：npm run test:snapshot）
 *
 * 几何收集期为了去 GC 会改用「预分配 typed array + 已写入长度」，
 * packMesh 必须只打包已写入的前缀：普通 number[] 用自身 length，
 * typed array 用 GeoArrays.used 标出的长度。预分配容量的尾部（默认 0）
 * 绝不能进入 GPU 几何，否则输出逐字节判据（M01 基线）会被破坏。
 */
const assert = require('node:assert');
const { packMesh } = require('./terrain-logic/world/meshTypes.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const CAP = 8;
/** 每个分量前 4 项有效（indices 6 项 = 1 个 quad 的索引）；末尾故意放 0，防止靠“裁掉尾部 0”蒙混过关 */
const VALUES = {
  // 全部取 1/8 的倍数，保证在 float32 中精确表示，逐值比较不会被舍入干扰
  positions: [1.5, 2.5, 3.5, 0],
  uvs: [0.125, 0.25, 0.375, 0],
  shade: [0.5, 0.625, 0.75, 0],
  lights: [0.875, 0.75, 0.625, 0],
  tile: [0.25, 0.5, 0.75, 0],
  tints: [0, 1, 2, 0],
  sways: [0.125, 0.25, 0.375, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
const KEYS = Object.keys(VALUES);

/** 普通 number[] 版本：数组自身长度就是已写入长度 */
function plainGeo() {
  const g = {};
  for (const k of KEYS) g[k] = VALUES[k].slice();
  return g;
}

/** typed array 版本：容量 8，只写前 N 项，其余保持 0；用 used 显式标出前缀长度 */
function typedGeo() {
  const g = { used: {} };
  for (const k of KEYS) {
    const Ctor = k === 'indices' ? Uint32Array : Float32Array;
    const a = new Ctor(CAP);
    VALUES[k].forEach((v, i) => { a[i] = v; });
    g[k] = a;
    g.used[k] = VALUES[k].length;
  }
  return g;
}

const pack = (geo) => packMesh({ opaque: geo, emissive: null, transparent: null, water: null }).mesh.opaque;

console.log('packMesh typed-array 回归（预分配容量不入几何）');

// 1) 普通 number[] 是基线：打包结果 = 原始值，长度 = 数组长度
{
  const out = pack(plainGeo());
  for (const k of KEYS) {
    ok(`number[] 基线·${k} 长度`, out[k].length === VALUES[k].length,
      `${out[k].length} vs ${VALUES[k].length}`);
    ok(`number[] 基线·${k} 逐值`, VALUES[k].every((v, i) => out[k][i] === v));
  }
}

// 2) typed array：必须按 used 截断，且与 number[] 版本逐字节一致
{
  const typed = typedGeo();
  const out = pack(typed);
  for (const k of KEYS) {
    ok(`typed·${k} 只打包已写入前缀`, out[k].length === VALUES[k].length,
      `期望 ${VALUES[k].length}，实得 ${out[k].length}（容量 ${CAP}）`);
    ok(`typed·${k} 逐值等于 number[] 版本`,
      VALUES[k].every((v, i) => out[k][i] === v));
  }
  const plainOut = pack(plainGeo());
  ok('typed / number[] 打包结果逐字节一致',
    KEYS.every((k) => plainOut[k].length === out[k].length &&
      plainOut[k].every((v, i) => v === out[k][i])));
  ok('尾部有效 0 未被裁掉（used 优先于尾部探测）',
    out.positions[3] === 0 && out.indices[3] === 0 && out.positions.length === 4);
}

// 3) 满容量 typed array（无 used）也必须原样打包，不能误截
{
  const full = {};
  for (const k of KEYS) {
    const Ctor = k === 'indices' ? Uint32Array : Float32Array;
    const a = new Ctor(CAP);
    for (let i = 0; i < CAP; i++) a[i] = i + 1;
    full[k] = a;
  }
  const out = pack(full);
  ok('满容量 typed array 不指定 used 时打包全部元素',
    KEYS.every((k) => out[k].length === CAP && out[k].every((v, i) => v === i + 1)));
}

// 4) 空通道仍返回 null（签名与行为不变）
{
  const r = packMesh({ opaque: null, emissive: null, transparent: null, water: null });
  ok('全空 ChunkMeshData 的 mesh 全为 null',
    ['opaque', 'emissive', 'transparent', 'water'].every((k) => r.mesh[k] === null));
  ok('全空 ChunkMeshData 不产生 transfer',
    r.transfer.length === 0);
}

console.log(`\n合计 ${passed} 项全部通过`);
