/**
 * 生态扩展点回归（v1.4.3）。
 * 运行：node test/botany-rules-check.cjs（需先 npm run test:snapshot）
 *
 * 覆盖：
 * - 6 种扩展植物的 id 契约（120~125 末位追加、旧 id 不动、三类代谢）
 * - PlantRuleRegistry 的注册 / 动态解析 / 多规则命中 / 按 owner 注销
 * - botany:register 权限裁剪（写拦截、读保留）
 * - 4 条规则的纯函数行为（确定性 fake ctx，不依赖概率收敛）
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
  EXPANSION_PLANT_COUNT, EXPANSION_PLUGIN_ID, EXPANSION_PLANTS, EXPANSION_RULES,
  SPAWN_ROLL_CEILING, expansionBlockInput, planSpawn, spawnHash,
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
    x: 5, y: 21, z: 5, id: 139, daylight: 1,
    rng: () => 0,
    energy: () => 100,
    boost: (...a) => calls.boost.push(a),
    canGrow: () => true,
    supported: () => true,
    grow: (...a) => { calls.grow.push(a); return true; },
    write: (...a) => { calls.write.push(a); return true; },
    get: () => 0,
    isSolid: () => false,
    biome: () => 'plains',
    surface: () => 20,
    neighbors: (x, y, z) => [
      [x + 1, y, z], [x - 1, y, z], [x, y, z + 1], [x, y, z - 1],
      [x, y + 1, z], [x, y - 1, z],
    ],
    ...overrides,
  };
  return { ctx, calls };
}

function fakeApi() {
  return {
    registerBlock() {}, registerTile() {}, registerEntity() {}, setGenerator() {}, emit() {},
    world: { getBlock: () => 0, setBlock: () => true },
    tnt: { ignite() {} },
    entities: { spawn() {} },
    player: { teleport() {}, setFly() {}, break() {}, place() {} },
    survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
    save: { import() {}, setProvider() {} },
    blocks: { register() {}, get: (v) => v },
    botany: {
      registerPlant() {}, unregisterPlant() {}, registerRule() {},
      unregisterRules: () => 0, listRules: () => [], stats: () => ({}),
    },
  };
}

log('\n[1] 扩展植物 id 契约');
{
  const t = makeWorld();
  ok('内置方块为 152 种（141 基线 + 内容植物扩充 11），插件未挤占内置表',
    t.reg.all().length === 152, `${t.reg.all().length}`);
  ok('内置最大 id 为 158（glow_torch）', Math.max(...t.reg.all().map((d) => d.id)) === 158);
  install(t);
  ok('6 种插件植物 id 159~164 连续末位追加',
    EXPANSION_PLANTS.every((p, i) => t.reg.byNameGet(p.name)?.id === 159 + i),
    EXPANSION_PLANTS.map((p) => `${p.name}=${t.reg.byNameGet(p.name).id}`).join(' '));
  ok('旧 id 未重排（black_wool=44 / spruce_leaves=91 / glow_fern=147）',
    t.reg.byNameGet('black_wool').id === 44 && t.reg.byNameGet('spruce_leaves').id === 91 &&
    t.reg.byNameGet('glow_fern').id === 147);
  ok('全部 id ≤ 255（Uint8Array 存储安全）',
    EXPANSION_PLANTS.every((p) => t.reg.byNameGet(p.name).id <= 255));
  ok('覆盖 solar / hydro / fungal 三类代谢',
    new Set(EXPANSION_PLANTS.map((p) => p.trait.metabolism)).size === 3);
  ok('扩展方块均为 cross 且非实心',
    EXPANSION_PLANTS.every((p) => {
      const d = t.reg.byNameGet(p.name);
      return d.shape === 'cross' && !d.solid;
    }));
  ok('EXPANSION_PLANT_COUNT 与数据一致', EXPANSION_PLANT_COUNT === 6, `${EXPANSION_PLANT_COUNT}`);
}

log('\n[2] 规则注册表契约');
{
  const t = makeWorld();
  install(t);
  const r = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  const a = { id: 'a', owner: 'o', plants: ['thistle'], tick: () => false };
  const b = { id: 'b', owner: 'o', plants: ['thistle'], tick: () => false };
  r.register(a); r.register(b);
  assert.throws(() => r.register(a), /重复注册/);
  assert.throws(() => r.register({ id: '', owner: 'o', plants: ['x'], tick: () => false }), /字段不完整/);
  ok('重复 id 与字段缺失都会被拒绝', r.size === 2, `${r.size}`);
  ok('同一方块命中多条规则', r.ruleFor(148).length === 2, `${r.ruleFor(148).length}`);

  // 优先级：按 (priority, id) 双键稳定排序
  const pr = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  pr.register({ id: 'zeta', owner: 'o', plants: ['thistle'], priority: 1, tick: () => false });
  pr.register({ id: 'alpha', owner: 'o', plants: ['thistle'], priority: 1, tick: () => false });
  pr.register({ id: 'first', owner: 'o', plants: ['thistle'], priority: -1, tick: () => false });
  const ordered = pr.ruleFor(148).map((rule) => rule.id);
  ok('规则按 (priority, id) 双键稳定排序',
    ordered[0] === 'first' && ordered[1] === 'alpha' && ordered[2] === 'zeta',
    ordered.join(','));
  ok('list() 暴露 priority',
    pr.list().some((info) => info.priority === -1 && info.id === 'first'));

  ok('按 owner 批量注销', r.unregister('o') === 2 && r.ruleFor(148).length === 0);

  // 动态解析：先注册引用「尚不存在方块」的规则，方块补齐后自动命中
  const late = new PlantRuleRegistry((n) => t.reg.byNameGet(n)?.id ?? 0);
  late.register({ id: 'late', owner: 'late', plants: ['future_plant'], tick: () => false });
  ok('注册时方块尚未存在 → 不命中', late.ruleFor(200).length === 0);
  t.reg.register({
    id: 200, name: 'future_plant', label: '未来植物', shape: 'cross', solid: false,
    opaque: false, liquid: false, transparentPass: false, lightEmission: 0,
    hardness: 0, sound: 'plant',
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
  ok('读能力保留（listRules / stats）',
    Array.isArray(denied.botany.listRules()) && typeof denied.botany.stats() === 'object');
  const allowed = scopeAPI(fakeApi(), ['botany:register']);
  assert.doesNotThrow(() => allowed.botany.registerRule({}));
  assert.doesNotThrow(() => allowed.botany.registerPlant('x', {}));
  ok('声明权限后放行', true);
}

log('\n[4] 三条规则的确定性行为');
{
  const [pollination, nocturnal, frostline] = EXPANSION_RULES;
  ok('规则数量与 owner 正确',
    EXPANSION_RULES.length === 4 && EXPANSION_RULES.every((r) => r.owner === EXPANSION_PLUGIN_ID));

  {
    const { ctx, calls } = fakeCtx({ get: () => 93 });
    pollination.tick(ctx);
    ok('异花传粉：邻近异种植物时加能 6',
      calls.boost.length === 1 && calls.boost[0][3] === 6, JSON.stringify(calls.boost));
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
    ok('夜间蔓延：暗光 + 蓄能充足时向空地扩散',
      changed === true && calls.grow.length === 1 && calls.grow[0][4] === 'spread',
      JSON.stringify(calls.grow));
  }
  {
    const { ctx, calls } = fakeCtx({ daylight: 0.9, isSolid: () => true });
    ok('夜间蔓延：白天不触发', nocturnal.tick(ctx) === false && calls.grow.length === 0);
  {
    const { ctx, calls } = fakeCtx({ daylight: 0.3, isSolid: () => true });
    ok('夜间蔓延：黄昏也不触发（收敛保护）',
      nocturnal.tick(ctx) === false && calls.grow.length === 0);
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
    ok('霜线：非高山整列枯萎',
      frostline.tick(ctx) === true && calls.write.length === 1 &&
      calls.write[0][3] === 0 && calls.write[0][4] === 'decay',
      JSON.stringify(calls.write));
  }
  {
    const { ctx, calls } = fakeCtx({ biome: () => 'alpine', y: 5 });
    ok('霜线：高山但远离地表也枯萎',
      frostline.tick(ctx) === true && calls.write.length === 1);
  }
}

log('\n[5] Botany 集成与注销');
{
  const t = makeWorld();
  install(t);
  ok('4 条规则已注册', t.botany.listRules().length === 4,
    t.botany.listRules().map((r) => r.id).join(', '));

  t.world.setBlock(5, 21, 5, t.id('thistle'));
  t.botany.setEnergy(5, 21, 5, 40);
  ok('registerTrait 让扩展植物进入能量体系', t.botany.energyAt(5, 21, 5) === 40);
  for (let i = 0; i < 5; i++) t.botany.tickAt(5, 21, 5, 1);
  ok('白天持续蓄能', t.botany.energyAt(5, 21, 5) > 40, `energy=${t.botany.energyAt(5, 21, 5)}`);

  t.world.setBlock(6, 21, 6, t.id('frost_bloom'));
  t.botany.setEnergy(6, 21, 6, 100);
  ok('霜线规则经 Botany 兜底分派生效（ plains 枯萎）',
    t.botany.tickAt(6, 21, 6, 1) === true && t.world.getBlock(6, 21, 6) === 0);

  ok('按 owner 注销 4 条规则', t.botany.unregisterRules(EXPANSION_PLUGIN_ID) === 4);
  ok('注销后规则表为空', t.botany.listRules().length === 0);
  t.world.setBlock(7, 21, 7, t.id('frost_bloom'));
  t.botany.setEnergy(7, 21, 7, 100);
  ok('注销后植物不再被改动（退回静态装饰）',
    t.botany.tickAt(7, 21, 7, 1) === false && t.world.getBlock(7, 21, 7) === t.id('frost_bloom'));
}

log('\n[6] 扩展上下文（day / season / weather / soil）与 enrichSoil');
{
  const t = makeWorld();
  install(t);
  const seen = {};
  t.botany.registerRule({
    id: 'test:env-probe', owner: 'test', plants: ['thistle'],
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
  ok('扩展上下文可读 day / season / weather',
    seen.day === 0 && seen.season === 'spring' && seen.weather === 'clear',
    JSON.stringify(seen));
  ok('扩展上下文可读 soil 且 enrichSoil 生效',
    seen.soil === 30 && t.botany.nutrientAt(9, 20, 9) === 50,
    `soil=${seen.soil} now=${t.botany.nutrientAt(9, 20, 9)}`);
  ok('扩展规则按 owner 注销', t.botany.unregisterRules('test') === 1);
}

log('\n[6] 自然生成选种');
{
  const hashA = spawnHash(3, 4, 2026);
  const hashB = spawnHash(3, 4, 2026);
  ok('同一 seed + 坐标哈希稳定', hashA === hashB);
  ok('坐标 / seed 变化会改变哈希',
    spawnHash(3, 4, 2026) !== spawnHash(4, 3, 2026) &&
    spawnHash(3, 4, 2026) !== spawnHash(3, 4, 2027));
  ok('alpine 命中霜花', planSpawn('alpine', 0.001, false) === 'frost_bloom');
  ok('plains 命中蓟', planSpawn('plains', 0.001, false) === 'thistle');
  ok('未知群系不生成', planSpawn('unknown', 0.001, false) === null);
  ok('临水约束：无水时跳过香蒲', planSpawn('plains', 0.009, false) === null);
  ok('临水约束：有水时命中香蒲', planSpawn('plains', 0.009, true) === 'cattail');
  ok('大 roll 不命中任何植物', planSpawn('plains', 0.9, true) === null);
  ok('roll 达到上界即短路（插件预过滤契约）',
    planSpawn('beach', SPAWN_ROLL_CEILING, true) === null && SPAWN_ROLL_CEILING === 0.04);
}

log('\n[7] 内置生态不受影响');
{
  const t = makeWorld();
  ok('未安装插件时规则表为空', t.botany.listRules().length === 0);
  t.world.setBlock(5, 21, 5, t.id('poppy'));
  ok('内置花卉仍走原分支且不会抛错', typeof t.botany.tickAt(5, 21, 5, 1) === 'boolean');
  ok('内置方块总数未变', t.reg.all().length === 152);
}

log(`\nPASS 生态扩展点回归：${passed} 组断言全部通过\n`);
