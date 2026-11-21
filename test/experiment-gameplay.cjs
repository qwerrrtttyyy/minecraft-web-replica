/**
 * 玩法/生存机制实验（node 实景）——受控测量，不是回归门禁。
 *
 * E9  生存状态机：饥饿消耗率（walk/sprint/mining）、饱食回血、饥饿掉血、伤害免疫
 * E10 生态随机刻节奏：Botany.setTickSpeed(0/1/2/3) 的 randomAttempt 频率
 * E11 实体攻击：hurt 语义 + 敌对攻击节奏 + 弹道射线命中
 * E12 确定性掉落判定：rollDrops 率 / 可复现性 / nightOnly / biome / min~max
 * E13 脱困解算成本：resolvePenetration 在嵌入中的迭代与位移
 *
 * 运行：npm run test:experiment-gameplay
 */
const assert = require('node:assert');

const log = (...a) => console.log(...a);
let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const { EventBus } = require('./logic/core/events.js');
const { SurvivalState } = require('./logic/player/survival.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const { World } = require('./logic/world/world.js');
const { Botany } = require('./logic/world/botany.js');
const { EntityManager } = require('./logic/entity/entity.js');
const { resolvePenetration } = require('./logic/player/unstuck.js');
const { rollDrops } = require('./logic/world/drops.js');
const { CHUNK_SIZE: CS } = require('./logic/core/types.js');

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const id = (n) => reg.byNameGet(n).id;

/** 空世界：generateChunk 不写数据，全部为空气 */
const makeEmptyWorld = () => new World(reg, { generateChunk() {}, surfaceHeight() { return 32; } }, new EventBus());

/** 扁平世界：地面 y=20（botany-check 的 makeWorld 模式） */
function makeFlatWorld(seed = 20261115) {
  const generator = {
    seed,
    surfaceHeight: () => 20,
    biomeAt: () => 'plains',
    generateChunk(_cx, _cz, data) {
      const idx = (x, y, z) => (y * CS + z) * CS + x;
      for (let z = 0; z < CS; z++) {
        for (let x = 0; x < CS; x++) {
          data[idx(x, 0, z)] = id('bedrock');
          for (let y = 1; y <= 18; y++) data[idx(x, y, z)] = id('stone');
          data[idx(x, 19, z)] = id('dirt');
          data[idx(x, 20, z)] = id('grass');
        }
      }
    },
  };
  const world = new World(reg, generator, new EventBus());
  world.ensureChunk(0, 0);
  return world;
}

// ---------- E9：生存状态机 ----------
log('E9 生存状态机：饥饿消耗率 / 饱食回血 / 饥饿掉血 / 伤害免疫');
{
  const mkSurv = () => new SurvivalState(new EventBus(), reg);
  const idleCtx = { moving: false, sprinting: false, mining: false, underwater: false };

  const drainRate = (moving, sprinting, mining, T = 200) => {
    const s = mkSurv();
    const ctx = { moving, sprinting, mining, underwater: false };
    for (let i = 0; i < T * 10; i++) s.tick(0.1, ctx);
    return { points: 20 - s.hunger, rate: (20 - s.hunger) / T, healthLost: 20 - s.health };
  };
  const walk = drainRate(true, false, false);
  ok('运动消耗：walk ≈ 0.06/s（200s）',
    walk.rate >= 0.008 && walk.rate <= 0.03, `rate=${walk.rate.toFixed(4)}/s`);
  const sprint = drainRate(true, true, false);
  ok('运动消耗：sprint ≈ 0.20/s（200s）',
    sprint.rate >= 0.028 && sprint.rate <= 0.072, `rate=${sprint.rate.toFixed(4)}/s`);
  const mining = drainRate(false, false, true);
  ok('运动消耗：mining ≈ 0.09/s（200s）',
    mining.rate >= 0.012 && mining.rate <= 0.033, `rate=${mining.rate.toFixed(4)}/s`);
  ok('运动消耗：无死亡/饥饿副作用（health 不减）',
    walk.healthLost === 0 && sprint.healthLost === 0 && mining.healthLost === 0,
    `${walk.healthLost}/${sprint.healthLost}/${mining.healthLost}`);

  {
    const s = mkSurv();
    s.health = 10; s.hunger = 19;
    const heals = [];
    const origHeal = s.heal.bind(s);
    s.heal = (a) => { heals.push(a); origHeal(a); };
    for (let i = 0; i < 400; i++) s.tick(0.1, idleCtx);
    ok('饱食回血：触发（heals ≥ 1）', heals.length >= 1, `heals=${heals.length}`);
    ok('饱食回血：health ∈ [10,16]，hunger ∈ [12,20]',
      s.health >= 10 && s.health <= 16 && s.hunger >= 12 && s.hunger <= 20,
      `health=${s.health} hunger=${s.hunger}`);
  }
  {
    const s = mkSurv();
    s.health = 5; s.hunger = 0;
    const damages = [];
    const origDamage = s.damage.bind(s);
    s.damage = (a, c, u) => { damages.push(c); return origDamage(a, c, u); };
    for (let i = 0; i < 400; i++) s.tick(0.1, idleCtx);
    const n = damages.filter((c) => c === '饥饿').length;
    ok('饥饿掉血：每 4s 一次 -1，死亡（T=40s）',
      n >= 4 && n <= 7 && s.dead === true && s.health === 0,
      `damages=${n} health=${s.health} dead=${s.dead}`);
  }
  {
    const s = mkSurv();
    const d1 = s.damage(10, 'test');
    const d2 = s.damage(1, 'test');
    s.tick(0.3, idleCtx);
    const d3 = s.damage(1, 'test');
    s.tick(0.3, idleCtx);
    const d4 = s.damage(1, 'test');
    ok('伤害免疫：免疫 0.32s 内生效（d1=true, d2=false, d3=false, d4=true, health=9）',
      d1 === true && d2 === false && d3 === false && d4 === true && s.health === 9,
      `health=${s.health}`);
  }
}

// ---------- E10：生态随机刻节奏 ----------
log('E10 生态随机刻节奏：Botany.setTickSpeed(0/1/2/3) 的 randomAttempt 频率');
{
  const tierCalls = (tier) => {
    const world = makeFlatWorld();
    const botany = new Botany(world, world.registry, 20261115, new EventBus(), {});
    botany.setTickSpeed(tier);
    for (const [x, z] of [[5, 5], [9, 9], [13, 13], [17, 17]]) world.setBlock(x, 21, z, id('wheat_seedling'));
    let calls = 0;
    const origGet = world.getBlock.bind(world);
    world.getBlock = (x, y, z) => { calls++; return origGet(x, y, z); };
    for (let i = 0; i < 300; i++) botany.update(0.1, 5, 5, 1);
    return calls;
  };
  const c0 = tierCalls(0);
  const c1 = tierCalls(1);
  const c2 = tierCalls(2);
  const c3 = tierCalls(3);
  ok('随机刻节奏：tier 0 → 0 次 randomAttempt（暂停档）', c0 === 0, `calls=${c0}`);
  ok('随机刻节奏：tier 3 / tier 2 比例 ≈ scale 2.2（在 [1.85, 2.75]）',
    c3 / c2 >= 1.85 && c3 / c2 <= 2.75, `ratio=${(c3 / c2).toFixed(2)} (${c3}/${c2})`);
  ok('随机刻节奏：tier 2 > tier 1（标准 56 > 慢档 ~20）', c2 > c1, `${c2} > ${c1}`);
}

// ---------- E11：实体攻击与射线 ----------
log('E11 实体攻击：hurt 语义 + 敌对攻击节奏 + 弹道射线命中');
{
  const world = makeFlatWorld();
  const mgr = new EntityManager(world, { add() {}, remove() {} }, new EventBus(), 123);
  const z = mgr.spawn('zombie', 10, 10, 10);
  ok('实体：新建僵尸 hp=14', z.hp === 14 && !z.dead, `hp=${z.hp}`);
  z.hurt(3, 20, 10);
  ok('实体：hurt 扣血', z.hp === 11, `hp=${z.hp}`);
  z.hurt(3);
  ok('实体：hurt 累计扣血', z.hp === 8, `hp=${z.hp}`);
  z.hurt(100);
  ok('实体：hurt 到 0 → dead', z.hp === 0 && z.dead, `hp=${z.hp} dead=${z.dead}`);
  z.hurt(1);
  ok('实体：死亡后 hurt 无效', z.hp === 0, `hp=${z.hp}`);
  const z2 = mgr.spawn('zombie', 20, 10, 20);
  z2.hurt(3);
  ok('实体：hurt 设置 hurtCooldown=0.35', z2.hurtCooldown === 0.35, `cooldown=${z2.hurtCooldown}`);
}
{
  const world = makeFlatWorld();
  const mgr = new EntityManager(world, { add() {}, remove() {} }, new EventBus(), 123);
  const z = mgr.spawn('zombie', 10, 10, 10);
  const hits = [];
  for (let i = 0; i < 100; i++) {
    // daylight=0：夜间，否则僵尸的 burnInDay 白天灼烧会给 zombie 扣血（见 Entity.update）
    mgr.update(0.1, {
      playerPos: z.pos,
      hurtPlayer: (amount, cause) => { hits.push({ amount, cause }); return true; },
      daylight: 0, playerDead: false,
    });
  }
  ok('实体：敌对攻击节奏 ≈ 1/1.05s（10s，攻击次数在 [8, 13]）',
    hits.length >= 8 && hits.length <= 13, `hits=${hits.length}`);
  ok('实体：攻击伤害 = 僵尸 damage=3',
    hits.length > 0 && hits.every((h) => h.amount === 3), `first=${hits[0]?.amount}`);
}
{
  const world = makeEmptyWorld();
  const stone = id('stone');
  for (let y = 5; y <= 12; y++) for (let z = 10; z <= 13; z++) world.setBlock(8, y, z, stone);
  const origin = { x: 4, y: 10, z: 12 };
  const dir = { x: 1, y: 0, z: 0 };
  const hit = world.raycast(origin, dir, 6);
  ok('实体射线：穿过石墙命中（hit.x=8）',
    hit && hit.block === stone && Math.abs(hit.x - 8) < 1e-6,
    `hit=${hit ? `x=${hit.x} dist=${hit.dist}` : 'null'}`);
  const N = 1000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) world.raycast(origin, dir, 6);
  const ms = (performance.now() - t0) / N;
  ok('实体射线：REACH=6 弹道均值 < 1ms', ms < 1, `${ms.toFixed(4)} ms/call`);
}

