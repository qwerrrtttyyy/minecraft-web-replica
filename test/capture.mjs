import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--allow-file-access-from-files',
  ],
});
async function shot(mobile, file, after) {
  const page = await browser.newPage();
  if (mobile)
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  else await page.setViewport({ width: 1280, height: 760 });
  await page.goto(`file://${path.join(ROOT, 'dist/index.html')}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 30000 });
  await page.evaluate(() => window.__mc.startGame(false));
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
  await sleep(2500);
  if (after) await after(page);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}
await shot(false, 'shot-desktop.png');
await shot(true, 'shot-mobile.png');
await shot(false, 'shot-death.png', async (p) => {
  await p.evaluate(() => window.__mc.survival.damage(99, '僵尸的攻击'));
  await p.waitForFunction('window.__mc.mode === "dead"', { timeout: 8000 }).catch(() => {});
  await sleep(400);
});
await browser.close();
console.log('captured');
