/**
 * 录制 README 首屏 WebP 的实机素材（真实游戏画面，无合成）。
 *
 * 用法（Linux 无 GPU / CI）：
 *   npm run build
 *   xvfb-run -a -s "-screen 0 1280x760x24" \
 *     env MC_HEADLESS=0 MC_GL=desktop node scripts/capture-showcase.mjs
 *
 * 产物：test/artifacts/showcase/frame-000.png …（逐帧 PNG）
 * 再用 ffmpeg 合成 animated WebP（见 .github/workflows/showcase.yml）：
 *   ffmpeg -framerate 12 -i test/artifacts/showcase/frame-%03d.png \
 *     -vf "fps=10,scale=720:-1:flags=lanczos" \
 *     -c:v libwebp_anim -quality 25 -preset icon -loop 0 docs/assets/showcase.webp
 *
 * 脚本只依赖仓库已有的 puppeteer-core，不修改游戏源码；
 * 所有操作都通过 window.__mc 调试钩子与 CraftAPI 完成。
 *
 * 15 秒分镜（12fps / 180 帧，单机位，不切镜头）：
 *   0–2.5s   清晨全景横移：森林、花丛、海平线
 *   2.5–3.3s 视角下压到脚前地面
 *   3.3–5.8s 连续挖开 5 格地面（碎屑 + 坑洞 + 掉落进背包）
 *   5.8–7.7s 抬视角转向 TNT 空地，布置 2×2 TNT 与两支火把
 *   7.7s     点燃 TNT（1.6s 引信）
 *   9.3s     爆炸 → 连锁 → 弹坑 + 镜头震动（黄昏最红时）
 *   10–12.5s 入夜，火把照亮弹坑，星空浮现
 *   12.5–15s 视角抬向星空与月亮
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_UNDER_TEST = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ??
  '/usr/local/bin/chromium';
const OUT = path.join(ROOT, 'test', 'artifacts', 'showcase');
const WIDTH = Number(process.env.MC_SHOWCASE_WIDTH ?? 1280);
const HEIGHT = Number(process.env.MC_SHOWCASE_HEIGHT ?? 720);
const FPS = 12;
const FRAMES = Number(process.env.MC_SHOWCASE_FRAMES ?? FPS * 15);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_BASE = ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS =
  (process.env.MC_GL ?? 'swiftshader') === 'desktop'
    ? [...GL_BASE, '--use-gl=desktop']
    : [...GL_BASE, '--use-gl=angle', '--use-angle=swiftshader'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...GL_ARGS,
    '--allow-file-access-from-files',
    '--mute-audio',
    `--window-size=${WIDTH},${HEIGHT}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(`[showcase] pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.error(`[showcase] console: ${m.text().slice(0, 240)}`);
});

/** 等待区块网格收敛；录制前必须让画面稳定，否则镜头会拍到空洞。 */
const waitSettled = async (timeout = 60000) => {
  const deadline = Date.now() + timeout;
  let stable = 0;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      gen: window.__mc.world.chunks.size,
      mesh: window.__mc.chunks.meshCount,
      dirty: window.__mc.world.dirty.size,
    }));
    if (st.dirty === 0 && st.mesh >= st.gen - 1) {
      if (++stable >= 3) return st;
    } else {
      stable = 0;
    }
    await sleep(200);
  }
  return null;
};

