/**
 * E18 受控实验：帧预算调度器的实际收益（软预算开 / 关，**同页** A/B）。
 *
 * 硬规则（docs/EXPERIMENTS.md §1.1 / AGENTS §3.14）：性能类改动要在同一页内翻转变量并单测噪声底，
 * 因为帧率与区块集合跨页不可比；测量工具**不挂 verify**。
 *
 * 翻转方式：运行时钩子 window.__mc.scheduler.setBudget(ms)（已有 API），逐相位前 perf.reset() 隔离窗口。
 *   A   budget=0     软预算关（回到逐帧等价，对照）
 *   B   budget=12    默认软预算
 *   A'  budget=0     再翻回，单独作噪声底（证明「无差异」不是测量失效）
 *   C   budget=0.05  强制极低预算，验证让位机制确实生效
 *
 * 指标：帧时 avg/p95（墙钟）与**系统 CPU p50 之和**（p50 抗单次尖峰）；
 *       background 执行率 = 每 bg 系统每帧实际执行次数（1.0 = 每帧都跑）。
 *
 * 判据（脚本自带，失败即 exit 1）：
 *   1. 预算回读必须为 0 / 12 / 0 / 0.05；
 *   2. 稳态（A/B/A'）background 执行率 ≈ 1（默认 12ms 未触发裁剪）；
 *   3. C 相位 background 执行率 < 1 且累计跳过 > 0（让位机制生效）；
 *   4. C 相位 critical 系统 CPU p50 **未高于** A + 噪声底 + 计时量子（关键系统不因裁剪变慢；
 *      单边判据 —— 软件渲染下 performance.now 量化约 0.1ms，减负导致的下降不算回归）；
 *   5. 全程无运行时错误。
 *
 * 用法：npm run build && npm run test:experiment-perf
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
const BASE_URL = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist', 'index.html')}`;
const HEADLESS = process.env.MC_HEADLESS !== '0';
const GL_BASE = ['--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
const GL_ARGS = (process.env.MC_GL ?? 'swiftshader') === 'desktop'
  ? [...GL_BASE, '--use-gl=desktop']
  : [...GL_BASE, '--use-gl=angle', '--use-angle=swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = Number(process.env.MC_PERF_FRAMES ?? 120);

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: ['--no-sandbox', '--disable-dev-shm-usage', ...GL_ARGS,
    '--allow-file-access-from-files', '--window-size=1280,760', '--mute-audio'],
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
await page.goto(BASE_URL, { waitUntil: 'load' });
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
// 预热：让区块流式加载 / 光照收敛，避免把启动翻涌算进对照
await page.waitForFunction('window.__mc.schedulerStats().frame >= 150', { timeout: 150000 }).catch(() => {});
await sleep(1000);

const BG = ['botany', 'particles', 'weatherParticles'];

/** 采样一个相位：设预算 + 清窗口 + 推进 FRAMES 帧，读帧统计与逐系统 CPU。 */
async function phase(label, budget) {
  return await page.evaluate(async (label, budget, frames, BG) => {
    const mc = window.__mc;
    mc.scheduler.setBudget(budget);
    mc.perf.reset();
    const s0 = mc.schedulerStats();
    const start = s0.frame;
    const runs0 = Object.fromEntries(s0.slots.map((sl) => [sl.name, sl.runs]));
    while (mc.schedulerStats().frame - start < frames) {
      await new Promise((r) => setTimeout(r, 40));
    }
    const rep = mc.perfReport();
    const s = mc.schedulerStats();
    const df = s.frame - start;
    const sum = (arr, key) => arr.reduce((a, o) => a + o[key], 0);
    const isBg = (n) => BG.includes(n);
    const bg = rep.offenders.filter((o) => isBg(o.name));
    const crit = rep.offenders.filter((o) => !isBg(o.name));
    const bgRates = bg.map((o) => (s.slots.find((sl) => sl.name === o.name).runs - runs0[o.name]) / Math.max(1, df));
    return {
      label, budget,
      budgetReadback: mc.scheduler.budget,
      frames: rep.frames,
      frameAvg: rep.frameAvg, frameP95: rep.frameP95,
      sysP50: sum(rep.offenders, 'p50'), sysP95: sum(rep.offenders, 'p95'),
      bgP50: sum(bg, 'p50'),
      bgRunRate: bgRates.length ? bgRates.reduce((a, b) => a + b, 0) / bgRates.length : 1,
      critP50: sum(crit, 'p50'),
      skipped: s.skippedBudget - s0.skippedBudget,
      top: rep.offenders.slice(0, 7).map((o) => ({ name: o.name, p50: o.p50, p95: o.p95 })),
    };
  }, label, budget, FRAMES, BG);
}

try {
  const a1 = await phase('A', 0);
  const b = await phase('B', 12);
  const a2 = await phase("A'", 0);
  const c = await phase('C', 0.05);

  for (const p of [a1, b, a2, c]) {
    console.log(`[E18] ${p.label.padEnd(2)} budget=${p.budgetReadback} ${p.frames}f | ` +
      `帧 avg=${p.frameAvg.toFixed(1)} p95=${p.frameP95.toFixed(1)} | ` +
      `系统CPU p50=${p.sysP50.toFixed(3)}ms p95=${p.sysP95.toFixed(2)} | ` +
      `bg 执行率=${(p.bgRunRate * 100).toFixed(1)}% | crit p50=${p.critP50.toFixed(3)} | 跳过=${p.skipped}`);
  }

  const noiseSys = Math.abs(a2.sysP50 - a1.sysP50);
  const noiseFrame = Math.abs(a2.frameAvg - a1.frameAvg);
  console.log(`[E18] 噪声底 A vs A'：系统CPU p50 差=${noiseSys.toFixed(3)}ms，帧 avg 差=${noiseFrame.toFixed(1)}ms`);

  // 软件渲染下 performance.now 量化约 0.1ms：单边判据只用它兜住量化步长
  const TIMER_QUANTUM = 0.1;
  const critDelta = c.critP50 - a1.critP50;

  const gates = [
    ['预算回读正确 (0/12/0/0.05)',
      a1.budgetReadback === 0 && b.budgetReadback === 12 && a2.budgetReadback === 0 && c.budgetReadback === 0.05],
    ['稳态 background 每帧都跑（默认预算未触发裁剪）',
      a1.bgRunRate > 0.999 && b.bgRunRate > 0.999 && a2.bgRunRate > 0.999],
    ['C 强制低预算：background 让位生效', c.bgRunRate < 0.999 && c.skipped > 0],
    ['C 强制低预算：critical 系统 CPU 不因裁剪变慢（单边 ≤ 噪声底 + 计时量子）',
      critDelta <= noiseSys + TIMER_QUANTUM],
    ['全程无运行时错误', errors.length === 0],
  ];
  console.log(`[E18] critical CPU 差 C - A = ${critDelta.toFixed(3)}ms（阈值 ${(noiseSys + TIMER_QUANTUM).toFixed(3)}ms）`);
  let failed = 0;
  for (const [name, pass] of gates) {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }

  fs.writeFileSync(path.join(OUT, 'experiment-perf-scheduler.json'), JSON.stringify({
    when: new Date().toISOString(),
    frames: FRAMES,
    env: { headless: HEADLESS, gl: process.env.MC_GL ?? 'swiftshader' },
    phases: [a1, b, a2, c],
    noise: { sysP50: noiseSys, frameAvg: noiseFrame },
    errors,
  }, null, 2));

  if (failed > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
