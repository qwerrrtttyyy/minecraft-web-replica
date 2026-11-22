/**
 * 图形 / 视觉回归（无头 Chromium + 软件 WebGL）。
 *
 * 固定种子与时段，抓取昼 / 黄昏 / 夜 / 火光 / 方块展示截图，并对关键画面
 * 做像素级断言：夜间确实变暗、火光确实提亮、画面不是纯色。
 * 光照的数值正确性由 `test/light-check.cjs` 保证，这里只验证「渲染出来能看见」。
 *
 * 用法：node test/visual-check.mjs
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'artifacts');
const CHROME = process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome']
    .find((p) => fs.existsSync(p)) ?? '/usr/local/bin/chromium';
const URL_UNDER_TEST = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/** 与 survival-smoke.mjs 保持同一套渲染后端开关（CI 用 Xvfb + Mesa） */
const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_BASE = ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS = (process.env.MC_GL ?? 'swiftshader') === 'desktop'
  ? [...GL_BASE, '--use-gl=desktop']
  : [...GL_BASE, '--use-gl=angle', '--use-angle=swiftshader'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    ...GL_ARGS,
    '--allow-file-access-from-files', '--window-size=1280,760', '--mute-audio',
  ],
});

const sample = async (page, x, y, w, h) => page.evaluate(({ x, y, w, h }) => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    const colors = new Set();
    for (let i = 0; i < buf.length; i += 4) {
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      colors.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
    }
    const n = w * h;
    resolve({
      r: r / n, g: g / n, b: b / n,
      lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n,
      colors: colors.size,
    });
  });
}), { x, y, w, h });

