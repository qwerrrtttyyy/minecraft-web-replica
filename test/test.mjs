import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = `file://${path.join(ROOT, 'dist', 'index.html')}`;
const SHOTS = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/chromium';
const results = [];
const errors = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass, extra });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1280,800', '--mute-audio',
  ],
});

async function newPage(w, h, mobile = false) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桌面端 ----------
const page = await newPage(1280, 800);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__mc && window.__mc.mode === "title"', { timeout: 90000 });
await sleep(2500);
await page.screenshot({ path: `${SHOTS}/01-title.png` });
ok('标题屏启动', true);

const titleInfo = await page.evaluate(() => ({
  logo: !!document.querySelector('.mc-logo'),
  buttons: [...document.querySelectorAll('.title-buttons .mc-btn')].map((b) => b.textContent),
  canvasW: document.querySelector('canvas').clientWidth,
  chunks: window.__mc.chunks.meshCount,
}));
ok('标题屏元素', titleInfo.logo && titleInfo.buttons.length >= 1 && titleInfo.canvasW === 1280, JSON.stringify(titleInfo.buttons) + ` chunks=${titleInfo.chunks}`);

// 进入世界
await page.evaluate(() => {
  [...document.querySelectorAll('.title-buttons .mc-btn')].find((b) => b.textContent.includes('进入世界') || b.textContent.includes('继续游戏'))?.click();
});
await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });
await sleep(4000);
await page.screenshot({ path: `${SHOTS}/02-gameplay.png` });
const g1 = await page.evaluate(() => ({
  chunks: window.__mc.chunks.meshCount,
  pos: window.__mc.player.pos.toArray(),
  onGround: window.__mc.player.onGround,
  fps: window.__mc.engine.fps,
  hotbarImgs: [...document.querySelectorAll('.hotbar-slot img')].every((i) => i.naturalWidth > 0),
  entities: window.__mc.entities.entities.length,
}));
ok('进入游戏世界', g1.chunks > 20 && g1.hotbarImgs, `chunks=${g1.chunks} fps=${g1.fps} entities=${g1.entities} ground=${g1.onGround}`);

// 画面非纯色（真实渲染）
const pix = await page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = 64, h = 64;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(c.width / 2 - w / 2, c.height / 2 - h / 2, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const set = new Set();
    for (let i = 0; i < buf.length; i += 4) set.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
    resolve(set.size);
  });
}));
ok('画面真实渲染（像素多样性）', pix > 12, `distinct=${pix}`);

// 移动 + 跳跃
const move = await page.evaluate(() => ({ p0: window.__mc.player.pos.toArray() }));
await page.keyboard.down('w');
await sleep(3000);
await page.keyboard.up('w');
await page.keyboard.press('Space');
await sleep(700);
const move2 = await page.evaluate(() => ({ p1: window.__mc.player.pos.toArray(), ground: window.__mc.player.onGround }));
const dist = Math.hypot(move2.p1[0] - move.p0[0], move2.p1[2] - move.p0[2]);
ok('键盘移动', dist > 1, `dist=${dist.toFixed(2)}`);

// 破坏 / 放置
const interact = await page.evaluate(() => {
  const mc = window.__mc;
  const p = mc.player;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const tx = Math.floor(p.pos.x + fx * 3), tz = Math.floor(p.pos.z + fz * 3);
  const ty = Math.floor(p.pos.y + 1.62);
  const stone = mc.registry.byNameGet('stone').id;
  mc.world.setBlock(tx, ty, tz, stone);
  p.pitch = 0;
  p.update(0.016);
  const targeted = p.target && p.target.x === tx && p.target.z === tz;
  p.breakBlock();
  const broken = mc.world.getBlock(tx, ty, tz) === 0;
  p.pitch = -0.6;
  p.update(0.016);
  const editsBefore = mc.world.editCount;
  p.doPlace();
  const placed = mc.world.editCount > editsBefore;
  return { targeted, broken, placed };
});
ok('准星瞄准+破坏方块', interact.targeted && interact.broken, JSON.stringify(interact));
ok('放置方块', interact.placed);

// 方块库
await page.keyboard.press('e');
await sleep(400);
const palette = await page.evaluate(() => ({
  open: window.__mc.hud.paletteOpen,
  cells: document.querySelectorAll('.palette-cell').length,
}));
await page.screenshot({ path: `${SHOTS}/03-palette.png` });
ok('方块库（E）', palette.open && palette.cells >= 20, `cells=${palette.cells}`);
await page.keyboard.press('Escape');
await sleep(300);
ok('Esc 关闭方块库并回到游戏', await page.evaluate(() => window.__mc.mode === 'playing'));