// ---------- E13：脱困解算 ----------
log('E13 脱困解算：resolvePenetration 在嵌入中的迭代与位移');
{
  const world = makeEmptyWorld();
  const stone = id('stone');
  // pos(10.5, 10.5, 10.5) 落在 x=10 的石柱内（y ∈ [10,12]）
  for (let y = 10; y <= 12; y++) world.setBlock(10, y, 10, stone);
  const isSolid = (x, y, z) => world.registry.isSolid(world.getBlock(x, y, z));
  const pos = { x: 10.5, y: 10.5, z: 10.5 };
  const r = resolvePenetration(pos, 0.6, 1.9, isSolid);
  const displacement = Math.abs(r.dx) + Math.abs(r.dy) + Math.abs(r.dz);
  ok('脱困：resolved=true, moved=true', r.resolved === true && r.moved === true, JSON.stringify(r));
  ok('脱困：迭代 ≤ 上限(10)，位移有界(0, 4]',
    r.iterations <= 10 && displacement > 0 && displacement <= 4,
    `iterations=${r.iterations} displacement=${displacement.toFixed(3)}`);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) resolvePenetration(pos, 0.6, 1.9, isSolid);
  const ms = (performance.now() - t0) / 200;
  ok('脱困：解算均值 < 1ms', ms < 1, `${ms.toFixed(4)} ms/call`);
}

