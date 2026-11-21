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

log(`\nPASS 手感回归：${passed} 组断言全部通过`);
