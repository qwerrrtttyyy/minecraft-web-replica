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
const { ServiceContainer } = require('./logic/services/ServiceContainer.js');
const { moveBody } = require('./logic/player/physics.js');

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

  console.log(`\nPASS 审查修复回归：${passed} 项断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
