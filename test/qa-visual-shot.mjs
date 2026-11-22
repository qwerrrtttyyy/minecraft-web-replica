/**
 * QA 验收截图：画面优化第一批的可截图项（E13 各向异性 / E14 水面波纹 / E16 边界光）。
 * 破坏裂纹已由远程 main 的独立 CrackOverlay 实现（test/crack-overlay-check.cjs 覆盖），
 * 我方重复的 highlight 裂纹实现随变基去重移除，本脚本不再重复截图。
 *
 * 这不是回归门禁，是 T7「截图人工确认」辅助脚本，不挂 verify。
 * experiment-3d.mjs 的 E13/E14/E16 arm 只产出像素签名、没有截图，故由本脚本补实景截图。
 * 钉场景沿用 experiment-3d.mjs 的受控做法（最小系统组 + 收敛 + 冻结成对）。
 *
 * 用法（Linux 无 GPU）：
 *   xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop node test/qa-visual-shot.mjs
 *
 * 产物（test/artifacts/，不入库）：
 *   qa-water-off.png / qa-water-on.png  水面波纹 关闭 / 开启
 *   qa-aniso-off.png / qa-aniso-on.png  各向异性 关闭 / 开启（远景斜视）
 *   qa-boundary-off.png / qa-boundary-on.png  边界光 关闭 / 开启
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const BASE_URL = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ??
  '/usr/local/bin/chromium';

const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_BASE = ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS =
  (process.env.MC_GL ?? 'swiftshader') === 'desktop'
    ? [...GL_BASE, '--use-gl=desktop']
    : [...GL_BASE, '--use-gl=angle', '--use-angle=swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...GL_ARGS,
    '--allow-file-access-from-files',
    '--window-size=1280,760',
    '--mute-audio',
  ],
});

const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE_URL, { waitUntil: 'load' });
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
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(() => window.__mc.player.onGround)) break;
    await sleep(200);
  }

  // 最小系统组 + 钉场景
  await page.evaluate(() => {
    const mc = window.__mc;
    mc.sky.dayLength = 1e6;
    mc.sky.dayTime = 0.32;
    mc.sky.update(0, 0);
    mc.chunks.lightUniform.value = 0.16 + 0.84 * mc.sky.daylight;
    mc.chunks.sunTint.value.copy(mc.sky.sunTint);
    mc.chunks.waterTime.value = 0;
    mc.chunks.setRenderDistance(3);
    mc.engine.systems = [
      {
        name: 'chunks',
        update: (dt) => {
          mc.chunks.setCenter(mc.player.pos.x, mc.player.pos.z);
          mc.chunks.update(dt);
        },
      },
    ];
  });

  const sceneState = () =>
    page.evaluate(() => ({
      dirty: window.__mc.world.dirty.size,
      inFlight: window.__mc.chunks.inFlightCount,
      mesh: window.__mc.chunks.meshCount,
    }));
  const waitSceneFixed = async () => {
    let last = null;
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const st = await sceneState();
      const frozen =
        st.mesh === last?.mesh && st.dirty === last?.dirty && st.inFlight === last?.inFlight &&
        st.dirty === 0 && st.inFlight === 0;
      if (frozen) {
        if (++same >= 4) return st;
      } else same = 0;
      last = st;
      await sleep(600);
    }
    return null;
  };
  const setFrozen = (frozen) =>
    page.evaluate((frozen) => {
      const mc = window.__mc;
      if (frozen) {
        if (!window.__qaVSysBackup) window.__qaVSysBackup = mc.engine.systems.slice();
        mc.engine.systems = [];
        mc.chunks.waterTime.value = 0;
        mc.sky.localTime = 0;
        mc.sky.update(0, 0);
        mc.chunks.lightUniform.value = 0.16 + 0.84 * mc.sky.daylight;
        mc.chunks.sunTint.value.copy(mc.sky.sunTint);
      } else if (window.__qaVSysBackup) {
        mc.engine.systems = window.__qaVSysBackup;
      }
    }, frozen);
  const lookAt = (px, py, pz, tx, tz, pitch) =>
    page.evaluate(
      ({ px, py, pz, tx, tz, pitch }) => {
        const mc = window.__mc;
        const p = mc.player;
        p.pos.set(px, py, pz);
        p.vel.set(0, 0, 0);
        p.yaw = Math.atan2(-(tx - px), -(tz - pz));
        p.pitch = pitch;
        const cam = mc.engine.camera;
        cam.position.set(px, py + 1.62, pz);
        cam.rotation.order = 'YXZ';
        cam.rotation.set(p.pitch, p.yaw, 0);
        mc.chunks.setCenter(px, pz);
      },
      { px, py, pz, tx, tz, pitch },
    );
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  // 注：E15 破坏裂纹截图段已移除 —— 远程 main 的独立 CrackOverlay 是唯一裂纹实现，
  // 我方 highlight 裂纹实现随变基去重删除，裂纹生命周期回归见 test/crack-overlay-check.cjs。

  // ================= E14 水面波纹：造浅水面，翻幅度 =================
  await setFrozen(false);
  const waterSetup = await page.evaluate(() => {
    const mc = window.__mc;
    const cx = 8, cz = 8;
    const y = mc.world.surfaceHeight(cx, cz);
    const water = mc.registry.byNameGet('water').id;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -9; dz <= -2; dz++) {
        mc.world.setBlock(cx + dx, y, cz + dz, water);
        for (let dy = 1; dy <= 6; dy++) mc.world.setBlock(cx + dx, y + dy, cz + dz, 0);
      }
    }
    return { cx, cz, y };
  });
  const stWater = await waitSceneFixed();
  console.log('水面场景收敛：', JSON.stringify(stWater));
  await lookAt(waterSetup.cx, waterSetup.y + 1.02, waterSetup.cz + 2,
    waterSetup.cx, waterSetup.cz - 5, -0.20);
  await setFrozen(true);
  for (const [name, amp] of [['qa-water-off.png', 0], ['qa-water-on.png', 0.01]]) {
    await page.evaluate((amp) => window.__mc.chunks.setWaterRipple(amp), amp);
    await sleep(400);
    await shot(name);
  }

  // ================= E13 各向异性：远景斜视翻 1 / 8 =================
  await setFrozen(false);
  // 回到出生点开阔视角，斜视远处地面以体现过滤差异
  await lookAt(8, (await page.evaluate(() => window.__mc.world.surfaceHeight(8, 8))) + 1.02, 24,
    8, -20, -0.10);
  await waitSceneFixed();
  await setFrozen(true);
  for (const [name, lvl] of [['qa-aniso-off.png', 1], ['qa-aniso-on.png', 8]]) {
    await page.evaluate((lvl) => window.__mc.atlas.setAnisotropy(lvl), lvl);
    await sleep(400);
    await shot(name);
  }
  const anisoState = await page.evaluate(() => ({
    anisotropy: window.__mc.atlas.anisotropyValue,
    mipmap: window.__mc.atlas.mipmapEnabled,
  }));
  console.log('各向异性开启档读数：', JSON.stringify(anisoState));
  await page.evaluate(() => window.__mc.atlas.setAnisotropy(1));

  // ================= E16 边界光：区块边界视角翻 false / true =================
  await setFrozen(false);
  // 站在 x=16 区块边界附近俯视接缝
  await lookAt(15, (await page.evaluate(() => window.__mc.world.surfaceHeight(15, 8))) + 1.02, 12,
    17, 8, -0.35);
  await waitSceneFixed();
  await setFrozen(true);
  for (const [name, on] of [['qa-boundary-off.png', false], ['qa-boundary-on.png', true]]) {
    await setFrozen(false);
    await page.evaluate((on) => window.__mc.chunks.setBoundaryLightFix(on), on);
    const st = await waitSceneFixed();
    await setFrozen(true);
    await sleep(400);
    await shot(name);
    console.log(`边界光 ${on ? 'on' : 'off'} 收敛：`, JSON.stringify(st));
  }

  const diag = await page.evaluate(() => window.CraftAPI.diagnostics.run());
  if (diag.errors) errors.push(`诊断发现 ${diag.errors} 个 error`);
  if (errors.length) console.log('页面错误：', errors.join(' | '));
  await page.close();
} finally {
  await browser.close();
}
console.log('QA 画面截图完成');