/** 等世界网格收敛（新光照会额外标脏邻块，固定 sleep 容易采样过早） */
const waitSettled = async (page, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      dirty: window.__mc.world.dirty.size,
      mesh: window.__mc.chunks.meshCount,
      gen: window.__mc.world.chunks.size,
    }));
    if (st.dirty === 0 && st.mesh >= st.gen - 1) return st;
    await sleep(200);
  }
  return null;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 30000 });
  // 固定种子与模式：清掉存档后通过 sessionStorage 指定下一局
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.setItem('mc-ts-new-seed', '2026');
    sessionStorage.setItem('mc-ts-new-mode', 'creative');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 30000 });
  await page.click('.mode-btn[data-mode="creative"]');
  await page.click('.title-buttons .mc-btn-big');
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 60000 });
  await page.evaluate(() => {
    window.__mc.chunks.setRenderDistance(4);
    // 冻结昼夜，避免截图期间光照漂移
    window.__mc.sky.dayLength = 1000000;
  });
  await waitSettled(page);
  await sleep(800);

  // ---------- 昼 ----------
  await page.evaluate(() => {
    const mc = window.__mc;
    mc.sky.dayTime = 0.32;
    mc.player.yaw = 0.65;
    mc.player.pitch = -0.06;
  });
  await sleep(900);
  const day = await sample(page, 608, 300, 64, 64);
  await page.screenshot({ path: path.join(OUT, 'visual-day.png') });
  ok('白天画面非纯色', day.colors > 12, `distinct=${day.colors} lum=${day.lum.toFixed(1)}`);

  // ---------- 黄昏 ----------
  await page.evaluate(() => { window.__mc.sky.dayTime = 0.74; });
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'visual-sunset.png') });
  const duskSky = await page.evaluate(() => window.__mc.sky.visualState());
  ok('黄昏地平线大气放大生效', duskSky.sunScale > 1.2 && duskSky.moonScale > 1.1,
    `sun=${duskSky.sunScale.toFixed(2)} moon=${duskSky.moonScale.toFixed(2)}`);

  // ---------- 夜 ----------
  await page.evaluate(() => { window.__mc.sky.dayTime = 0.9; });
  await sleep(900);
  const night = await sample(page, 608, 300, 64, 64);
  await page.screenshot({ path: path.join(OUT, 'visual-night.png') });
  ok('夜间画面明显变暗', night.lum < day.lum * 0.72,
    `day=${day.lum.toFixed(1)} night=${night.lum.toFixed(1)}`);
  ok('夜间仍有可见细节', night.colors > 12, `distinct=${night.colors}`);
  const skyNight = await page.evaluate(() => window.__mc.sky.visualState());
  ok('月相为 8 相且相位有效', skyNight.moonPhases === 8 && skyNight.moonPhase >= 0 && skyNight.moonPhase < 8,
    `phases=${skyNight.moonPhases} current=${skyNight.moonPhase}`);
  ok('夜间双层星点各自可见', skyNight.starLayers === 2 &&
    skyNight.starOpacity.every((v) => v > 0.3 && v <= 0.95),
    `opacity=${skyNight.starOpacity.map((v) => v.toFixed(3)).join('/')}`);
  ok('雾区间有效且地平线过渡早于远裁剪',
    skyNight.fogNear > 0 && skyNight.fogNear < skyNight.fogFar,
    `fog=${skyNight.fogNear.toFixed(1)}..${skyNight.fogFar.toFixed(1)}`);

  // ---------- 火光 ----------
  const lightScene = await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const yaw = mc.player.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const cx = Math.floor(p.x + fx * 4), cz = Math.floor(p.z + fz * 4);
    const gy = mc.world.surfaceHeight(cx, cz);
    // 平整一小块地面，放火把与南瓜灯
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const x = cx + dx, z = cz + dz;
        const h = mc.world.surfaceHeight(x, z);
        mc.world.setBlock(x, h, z, mc.registry.byNameGet('stone').id);
      }
    }
    mc.world.setBlock(cx, gy + 1, cz, mc.registry.byNameGet('torch').id);
    mc.world.setBlock(cx + 2, gy + 1, cz, mc.registry.byNameGet('jack_o_lantern').id);
    mc.world.setBlock(cx - 2, gy + 1, cz, mc.registry.byNameGet('glowstone').id);
    // 面向灯火
    const ex = p.x, ey = p.y + 1.62, ez = p.z;
    const dx = cx + 0.5 - ex, dy = gy + 1 - ey, dz = cz + 0.5 - ez;
    mc.player.yaw = Math.atan2(-dx, -dz);
    mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return { cx, cz, gy };
  });
  await waitSettled(page);
  await sleep(900);
  const lit = await sample(page, 540, 280, 200, 160);
  const lightValues = await page.evaluate((s) => {
    const w = window.__mc.world;
    return {
      torch: w.getBlockLight(s.cx, s.gy + 1, s.cz),
      // 取 z 方向邻格：只受 torch(14) 直接影响，距 jack_o_lantern/glowstone 各 3 格(<=12)
      near: w.getBlockLight(s.cx, s.gy + 1, s.cz + 1),
    };
  }, lightScene);
  await page.screenshot({ path: path.join(OUT, 'visual-lights.png') });
  ok('火把自身方块光 14', lightValues.torch === 14, `got=${lightValues.torch}`);
  ok('火把向邻格发光', lightValues.near === 13, `got=${lightValues.near}`);
  // 移除三个光源，用同一块区域的亮度对比验证「方块光确实在照亮环境」
  await page.evaluate((s) => {
    const mc = window.__mc;
    mc.world.setBlock(s.cx, s.gy + 1, s.cz, 0);
    mc.world.setBlock(s.cx + 2, s.gy + 1, s.cz, 0);
    mc.world.setBlock(s.cx - 2, s.gy + 1, s.cz, 0);
  }, lightScene);
  await waitSettled(page);
  await sleep(900);
  const dark = await sample(page, 540, 280, 200, 160);
  const removed = await page.evaluate((s) => window.__mc.world.getBlockLight(s.cx, s.gy + 1, s.cz), lightScene);
  ok('移除火把后方块光归零', removed === 0, `got=${removed}`);
  ok('火光区域比无火光时更亮', lit.lum > dark.lum * 1.15,
    `lit=${lit.lum.toFixed(1)} dark=${dark.lum.toFixed(1)} @${lightScene.cx},${lightScene.cz}`);

  // ---------- 方块展示墙（悬空，避免树木/花朵干扰） ----------
  await page.evaluate(() => { window.__mc.sky.dayTime = 0.32; });
  await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const yaw = mc.player.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // 全部内置方块，按材质分组排布
    const names = ['grass', 'dirt', 'stone', 'cobblestone', 'stone_bricks', 'mossy_cobblestone', 'gravel', 'sand',
      'sandstone', 'ice', 'obsidian', 'bricks', 'oak_log', 'oak_planks', 'spruce_planks', 'birch_planks',
      'crafting_table', 'glass', 'glowstone', 'torch', 'jack_o_lantern', 'tnt', 'snow', 'coal_ore',
      'iron_ore', 'gold_ore', 'diamond_ore', 'white_wool', 'red_wool', 'blue_wool', 'yellow_wool', 'orange_wool',
      'green_wool', 'purple_wool', 'black_wool', 'oak_leaves', 'red_mushroom', 'brown_mushroom', 'dead_bush',
      'copper_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'clay', 'podzol', 'granite', 'cactus',
      'sugar_cane', 'fern', 'pumpkin', 'bookshelf', 'lavender', 'edelweiss', 'ghost_flower',
      'moonflower', 'duckweed', 'sea_anemone'];
    const baseY = Math.floor(p.y) + 16;
    const wallDist = 7;
    const cols = 8;
    const rows = Math.ceil(names.length / cols);
    for (let i = 0; i < names.length; i++) {
      const col = i % cols, row = (i / cols) | 0;
      const x = Math.floor(p.x + fx * wallDist + rx * (col - (cols - 1) / 2));
      const z = Math.floor(p.z + fz * wallDist + rz * (col - (cols - 1) / 2));
      mc.world.setBlock(x, baseY + row, z, mc.registry.byNameGet(names[i]).id);
    }
    // 飞到墙中心高度、正对墙面，背景只剩天空
    const centerY = baseY + rows / 2;
    mc.player.fly = true;
    mc.player.pos.y = centerY - 1.62;
    mc.player.vel.set(0, 0, 0);
    mc.player.pitch = 0;
  });
  await waitSettled(page);
  await sleep(900);
  const wall = await sample(page, 380, 170, 520, 400);
  await page.screenshot({ path: path.join(OUT, 'visual-blocks.png') });
  ok('方块展示墙颜色丰富', wall.colors > 60, `distinct=${wall.colors}`);

  // ---------- N1 横屏兜底 / N2 PE 触屏 / N5 提示安全区 ----------
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
  ok('N1 PWA 清单锁定横屏', manifest.orientation === 'landscape', `orientation=${manifest.orientation}`);
  const distHtml = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8');
  ok('N1 单文件产物包含旋转引导', distHtml.includes('rotate-gate'));

  const gateState = await page.evaluate(() => {
    const el = document.getElementById('rotate-gate');
    if (!el) return null;
    el.hidden = false;
    const shown = !el.hidden;
    el.querySelector('.rotate-gate-play')?.click();
    return { shown, dismissed: el.hidden, icon: !!el.querySelector('svg') };
  });
  ok('N1 旋转引导可显示且「仍要游玩」可关闭',
    !!gateState && gateState.shown && gateState.dismissed && gateState.icon,
    JSON.stringify(gateState));

  const pe = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'touch-ui';
    host.innerHTML = '<div class="joy-zone joy-zone--pe"><div class="joy-base joy-base--pe"><div class="joy-knob joy-knob--pe"></div></div></div>' +
      '<button class="tbtn tbtn--pe tbtn-jump" data-role="jump" data-icon="jump" aria-label="跳跃"></button>';
    document.body.appendChild(host);
    const btn = host.querySelector('.tbtn--pe');
    const base = host.querySelector('.joy-base--pe');
    const knob = host.querySelector('.joy-knob--pe');
    const bs = getComputedStyle(btn), bass = getComputedStyle(base), ks = getComputedStyle(knob);
    const rect = btn.getBoundingClientRect();
    const out = {
      radius: parseFloat(bs.borderRadius),
      width: rect.width, height: rect.height,
      baseRadius: parseFloat(bass.borderRadius),
      baseWidth: base.getBoundingClientRect().width,
      knobRadius: parseFloat(ks.borderRadius),
    };
    host.remove();
    return out;
  });
  ok('N2 动作为圆角方形且命中区 ≥44×44',
    pe.radius >= 6 && pe.width >= 44 && pe.height >= 44,
    `radius=${pe.radius}px ${pe.width}×${pe.height}`);
  ok('N2 摇杆为方形底盘 + 圆形拇指盘',
    pe.baseRadius >= 8 && pe.baseWidth >= 100 && pe.knobRadius >= 20,
    `base=${pe.baseRadius}px/${pe.baseWidth}px knob=${pe.knobRadius}px`);

  const noteLayout = await page.evaluate(() => {
    const note = document.querySelector('.save-note');
    const hotbar = document.querySelector('.hotbar');
    if (!note || !hotbar) return null;
    note.textContent = '已自动保存于 20:59';
    note.classList.add('show');
    const a = note.getBoundingClientRect();
    const b = hotbar.getBoundingClientRect();
    return {
      gap: b.top - a.bottom,
      height: a.height,
      overflow: note.scrollWidth > note.clientWidth + 1,
    };
  });
  ok('N5 保存提示与快捷栏垂直间距 ≥8px', !!noteLayout && noteLayout.gap >= 8,
    `gap=${noteLayout ? noteLayout.gap.toFixed(1) : 'n/a'}px`);
  ok('N5 长提示不换行溢出', !!noteLayout && !noteLayout.overflow && noteLayout.height < 24,
    `height=${noteLayout ? noteLayout.height.toFixed(1) : 'n/a'}px`);

  const miningStyle = await page.evaluate(() => {
    const bar = document.querySelector('.mining-bar');
    if (!bar) return null;
    const s = getComputedStyle(bar);
    return { width: parseFloat(s.width), opacity: parseFloat(s.opacity) };
  });
  ok('N3 绿条已弱化为辅助反馈', !!miningStyle && miningStyle.width <= 96 && miningStyle.opacity <= 0.6,
    JSON.stringify(miningStyle));

  ok('图形测试无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
} catch (e) {
  ok('图形测试脚本未崩溃', false, e.message);
} finally {
  await browser.close();
}

const failures = results.filter((r) => !r.pass).length;
fs.writeFileSync(path.join(OUT, 'visual-results.json'), JSON.stringify({ results, failures, errors }, null, 2));
console.log(`\n图形测试：${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
