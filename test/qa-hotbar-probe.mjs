/** QA 独立探针：采集快捷栏槽位 pointer-events 计算值、命中元素与真实点击前后 hotbar.index（含反证）。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ??
  '/usr/local/bin/chromium';
const URL_UNDER_TEST = `file://${path.join(ROOT, 'dist', 'index.html')}`;
const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_ARGS =
  (process.env.MC_GL ?? 'swiftshader') === 'desktop'
    ? ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--use-gl=desktop']
    : ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader'];
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

async function probe(mobile, slotIndex, poison = false) {
  const page = await browser.newPage();
  if (mobile) {
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  } else {
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  }
  // 桌面禁用 pointer lock：锁定态下浏览器会把真实点击强制派发到 canvas，
  // 无法验证槽位命中。此 no-op 仅注入本探针页面，不改产品源码。
  if (!mobile) {
    await page.evaluateOnNewDocument(() => {
      HTMLCanvasElement.prototype.requestPointerLock = () => Promise.resolve();
    });
  }
  await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.setItem('mc-ts-new-seed', '2026');
    sessionStorage.setItem('mc-ts-new-mode', 'survival');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  await page.evaluate(() => window.__mc.startGame(false));
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
  await sleep(700);

  // 移动端：先关掉竖屏旋转引导遮罩，否则 elementFromPoint 命中的是遮罩（预期行为）。
  if (mobile) {
    const gateShown = await page.evaluate(() => {
      const gate = document.getElementById('rotate-gate');
      return !!gate && !gate.hidden;
    });
    if (gateShown) await page.click('.rotate-gate-play');
  }
  // 反证：仅在本探针页面注入覆盖样式，模拟修复缺失时的 pointer-events 穿透。
  if (poison) {
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.hotbar-slot { pointer-events: none !important; }';
      document.head.appendChild(style);
    });
  }
  await sleep(150);

  const snap = await page.evaluate((idx) => {
    const slot = document.querySelectorAll('.hotbar-slot')[idx];
    const r = slot.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const centerHit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).pointerEvents : 'n/a';
    };
    return {
      slotIndex: idx,
      x,
      y,
      computed: {
        ui: cs('#ui'),
        gameHud: cs('.game-hud'),
        hotbarWrap: cs('.hotbar-wrap'),
        hotbar: cs('.hotbar'),
        slot: cs('.hotbar-slot'),
        slotIcon: cs('.hotbar-slot .slot-icon'),
        slotNum: cs('.hotbar-slot .slot-num'),
        slotCount: cs('.hotbar-slot .slot-count'),
        touchUi: cs('.touch-ui'),
      },
      slotHit: {
        tag: hit?.tagName ?? null,
        cls: typeof hit?.className === 'string' ? hit.className : '',
        isSlot: !!hit && (hit === slot || slot.contains(hit)),
      },
      centerHit: { tag: centerHit?.tagName ?? null },
      before: window.__mc.player.hotbar.index,
      pointerLock: document.pointerLockElement?.tagName ?? null,
    };
  }, slotIndex);

  if (mobile) {
    await page.touchscreen.touchStart(snap.x, snap.y);
    await page.touchscreen.touchEnd();
  } else {
    await page.mouse.click(snap.x, snap.y);
  }
  await sleep(200);
  const after = await page.evaluate(() => window.__mc.player.hotbar.index);
  await page.close();
  return { mobile, poison, ...snap, after };
}

const desktop = await probe(false, 3);
const mobile = await probe(true, 2);
const poison = await probe(false, 3, true);
console.log(JSON.stringify({ desktop, mobile, poison }, null, 2));
await browser.close();
