/**
 * QA 验收截图：四种新植物（id 165-168）同视角展示 + 风摆差异化确认。
 *
 * 这不是回归门禁，是 T7 验收三件套的「截图人工确认」辅助脚本，不挂 verify。
 * 四种植物自然生成权重仅 0.002~0.01，整页场景里几乎不可见，必须主动摆放才能人工确认。
 *
 * 钉场景沿用 experiment-3d.mjs 的受控做法：换最小系统组停掉 botany / 物理 / 粒子 / 天空，
 * 等区块收敛后再摆放并截图，否则随机刻持续标脏会让网格停在旧状态（植物不出现）。
 *
 * 用法（Linux 无 GPU）：
 *   xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop node test/qa-plants-shot.mjs
 *
 * 产物（test/artifacts/，不入库）：
 *   qa-plants-before.png  改动前：同展示台空地（无扩展植物）
 *   qa-plants-after.png   改动后：同展示台摆满四种新植物
 *   qa-plant-165.png ~ qa-plant-168.png  逐种近景特写
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

  // 等玩家落地
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(() => window.__mc.player.onGround)) break;
    await sleep(200);
  }

  // 换最小系统组：只留 chunks，停掉 botany / 物理 / 粒子 / 天空，世界不再被随机刻改写。
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

  // 搭展示台：把一块平地清空，摆出四种新植物；返回相机钉点与植物坐标。
  const setup = await page.evaluate(() => {
    const mc = window.__mc;
    const names = ['climbing_vine', 'parasite_bloom', 'windseed_grass', 'sundial_flower'];
    const ids = names.map((n) => mc.registry.byNameGet(n)?.id ?? 0);
    const grass = mc.registry.byNameGet('grass_block')?.id ?? 1;

    const cx = 8;
    const cz = 8;
    const y = mc.world.surfaceHeight(cx, cz);
    for (let dx = -6; dx <= 18; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        mc.world.setBlock(cx + dx, y, cz + dz, grass);
        for (let dy = 1; dy <= 12; dy++) mc.world.setBlock(cx + dx, y + dy, cz + dz, 0);
      }
    }
    // 四种植物并排，间距 5 格，位于展台中轴
    const plants = ids.map((id, i) => ({ id, x: cx + i * 5, y: y + 1, z: cz, name: names[i] }));
    return { cx, cz, y, ids, plants, grass };
  });
  console.log('展台：', JSON.stringify(setup));
  if (setup.ids.some((id) => !id)) errors.push('有植物未注册：' + JSON.stringify(setup.ids));

  const sceneState = () =>
    page.evaluate(() => {
      const mc = window.__mc;
      let verts = 0;
      for (const mm of mc.chunks.meshes.values()) {
        for (const ch of ['opaque', 'emissive', 'transparent', 'water']) {
          if (mm[ch]) verts += mm[ch].geometry.attributes.position.count;
        }
      }
      return {
        dirty: mc.world.dirty.size,
        inFlight: mc.chunks.inFlightCount,
        mesh: mc.chunks.meshCount,
        verts,
      };
    });
  // 连续 4 次（间隔 600ms）几何量不变且队列清空，才算收敛——只等 dirty=0 会漏掉在途网格任务。
  const waitSceneFixed = async () => {
    let last = null;
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const st = await sceneState();
      const frozen =
        st.verts === last?.verts &&
        st.mesh === last?.mesh &&
        st.dirty === last?.dirty &&
        st.inFlight === last?.inFlight &&
        st.dirty === 0 &&
        st.inFlight === 0;
      if (frozen) {
        if (++same >= 4) return st;
      } else {
        same = 0;
      }
      last = st;
      await sleep(600);
    }
    return null;
  };
  // 冻结/解冻成对使用：摆方块后必须解冻让 chunks system 处理 dirty，
  // 截图瞬间才冻结；否则网格永远停在旧状态，新植物不出现。
  const setFrozen = (frozen) =>
    page.evaluate((frozen) => {
      const mc = window.__mc;
      if (frozen) {
        if (!window.__qaSysBackup) window.__qaSysBackup = mc.engine.systems.slice();
        mc.engine.systems = [];
        mc.chunks.waterTime.value = 0;
        mc.sky.localTime = 0;
        mc.sky.update(0, 0);
        mc.chunks.lightUniform.value = 0.16 + 0.84 * mc.sky.daylight;
        mc.chunks.sunTint.value.copy(mc.sky.sunTint);
      } else if (window.__qaSysBackup) {
        mc.engine.systems = window.__qaSysBackup;
      }
    }, frozen);
  const lookAt = (px, py, pz, tx, tz, pitch) =>
    page.evaluate(
      ({ px, py, pz, tx, tz, pitch }) => {
        const mc = window.__mc;
        const p = mc.player;
        p.pos.set(px, py, pz);
        p.vel.set(0, 0, 0);
        const dx = tx - px;
        const dz = tz - pz;
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = pitch;
        const cam = mc.engine.camera;
        cam.position.set(px, py + 1.62, pz);
        cam.rotation.order = 'YXZ';
        cam.rotation.set(p.pitch, p.yaw, 0);
        mc.chunks.setCenter(px, pz);
      },
      { px, py, pz, tx, tz, pitch },
    );

  // ---- 改动前：同展台空地（不摆扩展植物），钉同一相机 ----
  await lookAt(setup.cx + 7.5, setup.y + 1.02, setup.cz + 4, setup.cx + 7.5, setup.cz, -0.30);
  const stBefore = await waitSceneFixed();
  await setFrozen(true);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'qa-plants-before.png') });
  await setFrozen(false);

  // ---- 改动后：解冻 → 摆上四种植物 → 等网格重建 → 冻结截图 ----
  const placedIds = await page.evaluate((plants) => {
    const mc = window.__mc;
    for (const p of plants) mc.world.setBlock(p.x, p.y, p.z, p.id);
    return plants.map((p) => mc.world.getBlock(p.x, p.y, p.z));
  }, setup.plants);
  console.log('摆放后方块读数：', JSON.stringify(placedIds));
  const stAfter = await waitSceneFixed();
  await setFrozen(true);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'qa-plants-after.png') });
  console.log('收敛状态：before=', JSON.stringify(stBefore), ' after=', JSON.stringify(stAfter));

  // ---- 逐种近景特写：相机贴近每种植物，确认逐像素纹理与风摆高度差 ----
  for (const p of setup.plants) {
    await setFrozen(false);
    await lookAt(p.x, setup.y + 1.02, p.z + 2.6, p.x, p.z, -0.30);
    await sleep(300);
    await setFrozen(true);
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `qa-plant-${p.id}.png`) });
  }

  const diag = await page.evaluate(() => window.CraftAPI.diagnostics.run());
  if (diag.errors) errors.push(`诊断发现 ${diag.errors} 个 error`);
  if (errors.length) console.log('页面错误：', errors.join(' | '));
  await page.close();
} finally {
  await browser.close();
}
console.log('QA 截图完成');
