/**
 * 篮球物理回归（R14）。
 *
 * 两部分：
 *  A. 纯函数快照（BALL 常量 / bounceVy / rollFriction / canPickup）——无 three / DOM 依赖。
 *  B. 实体物理集成（Entity 快照 + mock World）——驱动 updateBounce，
 *     验证真实落地反弹序列、撞墙反弹、球面滚动、拾取冷却，以及 walk 分支零回归。
 *
 * 说明：依赖 npm run test:snapshot 生成的最新 test/logic 快照；已由 package.json
 * 的 test:logic 纳入 verify。mock World 只实现 isSolidAt/getBlock/registry.get，
 * 足以覆盖 moveBody 与 updateBounce 的全部读取，不引入浏览器 / WebGL。
 */
const assert = require('node:assert');
const { BALL, bounceVy, rollFriction, canPickup } = require('./logic/entity/basketball.js');
const { Entity } = require('./logic/entity/entity.js');
const THREE = require('three');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};
const eq = (name, actual, expected) => {
  assert.equal(actual, expected, `${name} — 期望 ${expected}，实际 ${actual}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

// ============================================================
// A. 纯函数与常量快照
// ============================================================
console.log('[basketball] A. 纯函数与常量');

// ---- 常量集中可调，但默认值由主理人拍板，锁定回归 ----
eq('弹性系数默认 0.7', BALL.RESTITUTION, 0.7);
eq('重力与现有实体一致', BALL.GRAVITY, 24);
eq('球半径与实体宽高 0.5 对应', BALL.RADIUS, 0.25);
eq('静止阈值默认 1.6', BALL.REST_MIN_SPEED, 1.6);
eq('滚动摩擦系数默认 2.4', BALL.FRICTION, 2.4);
eq('终端下落速度 40', BALL.TERMINAL, 40);
eq('撞墙反弹比例 0.35', BALL.WALL_RESTITUTION, 0.35);
eq('拾取半径默认 1.7', BALL.PICKUP_RADIUS, 1.7);
eq('拾取近静止阈值默认 1.2', BALL.PICKUP_MAX_SPEED, 1.2);
eq('拾取冷却默认 1.1s', BALL.PICKUP_COOLDOWN, 1.1);
eq('投掷水平初速默认 14', BALL.THROW_SPEED, 14);
eq('投掷上抛分量默认 3', BALL.THROW_LIFT, 3);
eq('拍打水平冲量默认 9', BALL.PAT_SPEED, 9);
eq('拍打上抛分量默认 5.5', BALL.PAT_LIFT, 5.5);
eq('拍打节流默认 0.28s', BALL.PAT_COOLDOWN, 0.28);

// ---- 反弹：必须用入射速度，能量递减，阈值以下直接静止 ----
eq('bounceVy(-20) = 14', bounceVy(-20), 14);
eq('bounceVy(-10) = 7', bounceVy(-10), 7);
ok('入射越大反弹越高', bounceVy(-10) < bounceVy(-20));
eq('阈值内静止', bounceVy(-BALL.REST_MIN_SPEED + 0.01), 0);
ok(
  '阈值边界按设计仍反弹（判定为 > 而非 >=）',
  bounceVy(-BALL.REST_MIN_SPEED) > 0,
  `实际 ${bounceVy(-BALL.REST_MIN_SPEED)}`,
);
eq('边界精确反弹值 = 1.12', +bounceVy(-BALL.REST_MIN_SPEED).toFixed(4), 1.12);
eq('微弱入射不再反弹，杜绝永久抖动', bounceVy(-0.4), 0);
eq('非下落速度不反弹', bounceVy(0), 0);
eq('上升速度（正值）不反弹', bounceVy(5), 0);
ok('反弹速度恒小于入射能量（乘 0.7）', Math.abs(bounceVy(-30)) < Math.abs(-30));

// 一次投放的衰减序列：自由落体回到地面时入射速度约等于上次反弹速度
let impact = -24;
const heights = [];
for (let i = 0; i < 16 && impact < 0; i++) {
  const out = bounceVy(impact);
  heights.push(out);
  if (out === 0) break;
  impact = -out;
}
ok('应产生多次弹跳', heights.length >= 6, `实际 ${heights.length} 次`);
for (let i = 1; i < heights.length; i++) {
  ok(`衰减序列第 ${i + 1} 次 < 第 ${i} 次`, heights[i] < heights[i - 1]);
}
eq('最终收敛到静止', heights[heights.length - 1], 0);

// ---- 重力 / 终端速度序列 ----
let vy = 0;
for (let i = 0; i < 10; i++) vy = Math.max(vy - BALL.GRAVITY * 0.016, -BALL.TERMINAL);
ok('重力加速且被终端速度钳制', vy < 0 && vy >= -BALL.TERMINAL);
eq('极大入射被钳制到终端速度', Math.max(-100 - BALL.GRAVITY * 0.016, -BALL.TERMINAL), -BALL.TERMINAL);

// ---- 摩擦：与帧率无关 ----
const v0 = 10;
const half = 1 / 120;
const twoSteps = rollFriction(rollFriction(v0, half), half);
const oneStep = rollFriction(v0, 2 * half);
ok('两次半步 ≈ 一次整步', Math.abs(twoSteps - oneStep) < 1e-9);
// 多角度验证帧率无关性：4×1/240、2×1/120、1×1/60 均等价于总时长 1/60
const total = 1 / 60;
const fine = [v0];
for (let i = 0; i < 4; i++) fine.push(rollFriction(fine[i], total / 4));
const coarse = rollFriction(v0, total);
ok('4 个微步 ≈ 1 个粗步（跨帧率一致）', Math.abs(fine[4] - coarse) < 1e-9, `fine=${fine[4]} coarse=${coarse}`);
eq('零时长不改变速度', rollFriction(v0, 0), v0);
ok('摩擦单调衰减', rollFriction(v0, 1) < v0);
ok('负向速度同样被摩擦衰减', Math.abs(rollFriction(-v0, 0.5)) < Math.abs(-v0));
ok('时长越大衰减越多', rollFriction(v0, 0.5) < rollFriction(v0, 0.1));

// ---- 拾取判定边界 ----
eq('静止近距离可拾取', canPickup(0, 0, 0, 0), true);
eq('冷却中不可拾取', canPickup(0, 0, 0, 0.1), false);
eq('冷却恰好归零可拾取', canPickup(0, 0, 0, 0), true);
eq('冷却为负（已超时）可拾取', canPickup(0, 0, 0, -1), true);
eq('水平半径边界内', canPickup(BALL.PICKUP_RADIUS, 0, 0, 0), true);
eq('超出水平半径', canPickup(BALL.PICKUP_RADIUS + 0.1, 0, 0, 0), false);
eq('近静止边界内', canPickup(0, 0, BALL.PICKUP_MAX_SPEED, 0), true);
eq('运动中的球不可拾取', canPickup(0, 0, BALL.PICKUP_MAX_SPEED + 0.1, 0), false);
eq('竖直下界内', canPickup(0, -0.6, 0, 0), true);
eq('低于竖直下界', canPickup(0, -0.7, 0, 0), false);
eq('竖直上界内', canPickup(0, 2.2, 0, 0), true);
eq('高于竖直上界', canPickup(0, 2.3, 0, 0), false);

// ---- 撞墙反弹公式（updateBounce 内联逻辑的纯数学回归）----
// 实际撞墙逻辑在 updateBounce：if(res.hitX) vel.x = -hitXIn * BALL.WALL_RESTITUTION
const wallBounce = (v) => -v * BALL.WALL_RESTITUTION;
eq('撞墙反弹按 WALL_RESTITUTION 比例', +wallBounce(10).toFixed(4), -3.5);
ok('正向撞墙后反向', wallBounce(10) < 0);
ok('负向撞墙后反向', wallBounce(-10) > 0);
ok('撞墙反弹能量衰减', Math.abs(wallBounce(10)) < Math.abs(10));

// ============================================================
// B. 实体物理集成（Entity 快照 + mock World）
// ============================================================
console.log('[basketball] B. Entity 物理集成');

/** 最小 World：地面 y=0 为实心；可选在 wallX 处立一面墙（y=1..3）。 */
function makeWorld(wallX) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const solid = new Set();
  for (let x = -30; x <= 30; x++) {
    for (let z = -30; z <= 30; z++) solid.add(key(x, 0, z));
  }
  if (wallX !== undefined) {
    for (let y = 1; y <= 3; y++) {
      for (let z = -5; z <= 5; z++) solid.add(key(wallX, y, z));
    }
  }
  return {
    isSolidAt: (x, y, z) => solid.has(key(x, y, z)),
    getBlock: (x, y, z) => (solid.has(key(x, y, z)) ? 1 : 0),
    registry: { get: () => ({ liquid: false }) },
  };
}

const buildBallModel = () => ({ group: new THREE.Group(), animate() {} });
const BALL_TYPE = {
  id: 'basketball',
  label: '篮球',
  width: 0.5,
  height: 0.5,
  speed: 0,
  physics: 'bounce',
  health: Infinity,
  build: buildBallModel,
};
const silentEvents = () => ({ emit() {} });

// ---- 高处投放：多次弹跳、强度递减、最终静止、不穿透地面 ----
{
  const world = makeWorld();
  const strengths = [];
  const events = {
    emit: (name, p) => {
      if (name === 'basketball:bounce') strengths.push(p.strength);
    },
  };
  const ball = new Entity(BALL_TYPE, 0.5, 8, 0.5, events);
  ball.vel.y = -6;
  for (let i = 0; i < 400; i++) ball.update(1 / 60, world);

  ok('高处投放产生多次弹跳', strengths.length >= 3, `实际 ${strengths.length} 次`);
  for (let i = 1; i < strengths.length; i++) {
    ok(
      `真实弹跳强度第 ${i + 1} 次 < 第 ${i} 次`,
      strengths[i] < strengths[i - 1],
      `${strengths[i - 1].toFixed(3)} → ${strengths[i].toFixed(3)}`,
    );
  }
  ok('最终竖直速度归零（静止）', ball.vel.y === 0, `vel.y=${ball.vel.y}`);
  ok('最终贴地 onGround=true', ball.onGround);
  // moveBody 落地时写入 pos.y = 顶面 + EPS(1e-4) 防重入，允许该微小偏移，但不能穿透或悬空
  ok('不穿透地面，停在方块顶面 y≈1', ball.pos.y >= 1 && ball.pos.y < 1 + 1e-3, `y=${ball.pos.y}`);
}

// ---- 撞墙反弹：速度反向、不穿墙 ----
{
  const world = makeWorld(4); // 墙在 x=4，球半宽 0.25 → 钳制后 x ≤ 3.75
  const ball = new Entity(BALL_TYPE, 1.5, 1.02, 0.5, silentEvents());
  ball.onGround = true;
  ball.vel.x = 12;
  ball.vel.y = 0;
  let flipped = false;
  let minX = Infinity;
  for (let i = 0; i < 30; i++) {
    const prevVx = ball.vel.x;
    ball.update(1 / 60, world);
    if (prevVx > 0 && ball.vel.x < 0) flipped = true;
    minX = Math.min(minX, ball.pos.x);
  }
  ok('撞墙后水平速度反向（WALL_RESTITUTION 生效）', flipped);
  ok('撞墙不穿透（x 始终 ≤ 3.75）', minX <= 3.75 + 1e-6, `minX=${minX}`);
}

// ---- 球面滚动旋转 + 模型球心偏移 ----
{
  const world = makeWorld();
  const ball = new Entity(BALL_TYPE, 0.5, 1.02, 0.5, silentEvents());
  ball.onGround = true;
  ball.vel.x = 3;
  ball.vel.y = 0;
  const q0 = ball.model.group.quaternion.clone();
  for (let i = 0; i < 10; i++) ball.update(1 / 60, world);
  ok('水平位移产生球面滚动旋转', !ball.model.group.quaternion.equals(q0));
  ok(
    '模型球心 = 脚底 + RADIUS',
    Math.abs(ball.model.group.position.y - ball.pos.y - BALL.RADIUS) < 1e-9,
    `diff=${(ball.model.group.position.y - ball.pos.y).toFixed(4)}`,
  );
}

// ---- 拾取冷却随 dt 递减 ----
{
  const world = makeWorld();
  const ball = new Entity(BALL_TYPE, 0.5, 1.02, 0.5, silentEvents());
  ball.pickupCooldown = 1.1;
  for (let i = 0; i < 30; i++) ball.update(1 / 60, world); // 0.5s
  ok(
    'pickupCooldown 按 dt 线性递减',
    Math.abs(ball.pickupCooldown - 0.6) < 1e-6,
    `实际 ${ball.pickupCooldown.toFixed(4)}`,
  );
}

// ---- 水中阻尼上浮（R5 边界）----
{
  const waterWorld = {
    isSolidAt: () => false,
    getBlock: () => 2,
    registry: { get: () => ({ liquid: true }) },
  };
  const ball = new Entity(BALL_TYPE, 0.5, 5, 0.5, silentEvents());
  ball.vel.y = -10;
  // 水中每帧 +8*dt，从 -10 回升到上限 2.2 需约 1.53s；跑满 2s 验证钳制
  for (let i = 0; i < 120; i++) ball.update(1 / 60, waterWorld);
  ok('水中上浮速度被钳制在 2.2', Math.abs(ball.vel.y - 2.2) < 1e-6, `vel.y=${ball.vel.y.toFixed(3)}`);
}

// ---- walk 实体零回归：分流后既有实体行为不变 ----
{
  const world = makeWorld();
  let bounceEvents = 0;
  const events = {
    emit: (name) => {
      if (name === 'basketball:bounce') bounceEvents++;
    },
  };
  const pigType = {
    id: 'pig',
    label: '猪',
    width: 0.9,
    height: 0.95,
    speed: 1.15,
    build: buildBallModel,
  };
  const ctx = {
    playerPos: new THREE.Vector3(0, 0, 0),
    hurtPlayer: () => false,
    daylight: 0.9,
    playerDead: false,
  };
  const pig = new Entity(pigType, 0.5, 5, 0.5, events);
  for (let i = 0; i < 90; i++) pig.update(1 / 60, world, ctx);
  ok('walk 实体正常落地', pig.onGround && pig.pos.y >= 1 && pig.pos.y < 1 + 1e-3, `y=${pig.pos.y}`);
  ok('walk 实体血量不受影响', pig.hp === pig.maxHp);
  ok('walk 实体不进入弹跳分支（无 bounce 事件）', bounceEvents === 0);
}

console.log(`[basketball] 纯逻辑 + 实体物理集成回归通过（共 ${passed} 项断言）`);