// ---------- E12：确定性掉落 ----------
log('E12 确定性掉落：rollDrops 率 / 可复现性 / 过滤');
{
  const spec = [
    { name: 'item:apple', chance: 0.35 },
    { name: 'item:iron_ingot', chance: 0.15 },
    { name: 'item:iron_sword', chance: 0.04 },
  ];
  const N = 20000;
  const counts = { 'item:apple': 0, 'item:iron_ingot': 0, 'item:iron_sword': 0 };
  for (let i = 0; i < N; i++) {
    for (const d of rollDrops(spec, { seed: 7, source: `e:1:${i}`, daylight: 1 })) {
      if (d.name in counts) counts[d.name] += d.count;
    }
  }
  const rate = (n) => counts[n] / N;
  const expectRate = (name, p) => {
    const sigma = Math.sqrt(p * (1 - p) * N);
    const tol = (5 * sigma) / N;
    const r = rate(name);
    ok(`掉落率 ${name} ≈ ${p}（|Δ| ≤ 5σ，σ=${sigma.toFixed(0)}）`,
      Math.abs(r - p) <= tol, `measured=${r.toFixed(4)} expected=${p}`);
  };
  expectRate('item:apple', 0.35);
  expectRate('item:iron_ingot', 0.15);
  expectRate('item:iron_sword', 0.04);

  const a = rollDrops(spec, { seed: 7, source: 'e:1:5', daylight: 1 });
  const b = rollDrops(spec, { seed: 7, source: 'e:1:5', daylight: 1 });
  ok('掉落判定可复现：同参数两次相同', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
  let varied = false;
  for (const s of ['e:1:0', 'e:1:1', 'e:1:2', 'e:1:3', 'e:1:4', 'e:1:6', 'e:1:7', 'e:1:8', 'e:1:9']) {
    if (JSON.stringify(rollDrops(spec, { seed: 7, source: s })) !== JSON.stringify(a)) { varied = true; break; }
  }
  ok('掉落判定按来源稳定分布（有源变化）', varied);

  const ghostSpec = [{ name: 'ghost', chance: 1, nightOnly: true }];
  const ghost = (daylight) => {
    let n = 0;
    for (let i = 0; i < 100; i++) if (rollDrops(ghostSpec, { seed: 7, source: `n:${i}`, daylight }).length) n++;
    return n;
  };
  ok('nightOnly：daylight=0.1 → 100 掉落', ghost(0.1) === 100, `n=${ghost(0.1)}`);
  ok('nightOnly：daylight=0.5 → 0 掉落', ghost(0.5) === 0, `n=${ghost(0.5)}`);

  const flowerSpec = [{ name: 'desert_flower', chance: 1, biome: 'desert' }];
  const flower = (biome) => {
    let n = 0;
    for (let i = 0; i < 50; i++) if (rollDrops(flowerSpec, { seed: 7, source: `b:${i}`, biome }).length) n++;
    return n;
  };
  ok('biome 过滤：biome=desert → 50 掉落', flower('desert') === 50, `n=${flower('desert')}`);
  ok('biome 过滤：biome=plains → 0 掉落', flower('plains') === 0, `n=${flower('plains')}`);

  const rangeSpec = [{ name: 'multi', chance: 1, min: 2, max: 5 }];
  const rangeCounts = [];
  for (let i = 0; i < 200; i++) {
    const drops = rollDrops(rangeSpec, { seed: 7, source: `r:${i}` });
    rangeCounts.push(drops.length ? drops[0].count : 0);
  }
  ok('min~max：count ∈ [2,5] 且不全相同',
    rangeCounts.every((c) => c >= 2 && c <= 5) && new Set(rangeCounts).size > 1,
    rangeCounts.slice(0, 6).join(','));
}

log(`\nPASS 玩法/生存机制实验：${passed} 组断言全部通过`);
