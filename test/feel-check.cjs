/**
 * 手感回归（输入响应）：跳跃输入缓冲的边界行为。
 * 运行：node test/feel-check.cjs（需先 npm run test:snapshot）
 *
 * 输入缓冲解决「落地前提前按跳被吞」：按下沿记录时间戳，120ms 内落地仍生效；
 * 消费后不能重复触发；reset 后缓冲清空。
 */
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><canvas></canvas></body></html>', {
  url: 'http://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.addEventListener = dom.window.addEventListener.bind(dom.window);

const { Input } = require('./terrain-logic/input/input.js');
const { CRACK_STAGES, quantizeCrackStage } = require('./terrain-logic/core/types.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}
const newInput = () => {
  const input = new Input(document.querySelector('canvas'), false);
  input.enabled = true;
  return input;
};
const key = (type, code) => dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { code }));

log('手感回归（跳跃输入缓冲）');

// 1) 未按键不缓冲
{
  const input = newInput();
  ok('未按键时 sampleJump 为 false', input.sampleJump(1000) === false);
}

// 2) 按下沿 + 120ms 缓冲窗口
{
  const input = newInput();
  key('keydown', 'Space');
  ok('按下瞬间起跳', input.sampleJump(1000) === true);
  key('keyup', 'Space');
  ok('松手后 100ms 仍算提前输入', input.sampleJump(1100) === true);
  ok('超过 120ms 缓冲失效', input.sampleJump(1121) === false);
}

// 3) 消费后不重复触发（避免一次提前按键连跳多次）
{
  const input = newInput();
  key('keydown', 'Space');
  input.sampleJump(1000);
  key('keyup', 'Space');
  input.consumeJumpBuffer();
  ok('消费缓冲后立刻失效', input.sampleJump(1000) === false);
}

// 4) 持续按住保留原行为（按住连跳）
{
  const input = newInput();
  key('keydown', 'Space');
  ok('持续按住时也返回 true', input.sampleJump(1000) === true);
  ok('按住 500ms 后仍为 true', input.sampleJump(1500) === true);
}

// 5) reset 清空缓冲
{
  const input = newInput();
  key('keydown', 'Space');
  input.sampleJump(1000);
  key('keyup', 'Space');
  input.reset();
  ok('reset 后缓冲清空', input.sampleJump(1050) === false);
}

// 6) N3 裂痕阶段量化：低帧率 / dt 钳制下单调推进，不在每帧改阶段
log('\n手感回归（N3 挖掘裂痕阶段）');
{
  ok('裂痕阶段数为 10（0 无裂纹 + 1..9）', CRACK_STAGES === 10);
  ok('progress=0 对应无裂纹', quantizeCrackStage(0) === 0);
  ok('progress=1 对应满裂纹', quantizeCrackStage(1) === 9);
  ok('边界：负数钳制为 0，>1 钳制为 9', quantizeCrackStage(-0.01) === 0 && quantizeCrackStage(1.5) === 9);
  ok(
    '阶段边界精确值（0.0999→0 / 0.1→1 / 0.9→9）',
    quantizeCrackStage(0.0999) === 0 && quantizeCrackStage(0.1) === 1 && quantizeCrackStage(0.9) === 9,
  );
  {
    let denseMono = true;
    let prevDense = -1;
    for (let i = 0; i <= 1000; i++) {
      const s = quantizeCrackStage(i / 1000);
      if (s < prevDense) denseMono = false;
      prevDense = s;
    }
    ok('0..1 密集采样严格单调不回退', denseMono);
  }

  const distinct = new Set();
  for (let i = 0; i <= 100; i++) distinct.add(quantizeCrackStage(i / 100));
  ok('10 个阶段都可达到（肉眼可区分）', distinct.size === 10, `distinct=${distinct.size}`);

  // 15fps + dt 钳制 0.25s / mineTime=1.6s：每帧约 +0.156，阶段不得回退
  let prev = -1;
  let backward = 0;
  let changes = 0;
  for (let frame = 0; frame < 120; frame++) {
    const progress = Math.min(1, (frame * (1 / 15)) / 1.6);
    const stage = quantizeCrackStage(progress);
    if (stage < prev) backward++;
    if (stage !== prev) changes++;
    prev = stage;
  }
  ok('低帧率下阶段单调不回退', backward === 0, `backward=${backward}`);
  ok('阶段切换次数有限（不逐帧抖动）', changes <= CRACK_STAGES, `changes=${changes}`);

  // 60fps 同样单调，且相同 progress 永远得到相同阶段（无随机抖动）
  let prev60 = -1;
  let monotonic60 = true;
  for (let frame = 0; frame < 400; frame++) {
    const stage = quantizeCrackStage(Math.min(1, frame / 240));
    if (stage < prev60) monotonic60 = false;
    prev60 = stage;
  }
  ok('60fps 阶段单调且无闪烁', monotonic60);
  const sampleA = quantizeCrackStage(0.55);
  const sampleB = quantizeCrackStage(0.55 + Number.EPSILON);
  ok('量化为纯函数（同输入同输出）', sampleA === quantizeCrackStage(0.55) && sampleA === sampleB && sampleA === 5);
}

log(`\nPASS 手感回归：${passed} 组断言全部通过`);
