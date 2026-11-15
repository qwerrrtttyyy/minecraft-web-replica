/**
 * 运行时诊断组回归（v1.3.2，纯逻辑，无浏览器 / 无 three）。
 *
 * 覆盖 CraftAPI.diagnostics / F3 面板背后的检查函数：
 * Worker 配置、区块网格收敛、暂停态输入残留、插件失败、
 * 死亡状态一致性、玩家/存档异常。
 */
const assert = require('assert');
const { runRuntimeDiagnostics } = require('./logic/diagnostics/RuntimeDiagnostics.js');
const { VERSION } = require('./logic/core/version.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const base = () => ({
  version: VERSION,
  mode: 'playing',
  gameMode: 'survival',
  player: { x: 0.5, y: 40, z: 0.5, fallDistance: 0 },
  input: { enabled: true, pressedKeys: [] },
  chunks: {
    loading: false,
    mesherMode: 'worker',
    workerCount: 4,
    renderDistance: 5,
    generated: 81,
    meshed: 81,
    dirty: 0,
    inFlight: 0,
    configReady: true,
    configRevision: 1,
    missingMeshes: 0,
    unlitChunks: 0,
  },
  plugins: [
    { id: 'core:autosave', state: 'enabled' },
    { id: 'core:hud-feedback', state: 'enabled' },
  ],
  events: { subscribers: 6, channels: 2, emitted: 120 },
  survival: { health: 20, hunger: 20, breath: 15, dead: false },
  entities: 5,
  save: { dirty: false, lastOkAt: 1_700_000_000_000 },
});

const clone = (mutate) => {
  const s = JSON.parse(JSON.stringify(base()));
  mutate(s);
  return s;
};
const ids = (report) => report.issues.map((i) => i.id);
const has = (report, id) => ids(report).includes(id);

console.log('运行时诊断组回归');

{
  const r = runRuntimeDiagnostics(base());
  ok('健康快照无异常', r.ok && r.errors === 0 && r.warnings === 0,
    `checked=${r.checked} issues=${r.issues.length}`);
  ok('检查项数量达标', r.checked >= 14, `checked=${r.checked}`);
  ok('耗时字段为有限数', Number.isFinite(r.durationMs));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.version = '0.0.0'; }));
  ok('版本不一致被捕获', has(r, 'version') && r.errors >= 1);
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.input.enabled = false;
    s.input.pressedKeys = ['KeyW', 'ShiftLeft'];
    s.mode = 'paused';
  }));
  ok('暂停态残留按键被捕获', has(r, 'input.staleKeys'), ids(r).join(','));
  ok('暂停态 input.enabled=false 不算错误', !has(r, 'input.enabled'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.input.enabled = false; }));
  ok('playing 但输入被禁用被捕获', has(r, 'input.enabled'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.chunks.configReady = false; }));
  ok('Worker 配置未就绪被捕获', has(r, 'chunks.config'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.chunks.workerCount = 0; }));
  ok('Worker 池数量异常被捕获', has(r, 'chunks.worker'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.chunks.loading = false;
    s.chunks.missingMeshes = 3;
  }));
  ok('无网格且无在途任务的区块被捕获', has(r, 'chunks.missingMesh'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.chunks.unlitChunks = 2; }));
  ok('未初始化光照区块被捕获', has(r, 'chunks.unlit'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.chunks.dirty = 20;
    s.chunks.inFlight = 10;
  }));
  ok('网格队列积压被标记为 warn',
    has(r, 'chunks.backlog') && r.warnings >= 1,
    `warnings=${r.warnings}`);
  ok('仅有 warn 时 ok=false 但 error=0', !r.ok && r.errors === 0);
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.plugins.push({ id: 'demo:broken', state: 'failed' });
  }));
  ok('插件失败状态被捕获', has(r, 'plugins.failed'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.plugins.push({ id: 'demo:orphan', state: 'enabled', dependencies: ['demo:missing'] });
    s.plugins.push({ id: 'demo:stopped', state: 'disabled' });
    s.plugins.push({ id: 'demo:needs-stopped', state: 'enabled', dependencies: ['demo:stopped'] });
  }));
  ok('启用插件缺少已启用依赖被捕获', has(r, 'plugins.dependency'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => {
    s.plugins.push({ id: 'demo:ok', state: 'enabled', dependencies: ['core:autosave'] });
  }));
  ok('依赖已满足时不误报', !has(r, 'plugins.dependency'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.survival.dead = true; }));
  ok('死亡状态与主状态机不一致被捕获', has(r, 'survival.deadState'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.survival.health = 99; }));
  ok('生存数值越界被捕获', has(r, 'survival.ranges'));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.player.x = NaN; }));
  ok('玩家坐标 NaN 被捕获', has(r, 'player.position'));
}

{
  const now = Date.now();
  const r = runRuntimeDiagnostics(clone((s) => {
    s.save.dirty = true;
    s.save.lastOkAt = now - 60_000;
  }), now);
  ok('存档长期未保存被标记为 warn',
    has(r, 'save.staleness') && r.warnings >= 1, ids(r).join(','));
}

{
  const r = runRuntimeDiagnostics(clone((s) => { s.entities = 500; }));
  ok('实体数量偏高被标记为 warn', has(r, 'entities.cap'));
}

{
  // 标题态不应因输入禁用 / 区块未网格化产生误报
  const r = runRuntimeDiagnostics(clone((s) => {
    s.mode = 'title';
    s.input.enabled = false;
    s.chunks.meshed = 0;
    s.chunks.generated = 0;
  }));
  ok('标题态不产生输入/区块误报',
    !has(r, 'input.enabled') && !has(r, 'chunks.missingMesh') && !has(r, 'chunks.ghostMesh'),
    ids(r).join(','));
}

console.log(`\nPASS 运行时诊断组：${passed} 组断言全部通过`);
