/**
 * E16 受控实验：8 位打包顶点光照 vs float2 对照。
 *
 * 硬规则（docs/EXPERIMENTS.md §1.1）：顶点布局属于「看不出好不好」的渲染改动，
 * 必须在**同一页**内翻转变量，并单独测噪声底；测量工具不挂 verify。
 *
 * 翻转方式：window.__mc.chunks.setPackedLighting(v)（已有运行时钩子）。
 *   A  packed8  默认布局（1 B/顶点光照）
 *   B  float2   对照布局（8 B/顶点光照）
 *   A' packed8  翻回默认 —— 用来测同页噪声底，而不是把跨页差异误当成改动效果
 *
 * 判据：A 与 B 的采样像素差应落在 A 与 A' 的噪声底范围内；
 *       vertexLightBytes 必须精确为 1 / 8 / 1。
 * 用法：npm run build && npm run test:experiment-light
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'artifacts');
const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ??
  '/usr/local/bin/chromium';
const BASE_URL = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_BASE = ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS =
  (process.env.MC_GL ?? 'swiftshader') === 'desktop'
    ? [...GL_BASE, '--use-gl=desktop']
    : [...GL_BASE, '--use-gl=angle', '--use-angle=swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
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

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(BASE_URL, { waitUntil: 'load' });
await page.evaluate(() => window.__mc.startGame());

// 等场景静止：玩家落地 + 已有网格，再留 2s 让在途 Worker 网格落地
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const ready = await page.evaluate(() => window.__mc.player.onGround && window.__mc.chunks.meshCount > 0);
  if (ready) break;
  await sleep(250);
}
await sleep(2000);

/** 采样同一块画布的像素与当前布局字节数；避免编码 PNG 后的元数据噪声 */
const sample = () =>
  page.evaluate(() => {
    const src = window.__mc.engine.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const px = [];
    // 固定步长采样：同一页同一缓冲区，步长固定即可逐点比较
    for (let i = 0; i < data.length; i += 64) {
      px.push(data[i], data[i + 1], data[i + 2]);
    }
    return {
      mode: window.__mc.chunks.lightingMode,
      bytes: window.__mc.chunks.vertexLightBytes,
      pixels: px,
      meshes: window.__mc.chunks.meshCount,
    };
  });

const flip = async (packed) => {
  await page.evaluate((v) => window.__mc.chunks.setPackedLighting(v), packed);
  await sleep(700); // 两帧以上，确保材质重编译与 attribute 替换已生效
  return sample();
};

const diff = (a, b) => {
  if (a.pixels.length !== b.pixels.length) return { samples: -1, changed: Infinity, max: Infinity };
  let changed = 0;
  let max = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const d = Math.abs(a.pixels[i] - b.pixels[i]);
    if (d > 0) changed++;
    if (d > max) max = d;
  }
  return { samples: a.pixels.length, changed, max };
};

const A = await sample();
const B = await flip(false);
const A2 = await flip(true);
const result = {
  scene: { meshesA: A.meshes, meshesB: B.meshes, meshesA2: A2.meshes },
  bytesPerVertex: { A: A.bytes, B: B.bytes, A2: A2.bytes },
  pixelDiff: { A_vs_B: diff(A, B), A_vs_A2: diff(A, A2) },
  errors,
};
fs.writeFileSync(path.join(OUT, 'experiment-light-layout.json'), JSON.stringify(result, null, 2));
await browser.close();

const sceneSame = A.meshes === B.meshes && A.meshes === A2.meshes;
const layoutOk = A.bytes === 1 && B.bytes === 8 && A2.bytes === 1;
// 判据：翻转布局的像素差不超过同页噪声底 + 2 个采样点；打包前后必须逐位等价
const ab = result.pixelDiff.A_vs_B;
const aa = result.pixelDiff.A_vs_A2;
const pixelsOk = ab.changed <= aa.changed + 2 && ab.max <= aa.max + 2;
const pass = sceneSame && layoutOk && pixelsOk && errors.length === 0;
console.log(JSON.stringify(result, null, 2));
console.log(pass ? 'PASS E16 受控实验' : 'FAIL E16 受控实验');
process.exit(pass ? 0 : 1);
