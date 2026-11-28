/**
 * 运行时诊断组回归（v1.3.2，纯逻辑，无浏览器 / 无 three）。
 *
 * 覆盖 CraftAPI.diagnostics / F3 面板背后的检查函数：
 * Worker 配置、区块网格收敛、暂停态输入残留、插件失败、
 * 死亡状态一致性、玩家/存档异常。
 */
const assert = require('node:assert');
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
    meshQuads: 81 * 1420,
    meshChunks: 81,
    resident: 81,
    maxResident: 512,
    regenerations: 0,
  },
  plugins: [
    { id: 'core:autosave', state: 'enabled' },
    { id: 'core:hud-feedback', state: 'enabled' },
  ],
  events: { subscribers: 6, channels: 2, emitted: 120 },
  survival: { health: 20, hunger: 20, breath: 15, dead: false },
  entities: 5,
  plant: { tracked: 12, avgEnergy: 64, invalidEnergy: 0 },
  wasm: {
    status: 'disabled', abi: 0, fallbackCount: 0, selfCheckMismatches: 0,
    backend: 'js', benchJsMs: 10, benchWasmMs: 15,
  },
  save: { dirty: false, lastOkAt: 1_700_000_000_000 },
  perf: {
    frames: 120, systems: 8, frameAvgMs: 14.2, frameP95Ms: 20.1,
    budgetMs: 12, schedulerFrames: 120, skippedBudget: 0, errors: 0,
  },
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

  // v1.6：植物生态快照注入回归
  ok('健康植物快照无异常', !has(r, 'plant.energy') && !has(r, 'plant.tracked'));
  {
    const bad = runRuntimeDiagnostics(clone((s) => {
      s.plant.invalidEnergy = 2;
      s.plant.avgEnergy = 500;
    }));
    ok('植物能量越界被捕获', has(bad, 'plant.energy') && bad.errors >= 1, ids(bad).join(','));
  }
  {
    const bad = runRuntimeDiagnostics(clone((s) => {
      s.plant.tracked = -1;
    }));
    ok('跟踪植物数异常被捕获', has(bad, 'plant.tracked'), ids(bad).join(','));
  }

  // 高性能服务体系：调度器会静默隔离系统异常，必须由诊断把被吞掉的异常翻出来
  ok('健康性能快照无异常', !has(r, 'perf.counters') && !has(r, 'perf.systemErrors'));
  {
    const bad = runRuntimeDiagnostics(clone((s) => { s.perf.errors = 3; }));
    ok('调度器隔离的系统异常被捕获', has(bad, 'perf.systemErrors') && bad.errors >= 1, ids(bad).join(','));
  }
  {
    const bad = runRuntimeDiagnostics(clone((s) => { s.perf.frameAvgMs = -1; }));
    ok('性能统计非法值被捕获', has(bad, 'perf.counters'), ids(bad).join(','));
  }
  {
    const bad = runRuntimeDiagnostics(clone((s) => { s.perf.schedulerFrames = 1.5; }));
    ok('非整数调度帧数被捕获', has(bad, 'perf.counters'), ids(bad).join(','));
  }
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
  // 平滑光照的回归护栏：若 Greedy 合并失效（退回逐面基线），必须报出来
  const r = runRuntimeDiagnostics(clone((s) => {
    s.chunks.meshQuads = 81 * 2200;
  }));
  ok('Greedy 合并失效被捕获', has(r, 'chunks.mergeBudget'));
  const healthy = runRuntimeDiagnostics(clone((s) => {
    s.chunks.meshQuads = 81 * 1420;
  }));
  ok('正常合并率不误报', !has(healthy, 'chunks.mergeBudget'));
  const absent = runRuntimeDiagnostics(clone((s) => {
    delete s.chunks.meshQuads;
  }));
  ok('旧快照缺少统计字段时跳过该检查', !has(absent, 'chunks.mergeBudget'));
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

