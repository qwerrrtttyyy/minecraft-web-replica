/**
 * N1 旋转引导分支回归（jsdom + 现场转译 orientationGate.ts）。
 *
 * 运行：node test/orientation-gate-check.cjs
 *
 * visual-check.mjs 只把 el.hidden 强行置 false 再点按钮，并未真正走
 * createOrientationGate 的分支判定，因此即使竖屏/桌面/standalone 判定全错也会通过。
 * 本测试直接实例化真实逻辑，覆盖三种门禁分支、iOS standalone 兼容、
 * 「仍要游玩」一次性关闭与方向变化实时刷新。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

const SRC = path.resolve(__dirname, '..', 'src', 'ui', 'orientationGate.ts');
const compiled = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = new Module(SRC, module);
mod.filename = SRC;
mod.paths = Module._nodeModulePaths(path.dirname(SRC));
mod._compile(compiled, SRC);
const { createOrientationGate } = mod.exports;

const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.com/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
try {
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
} catch { /* Node 版本差异：某些版本 navigator 为只读内建 */ }

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

/**
 * 用「稳定 mql 对象 + 可变状态」模拟真实 matchMedia：
 * gate 内部持有首次 matchMedia 返回的 mql 引用，若每次替换函数会导致 refresh 读到旧值。
 */
const env = { portrait: false, coarse: false, standalone: false, ios: false };
const mqls = ['(orientation: portrait)', '(pointer: coarse)', '(display-mode: standalone)'].map((media) => ({
  media,
  get matches() {
    if (media.includes('orientation: portrait')) return env.portrait;
    if (media.includes('pointer: coarse')) return env.coarse;
    if (media.includes('display-mode: standalone')) return env.standalone;
    return false;
  },
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
}));
dom.window.matchMedia = (q) => mqls.find((m) => m.media === q) ?? {
  media: q, matches: false,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
};

function setEnv(next) {
  Object.assign(env, { standalone: false, ios: false }, next);
  if (env.ios) Object.defineProperty(dom.window.navigator, 'standalone', { value: true, configurable: true });
  else delete dom.window.navigator.standalone;
}

const mount = () => createOrientationGate(document.getElementById('root'));

console.log('N1 旋转引导分支回归');

{
  setEnv({ portrait: true, coarse: true, standalone: false });
  const g = mount();
  ok('竖屏 + 粗指针 + 普通标签页：显示旋转引导', g.el.hidden === false);
  ok('遮罩含旋转图标与「仍要游玩」按钮',
    !!g.el.querySelector('svg.rotate-gate-icon') && !!g.el.querySelector('.rotate-gate-play'));
  g.el.querySelector('.rotate-gate-play').dispatchEvent(new dom.window.MouseEvent('click'));
  ok('点击「仍要游玩」进入游戏（遮罩关闭）', g.dismissed === true && g.el.hidden === true);
  g.el.hidden = false;
  g.refresh();
  ok('dismissed 后 refresh 不再复活', g.el.hidden === true);
  g.el.remove();
}
{
  setEnv({ portrait: false, coarse: true });
  const g = mount();
  ok('横屏粗指针：不显示引导', g.el.hidden === true);
  g.el.remove();
}
{
  setEnv({ portrait: true, coarse: false });
  const g = mount();
  ok('桌面细指针（即便视口竖）：不误伤桌面', g.el.hidden === true);
  g.el.remove();
}
{
  setEnv({ portrait: true, coarse: true, standalone: true });
  const g = mount();
  ok('PWA standalone：不显示引导（manifest 已锁横屏）', g.el.hidden === true);
  g.el.remove();
}
{
  setEnv({ portrait: true, coarse: true, ios: true });
  const g = mount();
  ok('iOS navigator.standalone：不显示引导', g.el.hidden === true);
  g.el.remove();
}
{
  setEnv({ portrait: true, coarse: true });
  const g = mount();
  ok('初始竖屏显示', g.el.hidden === false);
  setEnv({ portrait: false, coarse: true });
  g.refresh();
  ok('转横屏后引导消失', g.el.hidden === true);
  setEnv({ portrait: true, coarse: true });
  g.refresh();
  ok('未 dismiss 时转回竖屏引导重现', g.el.hidden === false);
  g.el.remove();
}

console.log(`\nPASS N1 旋转引导分支：${passed} 组断言全部通过`);
