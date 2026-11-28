/**
 * 高性能服务体系纯逻辑回归（Node，无浏览器 / 无 three）。
 *
 * 覆盖 PerfService（逐系统耗时采样）与 FrameScheduler（分阶段 / 优先级 / 软帧预算）。
 * 运行前需先执行 `npm run test:snapshot` 从当前 TS 源码生成快照。
 *
 * 耗时测量用「可控时钟」替换 performance.now，避免依赖真实墙钟导致用例抖动。
 */
const assert = require('node:assert');

const { PerfService } = require('./logic/services/perf/PerfService.js');
const { FrameScheduler, SYSTEM_PHASES } = require('./logic/services/perf/FrameScheduler.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

// ---- 可控时钟：调度器内部 now() 读全局 performance.now，替换成计数器 ----
const perfGlobal = globalThis.performance;
const realNow = perfGlobal.now;
let clockMs = 0;
perfGlobal.now = () => clockMs;

console.log('高性能服务体系回归');

// ============================================================
// PerfService
// ============================================================
{
  ok('阶段常量顺序稳定', SYSTEM_PHASES.join(',') === 'input,simulate,render,post');

  const p = new PerfService();
  p.record('a', 5);
  const rep = p.report();
  const a = rep.offenders.find((o) => o.name === 'a');
  ok('record 记录 last / 系统数', a && a.last === 5 && p.stats().systems === 1);
  ok('单样本 p50=p95=max=值', a.p50 === 5 && a.p95 === 5 && a.max === 5);
}

{
  // 1..100 逐帧喂入：p50=51 p95=96 max=100 avg=50.5
  const p = new PerfService();
  for (let i = 1; i <= 100; i++) p.record('x', i);
  const o = p.report().offenders.find((s) => s.name === 'x');
  ok('分位数计算正确（p50/p95/max）',
    o.p50 === 51 && o.p95 === 96 && o.max === 100,
    `p50=${o.p50} p95=${o.p95} max=${o.max}`);
  ok('窗口均值正确', Math.abs(o.avg - 50.5) < 1e-6, `avg=${o.avg}`);
  ok('累计调用数与样本数', o.calls === 100 && o.samples === 100);
}

{
  const p = new PerfService();
  p.record('b', 3);
  p.record('a', 3);
  const rep = p.report();
  ok('同 p95 按名字字典序（确定性）',
    rep.offenders[0].name === 'a' && rep.offenders[1].name === 'b');
}

{
  const p = new PerfService();
  p.record('low', 1);
  p.record('high', 9);
  ok('report 按 p95 降序（热点优先）', p.report().offenders[0].name === 'high');
  ok('top(n) 截断', p.top(1).length === 1 && p.top(1)[0].name === 'high');
  ok('format 含帧耗时与热点', /帧 .*ms/.test(p.format(2)) && p.format(2).includes('high'));
}

{
  const p = new PerfService();
  p.setBudget(16);
  for (let i = 0; i < 10; i++) p.endFrame(10);
  p.endFrame(20);
  const st = p.stats();
  ok('endFrame 统计帧数 / 超预算帧',
    st.frames === 11 && st.overBudgetFrames === 1 && st.budgetMs === 16,
    `frames=${st.frames} over=${st.overBudgetFrames}`);
  ok('整帧耗时 last / 均值', st.frameLast === 20 && Math.abs(st.frameAvg - 120 / 11) < 1e-6);
  ok('budget getter 回读', p.budget === 16);
  p.setBudget(0);
  ok('setBudget(<=0) 关闭超预算统计', p.budget === 0);
}

{
  const p = new PerfService();
  p.record('a', 1);
  p.endFrame(5);
  p.reset();
  const st = p.stats();
  ok('reset 清空全部统计', st.frames === 0 && st.systems === 0 && st.overBudgetFrames === 0);
}

{
  const p = new PerfService();
  p.enabled = false;
  p.record('a', 1);
  p.endFrame(5);
  ok('enabled=false 时热路径空转', p.stats().frames === 0 && p.stats().systems === 0);
  p.dispose();
  ok('dispose 后 enabled=false', p.enabled === false);
}

// ============================================================
// FrameScheduler
// ============================================================
{
  const order = [];
  const s = new FrameScheduler();
  s.add({ name: 'r', phase: 'render', update: () => order.push('r') });
  s.add({ name: 'i', phase: 'input', update: () => order.push('i') });
  s.add({ name: 'p', phase: 'post', update: () => order.push('p') });
  s.add({ name: 's2', phase: 'simulate', priority: 2, update: () => order.push('s2') });
  s.add({ name: 's1', phase: 'simulate', priority: 1, update: () => order.push('s1') });
  s.add({ name: 's1b', phase: 'simulate', priority: 1, update: () => order.push('s1b') });
  s.update(0.016, 0);
  ok('阶段→优先级→注册序（稳定排序）',
    order.join(',') === 'i,s1,s1b,s2,r,p', order.join(','));
}

{
  let runs = 0;
  const s = new FrameScheduler({ budgetMs: 0 });
  s.add({ name: 'a', phase: 'simulate', update: () => { clockMs += 1; runs++; } });
  s.add({ name: 'b', phase: 'render', tier: 'background', update: () => { clockMs += 1; runs++; } });
  s.update(0, 0);
  s.update(0, 0);
  ok('预算 0 = 逐帧等价（含 background 全跑）', runs === 4 && s.budget === 0, `runs=${runs}`);
}

{
  clockMs = 0;
  const s = new FrameScheduler({ budgetMs: 5 });
  let critRuns = 0;
  let bgRuns = 0;
  s.add({ name: 'crit', phase: 'simulate', update: () => { clockMs += 10; critRuns++; } });
  s.add({
    name: 'bg', phase: 'render', tier: 'background', maxDeferFrames: 6,
    update: () => { bgRuns++; },
  });
  s.update(0, 0);
  const st = s.stats();
  ok('超预算：critical 必跑，background 让位',
    critRuns === 1 && bgRuns === 0, `crit=${critRuns} bg=${bgRuns}`);
  ok('调度器报告 throttled / skippedBudget',
    st.throttled === true && st.skippedBudget === 1);
}

{
  clockMs = 0;
  const s = new FrameScheduler({ budgetMs: 5 });
  let bgRuns = 0;
  s.add({ name: 'crit', phase: 'simulate', update: () => { clockMs += 10; } });
  s.add({
    name: 'bg', phase: 'render', tier: 'background', maxDeferFrames: 3,
    update: () => { bgRuns++; },
  });
  for (let i = 0; i < 10; i++) s.update(0, 0);
  // 周期 = maxDeferFrames+1 = 4：第 4、8 帧强制执行
  ok('防饿死：连续跳过后强制执行', bgRuns === 2, `bg=${bgRuns}`);
}

{
  const s = new FrameScheduler();
  let runs = 0;
  s.add({ name: 'x', intervalFrames: 3, update: () => runs++ });
  for (let i = 0; i < 7; i++) s.update(0, 0);
  ok('intervalFrames 门控', runs === 3, `runs=${runs}`);
}

{
  const s = new FrameScheduler();
  let runs = 0;
  s.add({ name: 'y', update: () => runs++ });
  s.setEnabled('y', false);
  s.update(0, 0);
  s.setEnabled('y', true);
  s.update(0, 0);
  ok('setEnabled 运行时切换', runs === 1, `runs=${runs}`);
}

{
  const errors = [];
  const seen = [];
  const s = new FrameScheduler({ onError: (name, err) => errors.push([name, err.message]) });
  s.add({ name: 'boom', update: () => { throw new Error('kaboom'); } });
  s.add({ name: 'after', update: () => seen.push('after') });
  s.update(0, 0);
  ok('系统抛错被隔离，不打断同帧其它系统', seen.length === 1 && errors.length === 1);
  const slot = s.stats().slots.find((sl) => sl.name === 'boom');
  ok('抛错次数计入槽位统计', slot.errors === 1);
}

{
  const perfSvc = new PerfService();
  const s = new FrameScheduler({ perf: perfSvc });
  s.add({ name: 'a', update: () => { clockMs += 2; } });
  s.add({ name: 'b', update: () => { clockMs += 4; } });
  s.update(0, 0);
  const rep = perfSvc.report();
  const names = rep.offenders.map((o) => o.name);
  ok('调度器把耗时喂给 PerfService', names.includes('a') && names.includes('b'));
  const b = rep.offenders.find((o) => o.name === 'b');
  ok('采样值等于系统实际耗时', b.last === 4, `b.last=${b.last}`);
  s.setBudget(16);
  ok('软预算下推给 PerfService（预算单一来源）', perfSvc.budget === 16, `budget=${perfSvc.budget}`);
}

{
  const s = new FrameScheduler();
  s.add({ name: 'dup', update: () => {} });
  assert.throws(() => s.add({ name: 'dup', update: () => {} }), /重复/);
  ok('重复系统名抛错', true);
  ok('has / remove', s.has('dup') === true && s.remove('dup') === true && s.has('dup') === false);
  s.setBudget(8);
  ok('setBudget 运行时回读', s.budget === 8);
}

// 还原全局时钟
perfGlobal.now = realNow;

console.log(`\n合计 ${passed} 项，全部通过`);
