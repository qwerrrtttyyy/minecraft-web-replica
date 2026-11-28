/**
 * 代码审查修复回归（v1.6.0，纯逻辑，无浏览器 / 无 three 实例）。
 *
 * 覆盖本轮审查发现并修复的问题中可在 Node 侧验证的部分：
 *  - M1  EventService.once 幂等（重入不重复回调）
 *  - M2  PluginService.unload 的错误信息指向“卸载”而非“停用”
 *  - L1  引擎相机远平面常量与 farplane 收敛下限一致
 *  - L3  EventChannel.once 幂等 + 提前 off 后不再触发
 *  - L5  NoiseBackend.dispose 释放后自动回退 JS 且幂等
 *  - L6  moveBody 同轴多个方块时按最近面钳制（不穿透 / 不钳到远端）
 *
 * M/L 编号见审查报告。依赖 test:snapshot 快照。
 */
const assert = require('node:assert');
const { EventService } = require('./logic/services/events/EventService.js');
const { CAMERA_DEFAULT_FAR } = require('./logic/core/engine.js');
const { createNoiseBackend, loadBuiltinKernel } = require('./logic/wasm/kernel.js');
const { makePermutation } = require('./logic/world/noiseMath.js');
const { PluginService } = require('./logic/services/plugins/PluginService.js');
const { MemoryPluginStorageProvider } = require('./logic/services/plugins/storage.js');
const { loadPluginDefinition } = require('./logic/services/plugins/loader.js');
const { PLUGIN_PERMISSIONS } = require('./logic/services/plugins/PluginContext.js');
const { ServiceContainer } = require('./logic/services/ServiceContainer.js');
const { moveBody } = require('./logic/player/physics.js');
const { SurvivalState } = require('./logic/player/survival.js');
const { validateSave } = require('./logic/save/save.js');
const { WorldMeshSource } = require('./logic/world/meshSource.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};
const rejects = (name, fn, re) => {
  let msg = '';
  try { fn(); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  assert.ok(re.test(msg), `${name} — 期望 /${re.source}/，实际「${msg}」`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const fakeApi = () => ({
  version: '1.6.0',
  world: { setBlock: () => true, getBlock: () => 0, decorate() {} },
  player: { teleport() {}, setFly() {}, break() {}, place() {} },
  save: { import() {}, setProvider() {} },
  blocks: { register() {}, get: (id) => id },
  tnt: { ignite() {} },
  entities: { spawn() {}, list: () => [] },
  survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
  botany: { registerPlant() {}, unregisterPlant() {}, registerRule() {}, unregisterRules() {}, listRules: () => [], stats: () => ({}) },
  plugins: {
    register() {}, enable() {}, disable() {}, unload() {}, list: () => [],
    get() {}, reload() {}, enableAll() {}, stats() {}, install() {}, findByCapability() {},
  },
  wasm: {
    status: () => 'ready', stats: () => ({}), benchmark: () => null, setEnabled: () => 'ready',
    listModules: () => [], call: () => 1, callModule: () => 1, registerModule: () => ({}), unregisterModule: () => true,
  },
  registerBlock() {}, registerTile() {}, registerEntity() {}, setGenerator() {},
  on() { return () => {}; }, off() {}, emit() {},
});

async function main() {
  // ---------- M1: EventService.once 幂等 ----------
  console.log('\n[events]');
  {
    const ev = new EventService();
    let n = 0;
    ev.once('block:place', () => { n++; });
    const p = { x: 0, y: 0, z: 0, id: 1, byPlayer: false };
    ev.emit('block:place', p);
    ev.emit('block:place', p);
    ok('EventService.once 只触发一次', n === 1, `实际 ${n}`);
  }
  {
    const ev = new EventService();
    let n = 0;
    ev.once('block:place', () => { n++; ev.emit('block:place', { x: 0, y: 0, z: 0, id: 1, byPlayer: false }); });
    ev.emit('block:place', { x: 0, y: 0, z: 0, id: 1, byPlayer: false });
    ok('EventService.once 重入安全', n === 1, `实际 ${n}`);
  }
  {
    const ev = new EventService();
    let n = 0;
    const off = ev.once('block:place', () => { n++; });
    off();
    ev.emit('block:place', { x: 0, y: 0, z: 0, id: 1, byPlayer: false });
    ok('EventService.once 提前 off 生效', n === 0, `实际 ${n}`);
  }

  // ---------- L3: EventChannel.once 幂等 ----------
  console.log('\n[channel]');
  {
    const ev = new EventService();
    const ch = ev.scope('review:fix');
    let n = 0;
    ch.once('block:place', () => { n++; });
    const p = { x: 0, y: 0, z: 0, id: 1, byPlayer: false };
    ch.emit('block:place', p);
    ch.emit('block:place', p);
    ok('EventChannel.once 只触发一次', n === 1, `实际 ${n}`);
    ch.dispose();
  }
  {
    const ev = new EventService();
    const ch = ev.scope('review:fix2');
    let n = 0;
    const off = ch.once('block:place', () => { n++; });
    off();
    ch.emit('block:place', { x: 0, y: 0, z: 0, id: 1, byPlayer: false });
    ok('EventChannel.once 提前 off 生效', n === 0, `实际 ${n}`);
    ch.dispose();
  }

  // ---------- M2: unload 错误信息指向“卸载” ----------
  console.log('\n[plugins]');
  {
    const ev = new EventService();
    const container = new ServiceContainer();
    const api = fakeApi();
    const ps = new PluginService(ev, container, () => api, { storage: new MemoryPluginStorageProvider() });
    ps.register({ manifest: { id: 'r:base', version: '1.0.0' }, setup() {} });
    ps.register({ manifest: { id: 'r:child', version: '1.0.0', dependencies: ['r:base'] }, setup() {} });
    await ps.enable('r:base');
    await ps.enable('r:child');
    ok('依赖插件已启用', ps.get('r:child').state === 'enabled');
    rejects('unload 错误指向卸载', () => ps.unload('r:base'), /无法卸载 r:base/);
    ok('unload 失败后记录仍在', ps.get('r:base')?.state === 'enabled');
    rejects('disable 错误指向停用', () => ps.disable('r:base'), /无法停用 r:base/);
    ps.unload('r:base', true);
    ok('unload force 成功', ps.get('r:base') === undefined);
  }

  // ---------- L1: 相机远平面常量 ----------
  console.log('\n[engine]');
  ok('CAMERA_DEFAULT_FAR 为 520', CAMERA_DEFAULT_FAR === 520, `实际 ${CAMERA_DEFAULT_FAR}`);

  // ---------- L5: NoiseBackend.dispose ----------
  console.log('\n[wasm-backend]');
  {
    const mod = loadBuiltinKernel();
    const perm = makePermutation(2026);
    const b = createNoiseBackend(mod, perm);
    const before = b.fbm2(1.5, 2.5, 4, 2, 0.5);
    ok('dispose 前可正常调用', Number.isFinite(before));
    b.dispose();
    b.dispose(); // 幂等
    const after = b.fbm2(1.5, 2.5, 4, 2, 0.5);
    ok('dispose 后回退 JS 且结果一致', Object.is(before, after), `${before} vs ${after}`);
  }

  // ---------- L6: 碰撞按最近面钳制 ----------
  console.log('\n[physics]');
  {
    const solid = new Set(['2,0,0', '3,0,0']);
    const world = { isSolidAt: (x, y, z) => solid.has(`${x},${y},${z}`) };
    const body = { pos: { x: 1.9, y: 0, z: 0.5 }, vel: { x: 2, y: 0, z: 0 }, width: 0.6, height: 1.8, onGround: false };
    moveBody(world, body, 0.05);
    ok('碰撞钳制到最近阻挡面（正向）', body.pos.x < 1.75 && body.pos.x > 1.69, `x=${body.pos.x}`);
    const body2 = { pos: { x: 4.1, y: 0, z: 0.5 }, vel: { x: -2, y: 0, z: 0 }, width: 0.6, height: 1.8, onGround: false };
    moveBody(world, body2, 0.05);
    ok('碰撞钳制到最近阻挡面（反向）', body2.pos.x > 4.29 && body2.pos.x < 4.31, `x=${body2.pos.x}`);
    // 顶面恰好贴住上方方块底面：只是相切、不算重叠，不应被抬升
    const solidAbove = new Set(['0,10,0']);
    const worldAbove = { isSolidAt: (x, y, z) => solidAbove.has(`${x},${y},${z}`) };
    const body3 = { pos: { x: 0, y: 8.25, z: 0 }, vel: { x: 0, y: -1, z: 0 }, width: 0.6, height: 1.8, onGround: false };
    moveBody(worldAbove, body3, 0.05);
    ok('顶面与方块底面齐平时不被抬升', Math.abs(body3.pos.y - 8.2) < 1e-6 && !body3.onGround, `y=${body3.pos.y}`);
  }

  // ---------- 第二轮审查修复 ----------
  console.log('\n[review-round-2]');
  {
    // R1: setup 被 disable 取消后，并发 enable 不得重复 setup / drain 别人的 teardown
    const ev = new EventService();
    const ps = new PluginService(ev, new ServiceContainer(), () => fakeApi(), { storage: new MemoryPluginStorageProvider() });
    let setups = 0;
    let teardowns = 0;
    ps.register({
      manifest: { id: 'r:race', version: '1.0.0' },
      async setup() {
        setups++;
        await new Promise((r) => setTimeout(r, 15));
        return () => { teardowns++; };
      },
    });
    const p1 = ps.enable('r:race');
    const p2 = ps.enable('r:race');
    const p3 = ps.enable('r:race');
    ps.disable('r:race');
    await Promise.all([p1, p2, p3]);
    ok('取消后并发 enable 只补一次 setup', setups === 2, `setups=${setups}`);
    ps.disable('r:race');
    ok('每次 setup 的 teardown 各执行一次', teardowns === 2, `teardowns=${teardowns}`);
  }
  {
    // R2: manifest 可变字段注册时必须防御性拷贝
    const ps = new PluginService(new EventService(), new ServiceContainer(), () => fakeApi(), { storage: new MemoryPluginStorageProvider() });
    const manifest = { id: 'r:copy', permissions: [], config: { a: 1 } };
    ps.register({ manifest, setup() {} });
    manifest.permissions.push('world:write');
    manifest.config.a = 99;
    const rec = ps.get('r:copy');
    ok('manifest.permissions 防御性拷贝', (rec.manifest.permissions ?? []).length === 0);
    ok('manifest.config 防御性拷贝', rec.manifest.config.a === 1);
  }
  {
    // R3: install 与 register 必须接受同一套权限
    const missing = PLUGIN_PERMISSIONS.filter((p) => {
      const source = `module.exports = { manifest: { id: 'r:perm', permissions: ['${p}'] }, setup() {} };`;
      try { loadPluginDefinition(source); return false; } catch { return true; }
    });
    ok('install 接受全部 PLUGIN_PERMISSIONS', missing.length === 0, `拒绝: ${missing.join(',')}`);
  }
  {
    // R4: reload 失败时不能谎报成功
    const ev = new EventService();
    const ps = new PluginService(ev, new ServiceContainer(), () => fakeApi(), { storage: new MemoryPluginStorageProvider() });
    ps.register({ manifest: { id: 'r:reload' }, setup() { throw new Error('boom'); } });
    let reloaded = 0;
    ev.on('plugin:reloaded', () => { reloaded++; });
    await assert.rejects(() => ps.reload('r:reload'), /重载失败/);
    ok('reload 失败不发 plugin:reloaded', reloaded === 0);
  }
  {
    // R5: 小数 slot 不是合法数组下标
    const valid = () => ({
      version: 2, seed: 1, mode: 'survival', edits: [],
      player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fly: false },
      survival: { health: 20, hunger: 20, breath: 15, inventory: [], spawn: { x: 0, y: 0, z: 0 } },
      dayTime: 0.3, hotbar: Array.from({ length: 9 }, () => null), slot: 0,
      settings: { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 }, savedAt: 1,
    });
    ok('validateSave 接受合法档', validateSave(valid()) === true);
    ok('validateSave 拒绝小数 slot', validateSave({ ...valid(), slot: 0.5 }) === false);
  }
  {
    // R6: 完全吸收的攻击不应赠送无敌帧
    let absorb = true;
    const ext = {
      has: () => true,
      reduce: (_p, payload) => ({ payload: { ...payload, amount: absorb ? 0 : payload.amount } }),
    };
    const s = new SurvivalState(new EventService(), { get: (id) => ({ id, name: 'air' }) }, ext);
    ok('完全吸收的攻击不扣血', s.damage(5, 'absorb') === false && s.health === 20);
    absorb = false;
    ok('吸收后真实攻击立即生效', s.damage(5, 'real') === true && s.health === 15, `health=${s.health}`);
  }
  {
    // R7: 主线程回退来源也要区分未生成区块（N4 液体面）
    const world = { getChunk: (cx, cz) => (cx === 0 && cz === 0 ? { generated: true } : undefined) };
    const src = new WorldMeshSource(world, 0, 0, { defs: [], uv: {} });
    ok('活世界来源：中心格已知', src.isKnown(0, 10, 0) === true);
    ok('活世界来源：未生成邻居视为未知',
      src.isKnown(-1, 10, 0) === false && src.isKnown(16, 10, 0) === false);
    ok('活世界来源：y 越界保持已知', src.isKnown(-1, -1, 0) === true);
  }

  console.log(`\nPASS 审查修复回归：${passed} 项断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