{
  // 区块驻留上限护栏：LRU 策略失效导致驻留失控时必须报出来
  const bad = runRuntimeDiagnostics(clone((s) => {
    s.chunks.resident = 600;
    s.chunks.maxResident = 512;
  }));
  ok('驻留区块超过上限被标记为 warn', has(bad, 'chunks.residentCap') && bad.warnings >= 1, ids(bad).join(','));
  const good = runRuntimeDiagnostics(clone((s) => {
    s.chunks.resident = 512;
  }));
  ok('驻留区块未超限不误报', !has(good, 'chunks.residentCap'));
  const absent = runRuntimeDiagnostics(clone((s) => {
    delete s.chunks.resident;
    delete s.chunks.maxResident;
  }));
  ok('旧快照缺少驻留字段时跳过该检查', !has(absent, 'chunks.residentCap'));
  // v1.5.4：WASM 自适应后端 / 基准耗时的注入回归
  const healthy = runRuntimeDiagnostics(base());
  ok('健康 WASM 快照不产生新检查项',
    !has(healthy, 'wasm.backend') && !has(healthy, 'wasm.bench'), ids(healthy).join(','));
  {
    const r = runRuntimeDiagnostics(clone((s) => { s.wasm.backend = 'bogus'; }));
    ok('非法 WASM backend 被捕获', has(r, 'wasm.backend'), ids(r).join(','));
  }
  {
    const r = runRuntimeDiagnostics(clone((s) => { s.wasm.benchWasmMs = -1; }));
    ok('非法 WASM 基准耗时被捕获', has(r, 'wasm.bench'), ids(r).join(','));
  }
  {
    const r = runRuntimeDiagnostics(clone((s) => {
      delete s.wasm.backend;
      delete s.wasm.benchJsMs;
      delete s.wasm.benchWasmMs;
    }));
    ok('旧快照缺 WASM 新字段时跳过相关检查',
      !has(r, 'wasm.backend') && !has(r, 'wasm.bench'), ids(r).join(','));
  }
}

{
  // 版本限定依赖必须按裸 id 解析，不能误判为「缺少依赖」
  const r = runRuntimeDiagnostics(clone((s) => {
    s.plugins = [
      { id: 'core:base', state: 'enabled' },
      { id: 'core:leaf', state: 'enabled', dependencies: ['core:base@^1.0.0'] },
    ];
  }));
  ok('版本限定的已启用依赖不误报', !has(r, 'plugins.dependency'), ids(r).join(','));
  const bad = runRuntimeDiagnostics(clone((s) => {
    s.plugins = [
      { id: 'core:base', state: 'disabled' },
      { id: 'core:leaf', state: 'enabled', dependencies: ['core:base@^1.0.0'] },
    ];
  }));
  ok('版本限定的依赖确实缺失时被捕获', has(bad, 'plugins.dependency'), ids(bad).join(','));
}

{
  // 天候检查项：注入健康 / 非法 / 双通道漂移三种快照
  const healthyWeather = {
    kind: 'rain', form: 'rain', intensity: 0.6, darkness: 0.72, flash: 0,
    rainLevel: 0.6, chunkDarkness: 0.72, entityDarkness: 0.72,
  };
  const r = runRuntimeDiagnostics(clone((s) => { s.weather = { ...healthyWeather }; }));
  ok('健康天气快照不产生 weather.* 检查项',
    !has(r, 'weather.factor') && !has(r, 'weather.intensity') && !has(r, 'weather.channels'),
    ids(r).join(','));
  const bad = runRuntimeDiagnostics(clone((s) => {
    s.weather = { ...healthyWeather, darkness: 2, intensity: 2 };
  }));
  ok('非法天气因子 / 降水强度被捕获',
    has(bad, 'weather.factor') && has(bad, 'weather.intensity'), ids(bad).join(','));
  const drift = runRuntimeDiagnostics(clone((s) => {
    s.weather = { ...healthyWeather, entityDarkness: 0.9 };
  }));
  ok('方块光 / 实体光天气因子漂移被捕获', has(drift, 'weather.channels'), ids(drift).join(','));
}

{
  // v1.6.0-beta.3：摄影模式相机归属护栏（旧快照缺 photo 字段时跳过）
  const healthy = runRuntimeDiagnostics(clone((s) => {
    s.photo = { active: true, cameraOwner: 'photo', fov: 72 };
  }));
  ok('健康摄影快照不产生 photo 检查项', !has(healthy, 'photo-camera-owner'), ids(healthy).join(','));
  const bad = runRuntimeDiagnostics(clone((s) => {
    s.photo = { active: true, cameraOwner: 'player', fov: 72 };
  }));
  ok('摄影模式激活但相机归属 player 被捕获',
    has(bad, 'photo-camera-owner') && bad.errors >= 1, ids(bad).join(','));
  const leaked = runRuntimeDiagnostics(clone((s) => {
    s.photo = { active: false, cameraOwner: 'photo', fov: 72 };
  }));
  ok('非摄影模式但相机归属 photo 被捕获', has(leaked, 'photo-camera-owner'), ids(leaked).join(','));
  const absent = runRuntimeDiagnostics(base());
  ok('旧快照缺 photo 字段时跳过该检查', !has(absent, 'photo-camera-owner'), ids(absent).join(','));
}

console.log(`\nPASS 运行时诊断组：${passed} 组断言全部通过`);