// 第三人称 + 角色模型
await page.evaluate(() => { window.CraftAPI.player.setCamera(1); window.__mc.player.update(0.016); });
await sleep(800);
await page.screenshot({ path: `${SHOTS}/04-thirdperson.png` });
ok('第三人称角色实体', await page.evaluate(() => window.__mc.player.model.group.visible));
await page.evaluate(() => { window.CraftAPI.player.setCamera(0); });

// TNT 爆炸
const tnt = await page.evaluate(() => {
  const mc = window.__mc;
  const p = mc.player;
  const tx = Math.floor(p.pos.x) + 3, tz = Math.floor(p.pos.z) + 1;
  const ty = Math.floor(p.pos.y);
  mc.world.setBlock(tx, ty, tz, mc.registry.byNameGet('tnt').id);
  const before = mc.world.editCount;
  window.__exploded = null;
  window.CraftAPI.on('explosion', (e) => { window.__exploded = e; });
  mc.igniteTnt(tx, ty, tz);
  return { tx, ty, tz, before };
});
await page.waitForFunction('window.__exploded !== null', { timeout: 15000 });
await sleep(400);
const tnt2 = await page.evaluate(({ tx, ty, tz }) => {
  const mc = window.__mc;
  let air = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    if (mc.world.getBlock(tx + dx, ty + dy, tz + dz) === 0) air++;
  }
  return { gone: mc.world.getBlock(tx, ty, tz) === 0, air, edits: mc.world.editCount, mode: mc.mode, tntLeft: mc.world.getBlock(tx, ty, tz) };
}, tnt);
await page.screenshot({ path: `${SHOTS}/05-explosion.png` });
ok('TNT 点燃并爆炸', tnt2.gone && tnt2.edits > tnt.before + 10, `edits=${tnt2.edits} air=${tnt2.air}`);

// 黄昏与夜晚天空
await page.evaluate(() => window.CraftAPI.time.set(0.74));
await sleep(1200);
await page.screenshot({ path: `${SHOTS}/06-sunset.png` });
await page.evaluate(() => window.CraftAPI.time.set(0.95));
await sleep(1200);
await page.screenshot({ path: `${SHOTS}/07-night.png` });
const night = await page.evaluate(() => ({ daylight: window.__mc.sky.daylight, time: window.__mc.sky.timeString() }));
ok('昼夜循环', night.daylight < 0.1, JSON.stringify(night));
await page.evaluate(() => window.CraftAPI.time.set(0.35));

// 自定义方块 API
const apiBlock = await page.evaluate(() => {
  window.CraftAPI.registerTile('test_ruby', (set, rng) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, 0x808080 + ((rng() * 20) | 0));
    for (let i = 0; i < 8; i++) set(2 + ((rng() * 12) | 0), 2 + ((rng() * 12) | 0), 0xe0356a);
  });
  const def = window.CraftAPI.registerBlock({
    name: 'ruby_ore', label: '红宝石矿', shape: 'cube', solid: true, opaque: true, liquid: false,
    transparentPass: false, lightEmission: 0, hardness: 3, sound: 'stone',
    tiles: { top: 'test_ruby', bottom: 'test_ruby', side: 'test_ruby' },
  });
  const p = window.__mc.player.pos;
  window.CraftAPI.world.setBlock(Math.floor(p.x) + 2, Math.floor(p.y) + 1, Math.floor(p.z), def.id);
  return { id: def.id, read: window.CraftAPI.world.getBlock(Math.floor(p.x) + 2, Math.floor(p.y) + 1, Math.floor(p.z)) };
});
ok('扩展 API 注册新方块', apiBlock.id > 0 && apiBlock.read === apiBlock.id, JSON.stringify(apiBlock));

// 菜单 + 存档
await page.keyboard.press('Escape');
await sleep(500);
await page.screenshot({ path: `${SHOTS}/08-menu.png` });
ok('Esc 打开菜单', await page.evaluate(() => window.__mc.hud.menuOpen && window.__mc.mode === 'paused'));
const savedPos = await page.evaluate(() => window.__mc.player.pos.toArray());
await sleep(500);

