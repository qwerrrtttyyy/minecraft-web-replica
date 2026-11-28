/**
 * 生产路径输出护栏 + 基线计时（M01）。
 *
 * 运行前置：npm run test:snapshot
 *   node test/mesher-hotspot-check.cjs            # 校验输出 hash == baseline.json
 *   node test/mesher-hotspot-check.cjs --record   # 重写 baseline.json（只在改 fixture 时用）
 *
 * 这是 characterization guard：在当前未优化代码上先跑绿并记录基线，后续 mesher 优化必须
 * 保持 hash 不变。hash 是唯一硬断言（quad 顺序 + 全部顶点属性逐字节一致）。
 *
 * 计时是 Node 代理指标：打印 8 轮平均每块 ms 与相对基线的倍数，并标出是否达到
 * `msPerChunk <= baseline/1.5` 目标；本机无浏览器，p95<33ms 只能在有浏览器环境验证，
 * 因此速度不写成失败条件（避免把机器噪声误判为回归）。
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
 * 8 轮测量常在冷 JIT 与热 JIT 之间跳变。8 轮预热后稳定落在稳态。
 */
const WARMUP_ROUNDS = 8;
const record = process.argv.includes('--record');

console.log('生产路径输出护栏（seed 2026 · 24 区块 · greedy 默认配置）');

const set = makeMeshSet();
assert.strictEqual(set.length, 24, `fixture 应含 24 个区块，实得 ${set.length}`);
console.log(`  ✓ fixture 24 区块（cx 0..5 × cz 0..3）`);

// 每段单独网格化（yBase = sy*16），串联全部 section 的输出才是整列护栏。
const sources = set.flatMap(({ config, snapshots, sectionHeight }) =>
  snapshots.map((snapshot, sy) => ({
    src: new SnapshotMeshSource(config, snapshot),
    yBase: sy * sectionHeight,
    yCount: sectionHeight,
  })),
);

/** 集合哈希：按 fixture 顺序串联 24 个单块 meshHash 的 hex 后再 sha256 */
function setHash() {
  const h = createHash('sha256');
  for (const { src, yBase, yCount } of sources) {
    const one = meshHash(meshChunk(src, yBase, yCount));
    assert.match(one, /^[0-9a-f]{64}$/, '单块 hash 必须是 64 位 sha256 hex');
    h.update(one);
  }
  return h.digest('hex');
}

/** 8 轮计时：先跑 8 轮预热让 JIT 进入稳态；返回每块平均 ms */
function measureMsPerChunk() {
  for (let r = 0; r < WARMUP_ROUNDS; r++) for (const { src, yBase, yCount } of sources) meshChunk(src, yBase, yCount);
  let total = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (const { src, yBase, yCount } of sources) meshChunk(src, yBase, yCount);
    total += performance.now() - t0;
  }
  return total / (ROUNDS * sources.length);
}

// 先计时再算 hash：serializeMesh 每次会分配大 Buffer，若在计时前跑会触发 GC
// 把某一轮的耗时拉高几倍，让「8 轮平均」变成噪声而不是 mesher 的真实成本。
const msPerChunk = measureMsPerChunk();
const hash = setHash();
console.log(`  集合 hash : ${hash}`);
console.log(`  8 轮平均  : ${msPerChunk.toFixed(3)} ms/段（${set.length} 块 × ${ROUNDS} 轮）`);

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
  assert.strictEqual(
    hash,
    baseline.hash,
    `输出 hash 漂移：期望 ${baseline.hash}，实得 ${hash}（quad 顺序或顶点属性被改动）`,
  );
  console.log(`  ✓ 输出 hash 与基线一致`);

  // 目标达成情况如实报告，不作为失败条件（机器噪声 / 无浏览器环境）。
  const baseMs = baseline.msPerChunk;
  const mult = baseMs / msPerChunk;
  const target = baseMs / 1.5;
  console.log(`  基线      : ${baseMs.toFixed(3)} ms/段；提速 ${mult.toFixed(2)}×`);
  console.log(
    `  1.5× 目标 : <= ${target.toFixed(3)} ms/段 → ${msPerChunk <= target ? '达标' : '未达标（如实记录，hash 一致优先）'}`,
  );
}

console.log('\nPASS');