try {
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.clear();
    } catch {
      /* file:// 隐私模式可能禁用存储 */
    }
    sessionStorage.setItem('mc-ts-new-seed', '2026');
    sessionStorage.setItem('mc-ts-new-mode', 'creative');
  });
  await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 60000 });
  await page.click('.mode-btn[data-mode="creative"]');
  await page.click('.title-buttons .mc-btn-big');
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });

  await page.evaluate(() => {
    const mc = window.__mc;
    mc.chunks.setRenderDistance(4);
    // 冻结自然昼夜，后面按帧精确驱动天空，避免录制时太阳自己跑掉
    mc.sky.dayLength = 1e6;
    mc.sky.dayTime = 0.3;
    // 出生点视角（与 test/visual-check.mjs 的取景一致：森林 + 花丛 + 海平线）
    mc.player.teleport(0.5, mc.world.surfaceHeight(0, 0) + 1.05, 0.5);
    mc.player.yaw = 0.75;
    mc.player.pitch = -0.06;
  });
  const settled = await waitSettled();
  if (!settled) console.warn('[showcase] 区块未完全收敛，继续录制');

  // ---- 场景编排：挖坑点 + TNT 空地（都在初始视野内，避免镜头二次寻路）----
  const stage = await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player;
    const yaw = 0.55;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const AIR = 0;

    // 挖坑：脚前 2.6~4.2 格的 2×2 地面，每格清掉上面的花草
    const dig = [];
    for (const [f, s] of [
      [2.9, -0.9],
      [2.9, 0.9],
      [4.0, -0.9],
      [4.0, 0.9],
      [3.45, 0],
    ]) {
      const x = Math.floor(p.pos.x + fx * f + rx * s);
      const z = Math.floor(p.pos.z + fz * f + rz * s);
      const y = mc.world.surfaceHeight(x, z);
      mc.world.setBlock(x, y + 1, z, AIR);
      dig.push([x, y, z]);
    }

    // TNT 空地：正前方 8 格，清出 5×3×5 的净空；火把稍后与 TNT 一起摆
    const cx = Math.floor(p.pos.x + fx * 8 + rx * 2);
    const cz = Math.floor(p.pos.z + fz * 8 + rz * 2);
    const ground = mc.world.surfaceHeight(cx, cz);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 1; dy <= 3; dy++) mc.world.setBlock(cx + dx, ground + dy, cz + dz, AIR);
      }
    }
    return { dig, pile: { x: cx, z: cz, y: ground + 1 }, torches: [] };
  });

  // 场景方块变更后等网格重排，避免录到旧网格
  await sleep(1500);

  const state = await page.evaluate(
    ({ stage }) => {
      const mc = window.__mc;
      const p = mc.player;
      const eye = { x: p.pos.x, y: p.pos.y + 1.62, z: p.pos.z };
      const pile = { x: stage.pile.x + 1, y: stage.pile.y + 0.6, z: stage.pile.z + 1 };
      const dx = pile.x - eye.x;
      const dz = pile.z - eye.z;
      const dist = Math.hypot(dx, dz);
      // 弹坑外 5.5 格各放一支火把（爆炸半径 3.4，不会被波及），入夜后照亮弹坑
      const rx = Math.cos(0.55);
      const rz = -Math.sin(0.55);
      const torches = [-5.5, 5.5].map((s) => {
        const tx = Math.floor(pile.x + rx * s);
        const tz = Math.floor(pile.z + rz * s);
        return [tx, mc.world.surfaceHeight(tx, tz) + 1, tz];
      });
      return {
        dig: stage.dig,
        pile: stage.pile,
        torches,
        eye,
        pileYaw: Math.atan2(-dx, -dz),
        pilePitch: Math.atan2(pile.y - eye.y, dist),
        digYaw: Math.atan2(-(stage.dig[4][0] + 0.5 - eye.x), -(stage.dig[4][2] + 0.5 - eye.z)),
        digPitch: Math.atan2(
          stage.dig[4][1] + 0.5 - eye.y,
          Math.hypot(stage.dig[4][0] + 0.5 - eye.x, stage.dig[4][2] + 0.5 - eye.z),
        ),
      };
    },
    { stage },
  );
  console.log('[showcase] 坐标', JSON.stringify(state));

  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (k) => k * k * (3 - 2 * k);

  /** 按帧给出机位与时间；所有过渡都是平滑曲线，避免 GIF 抖动。 */
  const frameState = (i) => {
    let yaw = 0.75;
    let pitch = -0.06;
    let day = 0.3;

    if (i < 30) {
      // 清晨横移：从右向左扫过海平线与树冠
      const k = smooth(clamp01(i / 29));
      yaw = lerp(0.8, 0.5, k);
      day = lerp(0.3, 0.33, k);
    } else if (i < 40) {
      // 下压到脚前地面
      const k = smooth(clamp01((i - 30) / 9));
      yaw = lerp(0.5, state.digYaw, k);
      pitch = lerp(-0.06, state.digPitch, k);
      day = 0.33;
    } else if (i < 70) {
      // 挖坑：轻微跟随碎屑抖动
      yaw = state.digYaw + 0.012 * Math.sin((i - 40) * 0.9);
      pitch = state.digPitch + 0.01 * Math.sin((i - 40) * 0.7);
      day = 0.33;
    } else if (i < 92) {
      // 抬视角转向 TNT 空地，午后转金色
      const k = smooth(clamp01((i - 70) / 21));
      yaw = lerp(state.digYaw, state.pileYaw, k);
      pitch = lerp(state.digPitch, state.pilePitch, k);
      day = lerp(0.33, 0.68, k);
    } else if (i < 120) {
      // 引信与爆炸：黄昏最红时炸开
      const k = clamp01((i - 92) / 27);
      yaw = state.pileYaw + 0.01 * Math.sin(k * Math.PI * 4);
      pitch = state.pilePitch - 0.02 * k;
      day = lerp(0.68, 0.755, k);
    } else if (i < 150) {
      // 入夜：火把点亮弹坑，镜头缓慢横移
      const k = smooth(clamp01((i - 120) / 29));
      yaw = state.pileYaw + lerp(0, 0.1, k);
      pitch = lerp(state.pilePitch, -0.3, k);
      day = lerp(0.755, 0.86, k);
    } else {
      // 抬向星空与月亮
      const k = smooth(clamp01((i - 150) / (FRAMES - 151)));
      yaw = state.pileYaw + lerp(0.1, 0.02, k);
      pitch = lerp(-0.3, 0.42, k);
      day = lerp(0.86, 0.93, k);
    }
    return { yaw, pitch, day: day % 1 };
  };

  const pile = state.pile;
  for (let i = 0; i < FRAMES; i++) {
    const cam = frameState(i);
    await page.evaluate(
      ({ cam, i, dig, pile, torches }) => {
        const mc = window.__mc;
        mc.sky.dayTime = cam.day;
        mc.player.yaw = cam.yaw;
        mc.player.pitch = cam.pitch;

        // 挖坑：5 格依次破坏（每 6 帧一块），带挥臂与碎屑
        if (i >= 42 && i < 70 && (i - 42) % 6 === 0) {
          const [wx, wy, wz] = dig[Math.min(dig.length - 1, (i - 42) / 6)];
          if (mc.world.getBlock(wx, wy, wz) !== 0) {
            mc.player.target = { x: wx, y: wy, z: wz, block: mc.world.getBlock(wx, wy, wz), dist: 3 };
            mc.player.breakBlock();
            mc.player.swing();
          }
        }

        // 第 84 帧：摆 2×2 TNT 与两支火把
        if (i === 84) {
          const tnt = mc.registry.byNameGet('tnt').id;
          for (const [dx, dz] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ]) {
            mc.world.setBlock(pile.x + dx, pile.y, pile.z + dz, tnt);
          }
          const torch = mc.registry.byNameGet('torch').id;
          for (const [tx, ty, tz] of torches) mc.world.setBlock(tx, ty, tz, torch);
        }
        // 第 94 帧点燃左下角那块，连锁引爆其余三块
        if (i === 94) mc.igniteTnt(pile.x, pile.y, pile.z);
      },
      { cam, i, dig: state.dig, pile, torches: state.torches },
    );

    const file = path.join(OUT, `frame-${String(i).padStart(3, '0')}.png`);
    await page.screenshot({ path: file, type: 'png' });
    if (i % 30 === 0) console.log(`[showcase] ${i}/${FRAMES}`);
  }

  console.log(`[showcase] 完成：${FRAMES} 帧 → ${OUT}`);
} finally {
  await browser.close();
}
