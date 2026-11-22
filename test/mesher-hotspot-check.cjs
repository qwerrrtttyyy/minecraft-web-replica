/**
 * 生产路径输出护栏 + 基线计时（Task 2）。
 *
 * 运行前置：npm run test:snapshot
 *   node test/mesher-hotspot-check.cjs            # 校验输出 hash == baseline.json
 *   node test/mesher-hotspot-check.cjs --record   # 重写 baseline.json（只在改 fixture 时用）
 *
 * 这是 characterization guard：当前未优化代码上先跑绿，后续 mesher 优化必须
 * 保持 hash 不变且 msPerChunk 下降。本脚本不判断提速是否达标（那是 Task 3）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { SnapshotMeshSource } = require('./terrain-logic/world/snapshotSource.js');
const { meshChunk } = require('./terrain-logic/world/mesher.js');
const { makeMeshSet, meshHash } = require('./mesher-fixture.cjs');

const BASELINE_PATH = path.join(__dirname, 'mesher-hotspot-baseline.json');
const ROUNDS = 8;
/**
 * 预热轮数：本机 V8 对 mesher 的大函数需要多轮才能 tier-up；1 轮预热时
 * 8 轮测量常在 28ms/块（冷 JIT）与 9ms/块（热 JIT）之间跳变。8 轮预热后
 * 稳定落在稳态，测到的是生产连续网格化的成本，而不是冷启动噪声。
 */
const WARMUP_ROUNDS = 8;
const record = process.argv.includes('--record');

console.log('生产路径输出护栏（seed 2026 · 24 区块 · greedy 默认配置）');

const set = makeMeshSet();
assert.strictEqual(set.length, 24, `fixture 应含 24 个区块，实得 ${set.length}`);
console.log(`  ✓ fixture 24 区块（cx 0..5 × cz 0..3）`);

const sources = set.map(({ config, snapshot }) => new SnapshotMeshSource(config, snapshot));

/** 集合哈希：按 fixture 顺序串联 24 个单块 meshHash 的 hex 后再 sha256 */
function setHash() {
  const h = createHash('sha256');
  for (const src of sources) {
    const one = meshHash(meshChunk(src));
    assert.match(one, /^[0-9a-f]{64}$/, '单块 hash 必须是 64 位 sha256 hex');
    h.update(one);
  }
  return h.digest('hex');
}

/** 8 轮计时：先跑 8 轮预热让 JIT 进入稳态；返回每块平均 ms */
function measureMsPerChunk() {
  for (let r = 0; r < WARMUP_ROUNDS; r++) for (const src of sources) meshChunk(src);
  let total = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (const src of sources) meshChunk(src);
    total += performance.now() - t0;
  }
  return total / (ROUNDS * sources.length);
}

// 先计时再算 hash：serializeMesh 每次会分配大 Buffer，若在计时前跑会触发 GC
// 把某一轮的耗时拉高几倍，让「8 轮平均」变成噪声而不是 mesher 的真实成本。
const msPerChunk = measureMsPerChunk();
const hash = setHash();
console.log(`  集合 hash : ${hash}`);
console.log(`  8 轮平均  : ${msPerChunk.toFixed(3)} ms/区块（${set.length} 块 × ${ROUNDS} 轮）`);

if (record) {
  const baseline = {
    seed: 2026,
    chunks: set.length,
    rounds: ROUNDS,
    warmupRounds: WARMUP_ROUNDS,
    greedy: true,
    mergeEmissive: true,
    hash,
    msPerChunk,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`  已写入基线 ${path.relative(process.cwd(), BASELINE_PATH)}`);
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.strictEqual(hash, baseline.hash,
    `输出 hash 漂移：期望 ${baseline.hash}，实得 ${hash}（quad 顺序或顶点属性被改动）`);
  console.log(`  ✓ 输出 hash 与基线一致`);
}

console.log('\nPASS');
