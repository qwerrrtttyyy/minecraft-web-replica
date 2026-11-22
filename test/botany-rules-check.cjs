/**
 * 生态扩展点回归（v1.4.3）。
 * 运行：node test/botany-rules-check.cjs（需先 npm run test:snapshot）
 *
 * 覆盖：
 * - 10 种扩展植物的 id 契约（159~168 末位追加、旧 id 不动、三类代谢）
 * - PlantRuleRegistry 的注册 / 动态解析 / 多规则命中 / 按 owner 注销
 * - botany:register 权限裁剪（写拦截、读保留）
 * - 8 条规则的纯函数行为（确定性 fake ctx，不依赖概率收敛）
 * - Botany 集成：插件规则确实被兜底分派，注销后立即失效
 * - 自然生成选种的确定性与群系 / 临水约束
 * - 未安装插件时内置生态路径不受影响
 */
const assert = require('node:assert');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { World } = require('./terrain-logic/world/world.js');
const { Botany } = require('./terrain-logic/world/botany.js');
const { PlantRuleRegistry } = require('./terrain-logic/world/plantRules.js');
const { EventService } = require('./terrain-logic/services/events/EventService.js');
const { scopeAPI } = require('./terrain-logic/services/plugins/PluginService.js');
const {
  EXPANSION_PLANT_COUNT,
  EXPANSION_PLUGIN_ID,
  EXPANSION_PLANTS,
  EXPANSION_RULES,
  SPAWN_ROLL_CEILING,
  expansionBlockInput,
  planSpawn,
  spawnHash,
  windDirection,
} = require('./terrain-logic/plugins/builtin/botanyContent.js');
const { CHUNK_SIZE: CS } = require('./terrain-logic/core/types.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

/** 与 botany-check.cjs 同构的平坦世界：y=20 草方块，biomeAt 可动态切换 */
function makeWorld(seed = 20261115) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const ids = {
    bedrock: reg.byNameGet('bedrock').id,
    stone: reg.byNameGet('stone').id,
    dirt: reg.byNameGet('dirt').id,
    grass: reg.byNameGet('grass').id,
  };
  const generator = {
    seed,
    surfaceHeight: () => 20,
    biomeAt: () => 'plains',
    generateChunk(_cx, _cz, data) {
      const idx = (x, y, z) => (y * CS + z) * CS + x;
      for (let z = 0; z < CS; z++) {
        for (let x = 0; x < CS; x++) {
          data[idx(x, 0, z)] = ids.bedrock;
          for (let y = 1; y <= 18; y++) data[idx(x, y, z)] = ids.stone;
          data[idx(x, 19, z)] = ids.dirt;
          data[idx(x, 20, z)] = ids.grass;
        }
      }
    },
  };
  const events = new EventService();
  const world = new World(reg, generator, events);
  world.ensureChunk(0, 0);
  const id = (n) => {
    const def = reg.byNameGet(n);
    assert.ok(def, `缺少方块 ${n}`);
    return def.id;
  };
  const botany = new Botany(world, reg, seed, events, { interval: 0.35, attempts: 1, radius: 8 });
  return { reg, events, world, botany, id, generator };
}

/** 模拟插件装配：注册方块 → 注册特性 → 注册规则 */
function install(t) {
  for (const p of EXPANSION_PLANTS) {
    t.reg.register(expansionBlockInput(p));
    t.botany.registerTrait(p.name, p.trait);
  }
  for (const rule of EXPANSION_RULES) t.botany.registerRule(rule);
}

/** 纯函数规则用的确定性上下文 */
function fakeCtx(overrides = {}) {
  const calls = { boost: [], grow: [], write: [] };
  const ctx = {
    x: 5,
    y: 21,
    z: 5,
    id: 139,
    daylight: 1,
    rng: () => 0,
    energy: () => 100,
    boost: (...a) => calls.boost.push(a),
    canGrow: () => true,
    supported: () => true,
    grow: (...a) => {
      calls.grow.push(a);
      return true;
    },
    write: (...a) => {
      calls.write.push(a);
      return true;
    },
    get: () => 0,
    isSolid: () => false,
    biome: () => 'plains',
    surface: () => 20,
    // 扩展上下文的只读默认值；规则测试按需 override，避免 fake ctx 与真实接口漂移
    day: () => 0,
    season: () => 'spring',
    weather: () => 'clear',
    soil: () => 100,
    enrichSoil: () => {},
    neighbors: (x, y, z) => [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y, z + 1],
      [x, y, z - 1],
      [x, y + 1, z],
      [x, y - 1, z],
    ],
    ...overrides,
  };
  return { ctx, calls };
}