// 重载续玩
await page.reload({ waitUntil: 'load' });
await page.waitForFunction('window.__mc && window.__mc.mode === "title"', { timeout: 90000 });
const contBtn = await page.evaluate(() => [...document.querySelectorAll('.title-buttons .mc-btn')].map((b) => b.textContent));
ok('存档后出现继续游戏', contBtn.some((t) => t.includes('继续游戏')), JSON.stringify(contBtn));
await page.evaluate(() => { [...document.querySelectorAll('.title-buttons .mc-btn')].find((b) => b.textContent.includes('继续游戏'))?.click(); });
await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });
await sleep(2500);
const cont = await page.evaluate((sp) => {
  const p = window.__mc.player.pos;
  return { near: Math.hypot(p.x - sp[0], p.z - sp[2]) < 3, ruby: window.CraftAPI.world.getBlock(Math.floor(sp[0]) + 2, Math.floor(sp[1]) + 1, Math.floor(sp[2])) > 0 };
}, savedPos);
ok('续玩位置与方块差分持久化', cont.near && cont.ruby, JSON.stringify(cont));
await page.screenshot({ path: `${SHOTS}/09-continue.png` });

// 视口缩放
await page.setViewport({ width: 900, height: 600 });
await sleep(800);
const resize = await page.evaluate(() => ({
  cw: document.querySelector('canvas').clientWidth,
  overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
}));
ok('桌面视口缩放', resize.cw === 900 && resize.overflow, JSON.stringify(resize));

// ---------- 移动端 ----------
const mob = await newPage(390, 844, true);
await mob.evaluateOnNewDocument(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
await mob.goto(URL, { waitUntil: 'load', timeout: 60000 });
await mob.waitForFunction('window.__mc && window.__mc.mode === "title"', { timeout: 90000 });
await sleep(1500);
await mob.screenshot({ path: `${SHOTS}/10-mobile-title.png` });
await mob.evaluate(() => { [...document.querySelectorAll('.title-buttons .mc-btn')][0]?.click(); });
await mob.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });
await sleep(3500);
await mob.screenshot({ path: `${SHOTS}/11-mobile-game.png` });
const mobInfo = await mob.evaluate(() => ({
  isMobile: window.__mc.engine.isMobile,
  touchVisible: document.querySelector('.touch-ui') && getComputedStyle(document.querySelector('.touch-ui')).display !== 'none',
  joy: !!document.querySelector('.joy-zone'),
  buttons: document.querySelectorAll('.tbtn').length,
  overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  hotbarW: document.querySelector('.hotbar').getBoundingClientRect().width,
  rd: window.__mc.chunks.renderDistance,
}));
ok('移动端触控 UI', mobInfo.isMobile && mobInfo.touchVisible && mobInfo.joy && mobInfo.buttons === 5, JSON.stringify(mobInfo));
ok('移动端无横向溢出', mobInfo.overflow && mobInfo.hotbarW <= 390, `hotbar=${mobInfo.hotbarW}`);

// 摇杆拖动 → 移动
const joyMove = await mob.evaluate(async () => {
  const mc = window.__mc;
  const p0 = mc.player.pos.clone();
  const zone = document.querySelector('.joy-zone');
  const r = zone.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const opts = (x, y, type) => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true });
  zone.dispatchEvent(opts(cx, cy, 'pointerdown'));
  zone.dispatchEvent(opts(cx, cy - 50, 'pointermove'));
  await new Promise((r2) => setTimeout(r2, 2000));
  zone.dispatchEvent(opts(cx, cy, 'pointerup'));
  const p1 = mc.player.pos;
  return Math.hypot(p1.x - p0.x, p1.z - p0.z);
});
ok('虚拟摇杆移动', joyMove > 1.0, `dist=${joyMove.toFixed(2)}`);

// 移动端破坏按钮
const mobBreak = await mob.evaluate(async () => {
  const mc = window.__mc;
  const p = mc.player;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const tx = Math.floor(p.pos.x + fx * 3), tz = Math.floor(p.pos.z + fz * 3);
  const ty = Math.floor(p.pos.y + 1.62);
  mc.world.setBlock(tx, ty, tz, mc.registry.byNameGet('stone').id);
  p.pitch = 0; p.update(0.016);
  const btn = document.querySelector('[data-role="break"]');
  btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 600));
  btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
  return mc.world.getBlock(tx, ty, tz) === 0;
});
ok('移动端破坏按钮', mobBreak);

await sleep(500);
const errCount = errors.length;
ok('无运行时错误', errCount === 0, errors.slice(0, 6).join(' | '));

await browser.close();
fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ results, errors }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { console.log('失败项:'); failed.forEach((f) => console.log(' -', f.name, f.extra)); }
if (errors.length) { console.log('错误日志:'); errors.slice(0, 12).forEach((e) => console.log(' -', e)); }
process.exit(failed.length ? 1 : 0);