import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/chromium';
const URL = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--allow-file-access-from-files', '--window-size=1280,760', '--mute-audio',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction('window.__mc !== undefined', { timeout: 30000 });
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
  window.__mc.sky.dayLength = 1000000;
  window.__mc.sky.dayTime = 0.32;
});

// wait for initial convergence
const deadline = Date.now() + 30000;
let last = null;
while (Date.now() < deadline) {
  const st = await page.evaluate(() => ({
    dirty: window.__mc.world.dirty.size,
    mesh: window.__mc.chunks.meshCount,
    gen: window.__mc.world.chunks.size,
  }));
  if (st.dirty === 0 && st.mesh >= st.gen - 1) {
    if (!last || (last.dirty === st.dirty && last.mesh === st.mesh)) break;
    last = st;
  } else {
    last = st;
  }
  await sleep(200);
}

// FPS without movement
const fps = await page.evaluate(async () => {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let n = 0;
    function tick() {
      n++;
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      else resolve(Math.round(n * 1000 / (performance.now() - t0)));
    }
    requestAnimationFrame(tick);
  });
});

// Movement: hold W for 1s and measure distance + frame pacing
const move = await page.evaluate(async () => {
  const mc = window.__mc;
  const p = mc.player;
  const x0 = p.pos.x, z0 = p.pos.z;
  const t0 = performance.now();
  const frames = [];

  const kd = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' });
  document.dispatchEvent(kd);

  // sample position every frame for 1 second
  await new Promise((resolve) => {
    let lastT = performance.now();
    function sample() {
      const t = performance.now();
      frames.push(t - lastT);
      lastT = t;
      if (t - t0 < 1000) requestAnimationFrame(sample);
      else resolve();
    }
    requestAnimationFrame(sample);
  });

  const ku = new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' });
  document.dispatchEvent(ku);

  const t1 = performance.now();
  frames.sort((a, b) => a - b);
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
  return {
    dist: Math.hypot(p.pos.x - x0, p.pos.z - z0),
    ms: t1 - t0,
    p95FrameMs: p95,
  };
});

// Building 20 blocks at once
const build = await page.evaluate(async () => {
  const mc = window.__mc;
  const p = mc.player;
  const id = mc.registry.byNameGet('stone').id;
  const x = Math.floor(p.pos.x) + 3;
  const z = Math.floor(p.pos.z) - 3;
  const y = mc.world.surfaceHeight(x, z) + 1;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) mc.world.setBlock(x + i, y, z, id);
  const t1 = performance.now();
  return {
    ms: t1 - t0,
    dirty: mc.world.dirty.size,
  };
});

// Chunk loading cost: teleport far and measure convergence
const load = await page.evaluate(async () => {
  const mc = window.__mc;
  const p = mc.player;
  p.pos.set(p.pos.x + 320, p.pos.y, p.pos.z + 320);
  p.vel.set(0, 0, 0);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const check = () => {
      const st = {
        dirty: mc.world.dirty.size,
        mesh: mc.chunks.meshCount,
        gen: mc.world.chunks.size,
      };
      if (st.dirty === 0 && st.mesh >= st.gen - 1) {
        resolve({ ms: performance.now() - t0, ...st });
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
});

console.log(JSON.stringify({ fps, move, build, load }, null, 2));
await browser.close();
