/**
 * 火焰系统帧率基准（纯 Node，不依赖浏览器 / three.js）。
 * 运行：npm run test:perf（需先 npm run test:snapshot 生成 test/logic 快照）
 *
 * 目的：给 FireSystem 的每拍（scanTick=0.25s）耗时一个宽松上限，防止火焰蔓延
 * 在火势变大时悄悄劣化。用 fake world / registry / particles / events 构造一批
 * 永久热源（营火，不会燃尽），分别测量设置项 fireSpread 开 / 关时的每拍平均耗时。
 *
 * 为什么用营火而不是火焰：火焰寿命约 18s，200 拍（50s）内会陆续熄灭，
 * 被测集合随时间缩小，两组对比不稳定；营火是 isHeatBlock 的一员且永久不熄，
 * 能稳定维持 64 个热源。蔓延成本来自「每个热源 × 6 邻」的判定，与热源种类无关。
 *
 * 断言只设宽松上限（默认 5ms/拍，约为实测值的数十倍），避免 CI 机器抖动造成 flaky。
 * 本脚本已纳入 npm run verify（test:perf），位置在 test:snapshot 之后。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let FireSystem;
let FIRE;
try {
  ({ FireSystem } = require('./logic/world/fire.js'));
  ({ FIRE } = require('./logic/core/tuning.js'));
} catch (e) {
  console.error('[perf] 无法加载测试快照：请先运行 npm run test:snapshot');
  console.error(`[perf] ${e.message}`);
  process.exit(2);
}

const AIR = 0;
const STONE = 1;
const GRASS = 2;
const OAK_LOG = 3;
const CAMPFIRE = 165;
const FIRE_ID = 168;

const NAMES = {
  [AIR]: 'air',
  [STONE]: 'stone',
  [GRASS]: 'grass',
  [OAK_LOG]: 'oak_log',
  [CAMPFIRE]: 'campfire',
  [FIRE_ID]: 'fire',
};
const IDS = Object.fromEntries(Object.entries(NAMES).map(([id, name]) => [name, Number(id)]));
const SOLID = { [STONE]: true, [GRASS]: true, [OAK_LOG]: true };

class FakeWorld {
  constructor() {
    this.data = new Map();
  }

  getBlock(x, y, z) {
    return this.data.get(`${x},${y},${z}`) ?? AIR;
  }

  setBlock(x, y, z, id) {
    this.data.set(`${x},${y},${z}`, id);
    return true;
  }
}

const registry = {
  get: (id) => ({ id, name: NAMES[id] ?? 'air', solid: SOLID[id] ?? false, liquid: false }),
  byNameGet: (name) => (name in IDS ? { id: IDS[name] } : undefined),
  isSolid: (id) => SOLID[id] ?? false,
};

const events = { emit: () => {} };
const particles = { enabled: true, burst: () => {} };

/** 确定性 rng（mulberry32），两组用同一种子，保证蔓延判定序列一致 */
function makeRng(seed = 20261115) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在玩家周围摆 sources 个营火（8×8 网格，全部落在 scanRadius=12 内） */
function buildWorld(sources) {
  const world = new FakeWorld();
  const side = Math.ceil(Math.sqrt(sources));
  const half = Math.floor(side / 2);
  let placed = 0;
  for (let dx = -half; dx < -half + side && placed < sources; dx++) {
    for (let dz = -half; dz < -half + side && placed < sources; dz++) {
      world.setBlock(dx, 0, dz, STONE);
      world.setBlock(dx, 1, dz, CAMPFIRE);
      placed++;
    }
  }
  return { world, placed };
}

/**
 * 跑 ticks 拍（每拍 scanTick 秒），返回平均每拍耗时（ms）。
 * 先跑 warmup 拍丢弃，避免首拍扫描 / JIT 预热进入测量。
 */
function measure({ sources, ticks, warmup, enabled, limitMs }) {
  const { world, placed } = buildWorld(sources);
  const sys = new FireSystem({
    world,
    registry,
    events,
    particles,
    hurtPlayer: () => true,
    rng: makeRng(),
    getEntities: () => [],
    isPlayerBusy: () => false,
  });
  sys.enabled = enabled;
  // 玩家悬在营火列上方一格，脚下方块不是热源，避免伤害节拍干扰测量
  const pos = { x: 0.5, y: 2, z: 0.5 };

  for (let i = 0; i < warmup; i++) sys.update(FIRE.scanTick, pos);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) sys.update(FIRE.scanTick, pos);
  const t1 = performance.now();

  const avgMs = (t1 - t0) / ticks;
  return { placed, ticks, warmup, enabled, avgMs, totalMs: t1 - t0, limitMs };
}

const SOURCES = Number(process.env.MC_PERF_SOURCES ?? 64);
const TICKS = Number(process.env.MC_PERF_TICKS ?? 200);
const WARMUP = Number(process.env.MC_PERF_WARMUP ?? 20);
const LIMIT_MS = Number(process.env.MC_PERF_LIMIT_MS ?? 5);

const on = measure({ sources: SOURCES, ticks: TICKS, warmup: WARMUP, enabled: true, limitMs: LIMIT_MS });
const off = measure({ sources: SOURCES, ticks: TICKS, warmup: WARMUP, enabled: false, limitMs: LIMIT_MS });

const ratio = off.avgMs > 0 ? on.avgMs / off.avgMs : Infinity;
const pass = on.avgMs < LIMIT_MS;

console.log('[perf] 火焰系统每拍耗时（FireSystem.update(scanTick)）');
console.log(`[perf] 火源 ${on.placed} 个营火，每拍 ${FIRE.scanTick}s，实测 ${TICKS} 拍（预热 ${WARMUP} 拍）`);
console.log(
  `[perf] 蔓延开（fireSpread=true ）: 平均 ${on.avgMs.toFixed(4)} ms/拍（${on.totalMs.toFixed(1)} ms / ${TICKS} 拍）`,
);
console.log(
  `[perf] 蔓延关（fireSpread=false）: 平均 ${off.avgMs.toFixed(4)} ms/拍（${off.totalMs.toFixed(1)} ms / ${TICKS} 拍）`,
);
console.log(`[perf] 开启 / 关闭 ≈ ${ratio.toFixed(2)}×`);
console.log(`[perf] 上限 ${LIMIT_MS} ms/拍：${pass ? 'PASS' : 'FAIL'}`);
console.log(JSON.stringify({ on, off, ratio, limitMs: LIMIT_MS, pass }));

if (!pass) {
  console.error(`[perf] 每拍平均耗时 ${on.avgMs.toFixed(4)}ms 超过上限 ${LIMIT_MS}ms`);
  process.exit(1);
}
