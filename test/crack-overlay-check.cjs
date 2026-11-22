/**
 * N3 裂痕覆盖层生命周期回归（jsdom + 现场转译 crackOverlay.ts，无 WebGL）。
 *
 * 运行：node test/crack-overlay-check.cjs
 *
 * feel-check.cjs 只验证量化纯函数，未覆盖 CrackOverlay 的显示/清除/换目标行为。
 * 这里用假 canvas 构造真实 CrackOverlay，验证：
 * 阶段变化才换 UV（不逐帧重绘）、切目标当帧移动、目标丢失/stage=0 立即清除。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

const SRC = path.resolve(__dirname, '..', 'src', 'gfx', 'crackOverlay.ts');
const TYPES = require.resolve('./terrain-logic/core/types.js');
let compiled = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
// core/types 的运行时实现取测试快照（纯逻辑）；three 仍从项目 node_modules 解析
compiled = compiled.replace(/require\(["']\.\.\/core\/types["']\)/g, `require(${JSON.stringify(TYPES)})`);
const mod = new Module(SRC, module);
mod.filename = SRC;
mod.paths = Module._nodeModulePaths(path.dirname(SRC));
mod._compile(compiled, SRC);
const { CrackOverlay } = mod.exports;
const THREE = require('three');

const dom = new JSDOM('<body></body>', { url: 'https://example.com/' });
global.window = dom.window;
global.document = dom.window.document;
const realCreate = dom.window.document.createElement.bind(dom.window.document);
dom.window.document.createElement = (tag) => {
  if (tag !== 'canvas') return realCreate(tag);
  const ctx = {
    clearRect() {}, save() {}, restore() {}, translate() {},
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
  };
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
};

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};
const uvArray = (mesh) => Array.from(mesh.geometry.getAttribute('uv').array);

console.log('N3 裂痕覆盖层生命周期回归');
{
  const scene = new THREE.Scene();
  const overlay = new CrackOverlay(scene);
  const mesh = scene.children[0];
  ok('构造后覆盖层默认隐藏', !!mesh && mesh.visible === false);

  overlay.set({ x: 1, y: 2, z: 3 }, 5);
  ok('有目标且阶段>0时显示', mesh.visible === true);
  ok('覆盖层居中于目标方块',
    mesh.position.x === 1.5 && mesh.position.y === 2.5 && mesh.position.z === 3.5,
    `${mesh.position.x},${mesh.position.y},${mesh.position.z}`);

  const uv5 = uvArray(mesh);
  overlay.set({ x: 1, y: 2, z: 3 }, 5);
  ok('同目标同阶段不重绘 UV（无逐帧抖动）',
    JSON.stringify(uvArray(mesh)) === JSON.stringify(uv5));

  overlay.set({ x: 4, y: 5, z: 6 }, 5);
  ok('切目标当帧移动到新方块且保持当前阶段',
    mesh.position.x === 4.5 && mesh.position.y === 5.5 && mesh.position.z === 6.5 &&
    JSON.stringify(uvArray(mesh)) === JSON.stringify(uv5));

  overlay.set({ x: 4, y: 5, z: 6 }, 8);
  ok('阶段变化时才切换 UV', JSON.stringify(uvArray(mesh)) !== JSON.stringify(uv5));

  overlay.set(null, 0);
  ok('目标丢失当帧清除覆盖层', mesh.visible === false);

  overlay.set({ x: 1, y: 2, z: 3 }, 0);
  ok('stage=0（无裂纹）不显示', mesh.visible === false);

  overlay.set({ x: 1, y: 2, z: 3 }, 9);
  ok('满阶段9可正常显示', mesh.visible === true);
  overlay.dispose();
  ok('dispose 后从场景移除', scene.children.length === 0);
}

console.log(`\nPASS N3 覆盖层生命周期：${passed} 组断言全部通过`);