function fakeApi() {
  return {
    registerBlock() {},
    registerTile() {},
    registerEntity() {},
    setGenerator() {},
    emit() {},
    world: { getBlock: () => 0, setBlock: () => true },
    tnt: { ignite() {} },
    entities: { spawn() {} },
    player: { teleport() {}, setFly() {}, break() {}, place() {} },
    survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
    save: { import() {}, setProvider() {} },
    blocks: { register() {}, get: (v) => v },
    botany: {
      registerPlant() {},
      unregisterPlant() {},
      registerRule() {},
      unregisterRules: () => 0,
      listRules: () => [],
      stats: () => ({}),
    },
  };
}

log('\n[1] 扩展植物 id 契约');
{
  const t = makeWorld();
  ok(
    '内置方块为 152 种（141 基线 + 内容植物扩充 11），插件未挤占内置表',
    t.reg.all().length === 152,
    `${t.reg.all().length}`,
  );
  ok('内置最大 id 为 158（glow_torch）', Math.max(...t.reg.all().map((d) => d.id)) === 158);
  install(t);
  ok(
    '10 种插件植物 id 159~168 连续末位追加',
    EXPANSION_PLANTS.every((p, i) => t.reg.byNameGet(p.name)?.id === 159 + i),
    EXPANSION_PLANTS.map((p) => `${p.name}=${t.reg.byNameGet(p.name).id}`).join(' '),
  );
  ok(
    '旧 id 未重排（black_wool=44 / spruce_leaves=91 / glow_fern=147）',
    t.reg.byNameGet('black_wool').id === 44 &&
      t.reg.byNameGet('spruce_leaves').id === 91 &&
      t.reg.byNameGet('glow_fern').id === 147,
  );
  ok(
    '全部 id ≤ 255（Uint8Array 存储安全）',
    EXPANSION_PLANTS.every((p) => t.reg.byNameGet(p.name).id <= 255),
  );
  ok('覆盖 solar / hydro / fungal 三类代谢', new Set(EXPANSION_PLANTS.map((p) => p.trait.metabolism)).size === 3);
  ok(
    '扩展方块均为 cross 且非实心',
    EXPANSION_PLANTS.every((p) => {
      const d = t.reg.byNameGet(p.name);
      return d.shape === 'cross' && !d.solid;
    }),
  );
  ok('EXPANSION_PLANT_COUNT 与数据一致', EXPANSION_PLANT_COUNT === 10, `${EXPANSION_PLANT_COUNT}`);
}

log('\n[2] 规则注册表契约');
{
  const t = makeWorld();
  install(t);
  const r = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  const a = { id: 'a', owner: 'o', plants: ['thistle'], tick: () => false };
  const b = { id: 'b', owner: 'o', plants: ['thistle'], tick: () => false };
  r.register(a);
  r.register(b);
  assert.throws(() => r.register(a), /重复注册/);
  assert.throws(() => r.register({ id: '', owner: 'o', plants: ['x'], tick: () => false }), /字段不完整/);
  ok('重复 id 与字段缺失都会被拒绝', r.size === 2, `${r.size}`);
  ok('同一方块命中多条规则', r.ruleFor(159).length === 2, `${r.ruleFor(159).length}`);

  // 优先级：按 (priority, id) 双键稳定排序
  const pr = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  pr.register({ id: 'zeta', owner: 'o', plants: ['thistle'], priority: 1, tick: () => false });
  pr.register({ id: 'alpha', owner: 'o', plants: ['thistle'], priority: 1, tick: () => false });
  pr.register({ id: 'first', owner: 'o', plants: ['thistle'], priority: -1, tick: () => false });
  const ordered = pr.ruleFor(159).map((rule) => rule.id);
  ok(
    '规则按 (priority, id) 双键稳定排序',
    ordered[0] === 'first' && ordered[1] === 'alpha' && ordered[2] === 'zeta',
    ordered.join(','),
  );
  ok(
    'list() 暴露 priority',
    pr.list().some((info) => info.priority === -1 && info.id === 'first'),
  );

  ok('按 owner 批量注销', r.unregister('o') === 2 && r.ruleFor(159).length === 0);

  // 动态解析：先注册引用「尚不存在方块」的规则，方块补齐后自动命中
  const late = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  late.register({ id: 'late', owner: 'late', plants: ['future_plant'], tick: () => false });
  ok('注册时方块尚未存在 → 不命中', late.ruleFor(200).length === 0);
  t.reg.register({
    id: 200,
    name: 'future_plant',
    label: '未来植物',
    shape: 'cross',
    solid: false,
    opaque: false,
    liquid: false,
    transparentPass: false,
    lightEmission: 0,
    hardness: 0,
    sound: 'plant',
    tiles: { top: 'x', bottom: 'x', side: 'x' },
  });
  ok('方块补齐后按名称重新解析即命中', late.ruleFor(200).length === 1);
}

log('\n[3] botany:register 权限裁剪');
{
  const denied = scopeAPI(fakeApi(), []);
  assert.throws(() => denied.botany.registerPlant('thistle', {}), /botany:register/);
  assert.throws(() => denied.botany.registerRule({}), /botany:register/);
  assert.throws(() => denied.botany.unregisterRules('x'), /botany:register/);
  assert.throws(() => denied.world.decorate(1, 2, 3, 4), /world:write/);
  ok('未声明权限时 botany 写入口与 decorate 全部拦截', true);
  ok(
    '读能力保留（listRules / stats）',
    Array.isArray(denied.botany.listRules()) && typeof denied.botany.stats() === 'object',
  );
  const allowed = scopeAPI(fakeApi(), ['botany:register']);
  assert.doesNotThrow(() => allowed.botany.registerRule({}));
  assert.doesNotThrow(() => allowed.botany.registerPlant('x', {}));
  ok('声明权限后放行', true);
}

log('\n[4] 既有四条规则的确定性行为');
{
  const [pollination, nocturnal, frostline] = EXPANSION_RULES;
  ok(
    '规则数量与 owner 正确',
    EXPANSION_RULES.length === 8 && EXPANSION_RULES.every((r) => r.owner === EXPANSION_PLUGIN_ID),
  );

  {
    const { ctx, calls } = fakeCtx({ get: () => 93 });
    pollination.tick(ctx);
    ok(
      '异花传粉：邻近异种植物时加能 6',
      calls.boost.length === 1 && calls.boost[0][3] === 6,
      JSON.stringify(calls.boost),
    );
  }
  {
    const { ctx, calls } = fakeCtx();
    pollination.tick(ctx);
    ok('异花传粉：无邻居不误加能', calls.boost.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({ get: () => 93, rng: () => 0.9 });
    pollination.tick(ctx);
    ok('异花传粉：概率门控生效', calls.boost.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({ daylight: 0.1, isSolid: () => true });
    const changed = nocturnal.tick(ctx);
    ok(
      '夜间蔓延：暗光 + 蓄能充足时向空地扩散',
      changed === true && calls.grow.length === 1 && calls.grow[0][4] === 'spread',
      JSON.stringify(calls.grow),
    );
  }
  {
    const { ctx, calls } = fakeCtx({ daylight: 0.9, isSolid: () => true });
    ok('夜间蔓延：白天不触发', nocturnal.tick(ctx) === false && calls.grow.length === 0);
    {
      const { ctx, calls } = fakeCtx({ daylight: 0.3, isSolid: () => true });
      ok('夜间蔓延：黄昏也不触发（收敛保护）', nocturnal.tick(ctx) === false && calls.grow.length === 0);
    }
  }
  {
    const { ctx, calls } = fakeCtx({ daylight: 0.1, energy: () => 10, isSolid: () => true });
    ok('夜间蔓延：能量不足不触发', nocturnal.tick(ctx) === false && calls.grow.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({ biome: () => 'alpine' });
    ok('霜线：高山近地表存活', frostline.tick(ctx) === false && calls.write.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx();
    ok(
      '霜线：非高山整列枯萎',
      frostline.tick(ctx) === true &&
        calls.write.length === 1 &&
        calls.write[0][3] === 0 &&
        calls.write[0][4] === 'decay',
      JSON.stringify(calls.write),
    );
  }
  {
    const { ctx, calls } = fakeCtx({ biome: () => 'alpine', y: 5 });
    ok('霜线：高山但远离地表也枯萎', frostline.tick(ctx) === true && calls.write.length === 1);
  }
}

log('\n[5] Botany 集成与注销');
{
  const t = makeWorld();
  install(t);
  ok(
    '8 条规则已注册',
    t.botany.listRules().length === 8,
    t.botany
      .listRules()
      .map((r) => r.id)
      .join(', '),
  );

  t.world.setBlock(5, 21, 5, t.id('thistle'));
  t.botany.setEnergy(5, 21, 5, 40);
  ok('registerTrait 让扩展植物进入能量体系', t.botany.energyAt(5, 21, 5) === 40);
  for (let i = 0; i < 5; i++) t.botany.tickAt(5, 21, 5, 1);
  ok('白天持续蓄能', t.botany.energyAt(5, 21, 5) > 40, `energy=${t.botany.energyAt(5, 21, 5)}`);

  t.world.setBlock(6, 21, 6, t.id('frost_bloom'));
  t.botany.setEnergy(6, 21, 6, 100);
  ok(
    '霜线规则经 Botany 兜底分派生效（ plains 枯萎）',
    t.botany.tickAt(6, 21, 6, 1) === true && t.world.getBlock(6, 21, 6) === 0,
  );

  ok('按 owner 注销 8 条规则', t.botany.unregisterRules(EXPANSION_PLUGIN_ID) === 8);
  ok('注销后规则表为空', t.botany.listRules().length === 0);
  t.world.setBlock(7, 21, 7, t.id('frost_bloom'));
  t.botany.setEnergy(7, 21, 7, 100);
  ok(
    '注销后植物不再被改动（退回静态装饰）',
    t.botany.tickAt(7, 21, 7, 1) === false && t.world.getBlock(7, 21, 7) === t.id('frost_bloom'),
  );
}

log('\n[6] 扩展上下文（day / season / weather / soil）与 enrichSoil');
{
  const t = makeWorld();
  install(t);
  const seen = {};
  t.botany.registerRule({
    id: 'test:env-probe',
    owner: 'test',
    plants: ['thistle'],
    tick(ctx) {
      seen.day = ctx.day();
      seen.season = ctx.season();
      seen.weather = ctx.weather();
      seen.soil = ctx.soil(ctx.x, ctx.y - 1, ctx.z);
      ctx.enrichSoil(ctx.x, ctx.y - 1, ctx.z, 20);
      return false;
    },
  });
  t.world.setBlock(9, 21, 9, t.id('thistle'));
  t.botany.setNutrient(9, 20, 9, 30);
  t.botany.tickAt(9, 21, 9, 1);
  ok(
    '扩展上下文可读 day / season / weather',
    seen.day === 0 && seen.season === 'spring' && seen.weather === 'clear',
    JSON.stringify(seen),
  );
  ok(
    '扩展上下文可读 soil 且 enrichSoil 生效',
    seen.soil === 30 && t.botany.nutrientAt(9, 20, 9) === 50,
    `soil=${seen.soil} now=${t.botany.nutrientAt(9, 20, 9)}`,
  );
  ok('扩展规则按 owner 注销', t.botany.unregisterRules('test') === 1);
}

log('\n[6] 自然生成选种');
{
  const hashA = spawnHash(3, 4, 2026);
  const hashB = spawnHash(3, 4, 2026);
  ok('同一 seed + 坐标哈希稳定', hashA === hashB);
  ok(
    '坐标 / seed 变化会改变哈希',
    spawnHash(3, 4, 2026) !== spawnHash(4, 3, 2026) && spawnHash(3, 4, 2026) !== spawnHash(3, 4, 2027),
  );
  ok('alpine 命中霜花', planSpawn('alpine', 0.001, false) === 'frost_bloom');
  ok('plains 命中蓟', planSpawn('plains', 0.001, false) === 'thistle');
  ok('未知群系不生成', planSpawn('unknown', 0.001, false) === null);
  // 香蒲被跳过后，roll 落入末尾追加的攀墙藤区间——既证明临水约束生效，也证明新植物补位确定
  ok(
    '临水约束：无水时跳过香蒲，由攀墙藤补位',
    planSpawn('plains', 0.009, false) === 'climbing_vine',
    planSpawn('plains', 0.009, false),
  );
  ok('临水约束：有水时命中香蒲', planSpawn('plains', 0.009, true) === 'cattail');
  ok('大 roll 不命中任何植物', planSpawn('plains', 0.9, true) === null);
  ok(
    'roll 达到上界即短路（插件预过滤契约）',
    planSpawn('beach', SPAWN_ROLL_CEILING, true) === null && SPAWN_ROLL_CEILING === 0.04,
  );
}

log('\n[7] 内置生态不受影响');
{
  const t = makeWorld();
  ok('未安装插件时规则表为空', t.botany.listRules().length === 0);
  t.world.setBlock(5, 21, 5, t.id('poppy'));
  ok('内置花卉仍走原分支且不会抛错', typeof t.botany.tickAt(5, 21, 5, 1) === 'boolean');
  ok('内置方块总数未变', t.reg.all().length === 152);
}

log('\n[8] 四种新机制的确定性断言（T2）');
{
  const ruleOf = (suffix) => EXPANSION_RULES.find((r) => r.id === `core:botany-expansion:${suffix}`);
  const climbing = ruleOf('climbing');
  const parasitism = ruleOf('parasitism');
  const wind = ruleOf('wind_dispersal');
  const circadian = ruleOf('circadian_phase');
  /** 固定 seed 的线性同余序列：同 seed 必然同序列，用来断言「十次一致」 */
  const seededRng = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  ok(
    '新增 4 条规则均已注入且 owner 一致',
    [climbing, parasitism, wind, circadian].every(Boolean) &&
      [climbing, parasitism, wind, circadian].every((r) => r.owner === EXPANSION_PLUGIN_ID),
  );
  ok(
    '缢丝花 priority = -1（框架越小越先，先于默认 0 的传粉规则）',
    parasitism.priority === -1,
    `priority=${parasitism.priority}`,
  );

  // ---- 攀墙藤：有墙才长 / 向上长 / 高度上限 / 随机门槛 / 确定性 ----
  {
    const { ctx, calls } = fakeCtx({ id: 165, isSolid: (x) => x === 4 });
    const changed = climbing.tick(ctx);
    ok(
      '攀墙藤：有实心墙 + 能量足 → 向上 grow 一次',
      changed === true && calls.grow.length === 1 && calls.grow[0].slice(0, 5).join(',') === '5,22,5,165,grow',
      JSON.stringify(calls.grow),
    );
    ok(
      '攀墙藤：攀援成功后才给向光增益 +2',
      calls.boost.length === 1 && calls.boost[0][3] === 2,
      JSON.stringify(calls.boost),
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 165 });
    ok(
      '攀墙藤：无墙时不生长（退化为矮丛，不横向蔓延）',
      climbing.tick(ctx) === false && calls.grow.length === 0 && calls.boost.length === 0,
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 165, y: 26, surface: () => 20, isSolid: () => true });
    ok('攀墙藤：到达 surface+6 高度上限后不再生长', climbing.tick(ctx) === false && calls.grow.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({ id: 165, rng: () => 0.9, isSolid: () => true });
    ok('攀墙藤：随机门槛 >0.08 时不生长', climbing.tick(ctx) === false && calls.grow.length === 0);
  }
  {
    const run = () => {
      const { ctx, calls } = fakeCtx({
        id: 165,
        rng: seededRng(2026),
        isSolid: () => true,
      });
      climbing.tick(ctx);
      return JSON.stringify(calls.grow);
    };
    const outcomes = Array.from({ length: 10 }, run);
    ok('攀墙藤：同 seed 十次结果完全一致', new Set(outcomes).size === 1, outcomes[0]);
  }

  // ---- 缢丝花：定点转移 / 宿主停吸 / 85 自限 / 无宿主 ----
  {
    const { ctx, calls } = fakeCtx({
      id: 166,
      get: (x) => (x === 6 ? 159 : 0),
      energy: (x) => (x === 6 ? 30 : 40),
    });
    parasitism.tick(ctx);
    ok(
      '缢丝花：宿主 -4 / 自身 +6',
      calls.boost.length === 2 && calls.boost[0][0] === 6 && calls.boost[0][3] === -4 && calls.boost[1][3] === 6,
      JSON.stringify(calls.boost),
    );
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 166,
      get: (x) => (x === 6 ? 159 : 0),
      energy: (x) => (x === 6 ? 15 : 40),
    });
    const changed = parasitism.tick(ctx);
    ok(
      '缢丝花：宿主能量 ≤15 时停吸并 write decay',
      changed === true && calls.boost.length === 0 && calls.write.length === 1 && calls.write[0][4] === 'decay',
      JSON.stringify(calls.write),
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 166, energy: () => 90 });
    ok(
      '缢丝花：无宿主且能量越过 bloom 时退回不开花营养体',
      parasitism.tick(ctx) === true && calls.write.length === 1 && calls.write[0][4] === 'decay',
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 166, energy: () => 60 });
    ok(
      '缢丝花：无宿主但未蓄满时零写入',
      parasitism.tick(ctx) === false && calls.write.length === 0 && calls.boost.length === 0,
    );
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 166,
      get: (x) => (x === 6 ? 159 : 0),
      energy: (x) => (x === 6 ? 30 : 85),
    });
    ok(
      '缢丝花：自身已到 85 上限时完全停止补能',
      parasitism.tick(ctx) === false && calls.boost.length === 0,
      JSON.stringify(calls.boost),
    );
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 166,
      get: (x) => (x === 6 ? 159 : 0),
      energy: (x) => (x === 6 ? 30 : 80),
    });
    parasitism.tick(ctx);
    ok(
      '缢丝花：自身 80 时只补 5（85 上限钳制生效）',
      calls.boost.length === 2 && calls.boost[1][3] === 5,
      JSON.stringify(calls.boost),
    );
  }

  // ---- 风信草：方向纯函数 / 只写下风 / 概率门控 / 确定性 ----
  {
    const a = windDirection('spring', 4);
    const b = windDirection('spring', 4);
    ok('风信草：同 season + day 风向恒定', a.dx === b.dx && a.dz === b.dz, `${a.dx},${a.dz}`);
    ok(
      '风信草：day%3!==0 时顺时针偏一格（春东 → 春南）',
      windDirection('spring', 3).dx === 1 &&
        windDirection('spring', 3).dz === 0 &&
        windDirection('spring', 4).dx === 0 &&
        windDirection('spring', 4).dz === 1,
    );
    const year = ['spring', 'summer', 'autumn', 'winter']
      .map((s) => {
        const d = windDirection(s, 3);
        return `${d.dx},${d.dz}`;
      })
      .join('|');
    ok('风信草：四季基准方位为 春东/夏南/秋西/冬北', year === '1,0|0,1|-1,0|0,-1', year);
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 167,
      day: () => 3,
      season: () => 'spring',
      isSolid: () => true,
      // 让 grow 返回 false，规则才会继续尝试 2 格，从而验证「1~2 格」的完整路径
      grow: (...a) => {
        calls.grow.push(a);
        return false;
      },
    });
    wind.tick(ctx);
    ok(
      '风信草：只在下风 1~2 格写入（春分日向东）',
      calls.grow.length === 2 &&
        calls.grow[0][0] === 6 &&
        calls.grow[1][0] === 7 &&
        calls.grow.every((g) => g[2] === 5 && g[4] === 'spread'),
      JSON.stringify(calls.grow),
    );
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 167,
      day: () => 3,
      season: () => 'spring',
      isSolid: () => true,
      get: (x) => (x > 5 ? 159 : 0),
    });
    ok('风信草：下风格被占时不向上风回退', wind.tick(ctx) === false && calls.grow.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({
      id: 167,
      day: () => 3,
      season: () => 'spring',
      isSolid: () => true,
      rng: () => 0.9,
    });
    ok('风信草：概率 >0.05 时不传播', wind.tick(ctx) === false && calls.grow.length === 0);
  }
  {
    const run = () => {
      const { ctx, calls } = fakeCtx({
        id: 167,
        day: () => 4,
        season: () => 'spring',
        isSolid: () => true,
        rng: seededRng(2026),
      });
      wind.tick(ctx);
      return JSON.stringify(calls.grow);
    };
    const outcomes = Array.from({ length: 10 }, run);
    ok('风信草：同 seed 十次结果完全一致', new Set(outcomes).size === 1, outcomes[0]);
  }

  // ---- 日晷花：四个相位互斥 / 阈值边界 / 夜间零写入 ----
  {
    const { ctx, calls } = fakeCtx({ id: 168, daylight: 0.2 });
    ok(
      '日晷花：黎明 [0.15,0.4) 只蓄能 +8，不写世界',
      circadian.tick(ctx) === false &&
        calls.boost.length === 1 &&
        calls.boost[0][3] === 8 &&
        calls.grow.length === 0 &&
        calls.write.length === 0,
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 168, daylight: 0.8, energy: () => 90 });
    ok(
      '日晷花：正午 ≥0.7 且蓄满才 ripen',
      circadian.tick(ctx) === true &&
        calls.write.length === 1 &&
        calls.write[0][4] === 'ripen' &&
        calls.boost.length === 0,
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 168, daylight: 0.8, energy: () => 60 });
    ok('日晷花：正午未蓄满时不成熟', circadian.tick(ctx) === false && calls.write.length === 0);
  }
  {
    const { ctx, calls } = fakeCtx({ id: 168, daylight: 0.45, isSolid: () => true });
    ok(
      '日晷花：黄昏 [0.4,0.5) 低概率向邻格 spread',
      circadian.tick(ctx) === true &&
        calls.grow.length === 1 &&
        calls.grow[0][4] === 'spread' &&
        calls.boost.length === 0 &&
        calls.write.length === 0,
    );
  }
  {
    const { ctx, calls } = fakeCtx({ id: 168, daylight: 0.1 });
    ok(
      '日晷花：夜间 <0.15 休眠且零写入',
      circadian.tick(ctx) === false && calls.boost.length === 0 && calls.grow.length === 0 && calls.write.length === 0,
    );
  }
  {
    /** 把一个 daylight 映射为实际触发的动作，便于逐点校验阈值 */
    const action = (light) => {
      const { ctx, calls } = fakeCtx({
        id: 168,
        daylight: light,
        energy: () => 100,
        isSolid: () => true,
      });
      circadian.tick(ctx);
      if (calls.boost.length) return 'boost';
      if (calls.write.length) return 'ripen';
      if (calls.grow.length) return 'spread';
      return 'none';
    };
    ok(
      '日晷花阈值边界：.15 黎明 / .4 黄昏 / .5 空档 / .7 正午',
      action(0.15) === 'boost' && action(0.4) === 'spread' && action(0.5) === 'none' && action(0.7) === 'ripen',
      [0.15, 0.4, 0.5, 0.7].map(action).join(','),
    );
  }

  // ---- 数据契约：id / 代谢 / 采集 key / 生成权重 ----
  {
    const ids = EXPANSION_PLANTS.map((p) => p.id);
    ok(
      '10 种扩展植物 id 159~168 唯一且 ≤255',
      ids.length === 10 && new Set(ids).size === 10 && ids.every((v, i) => v === 159 + i && v <= 255),
      ids.join(','),
    );
    const meta = EXPANSION_PLANTS.reduce((acc, p) => {
      acc[p.trait.metabolism] = (acc[p.trait.metabolism] ?? 0) + 1;
      return acc;
    }, {});
    ok(
      '三类代谢齐全且分布为 solar 5 / hydro 2 / fungal 3',
      meta.solar === 5 && meta.hydro === 2 && meta.fungal === 3,
      JSON.stringify(meta),
    );
    ok(
      '新 4 种植物采集物复用现有 key，未新增 item',
      EXPANSION_PLANTS.slice(6).every((p) =>
        ['item:nectar', 'item:glow_spore', 'item:wheat_seeds'].includes(p.trait.harvest.item),
      ),
    );
    const sums = {};
    for (const p of EXPANSION_PLANTS) {
      for (const [biome, weight] of Object.entries(p.spawn)) {
        sums[biome] = (sums[biome] ?? 0) + weight;
      }
    }
    ok(
      '追加后各群系累计权重仍 ≤ SPAWN_ROLL_CEILING',
      Object.values(sums).every((v) => v <= SPAWN_ROLL_CEILING + 1e-9),
      JSON.stringify(sums),
    );
  }
}

log(`\nPASS 生态扩展点回归：${passed} 组断言全部通过\n`);
