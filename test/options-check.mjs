/**
 * 设置页（Options）回归：桌面端 + 移动端 + 关键交互。
 *
 * 覆盖：
 *  - 入口（标题屏链接 / 暂停菜单按钮）与关闭回源；
 *  - 控件（音效开关、音量、渲染距离、FOV、灵敏度、反转 Y 轴、重置）；
 *  - 高级项（画质档位、粒子、视角摇晃、自动跳跃、触控灵敏度）；
 *  - 开发者项（调试信息、Greedy、网格化线程、自动保存间隔、导入 / 导出）；
 *  - 实验性玩法（随机刻速度 / 昼夜循环 / 死亡保留物品 / 生物生成 / 体素云层 / 方块重力 / 透明排序）即时生效与持久化；
 *  - 立即生效（引擎 / 输入 / 音频 / 网格化）；
 *  - localStorage 持久化与跨会话恢复；
 *  - 移动端布局无横向溢出、触控目标尺寸达标。
 *
 * 用法：node test/options-check.mjs
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
const OPTIONS_KEY = 'minecraft-ts-options-v1';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

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
    '--allow-file-access-from-files', '--window-size=1280,800', '--mute-audio',
  ],
});

const newPage = async (w, h, mobile = false) => {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => {
    try {
      // 每个标签页首次加载清一次本地设置；刷新（跨会话恢复验证）要保留
      if (!sessionStorage.getItem('mc-options-cleared')) {
        localStorage.removeItem('minecraft-ts-options-v1');
        sessionStorage.setItem('mc-options-cleared', '1');
      }
    } catch { /* 忽略 */ }
  });
  return page;
};

/** 在指定容器内按文本点击按钮 */
const clickText = async (page, selector, text) => page.evaluate(({ selector, text }) => {
  const el = [...document.querySelectorAll(selector)].find((b) => (b.textContent || '').includes(text));
  if (el) el.click();
  return !!el;
}, { selector, text });

/** 设置设置页里某个滑杆的值（按标签定位） */
const setSlider = async (page, label, value) => page.evaluate(({ label, value }) => {
  const row = [...document.querySelectorAll('.options-panel .slider-row')]
    .find((r) => (r.querySelector('.slider-head span')?.textContent || '') === label);
  if (!row) return false;
  const input = row.querySelector('input.mc-slider');
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, { label, value });

/** 在设置页里按标签找选项行，点击 times 次后返回右侧文案 */
const clickRow = async (page, label, times = 1) => page.evaluate(({ label, times }) => {
  const row = [...document.querySelectorAll('.options-panel .opt-row')]
    .find((b) => b.querySelector('.opt-label')?.textContent === label);
  if (!row) return null;
  for (let i = 0; i < times; i++) row.click();
  return row.querySelector('.opt-val').textContent;
}, { label, times });

const readOptions = (page) => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
}, OPTIONS_KEY);

const gotoTitle = async (page) => {
  await page.goto(URL_UNDER_TEST, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__mc && window.__mc.mode === "title"', { timeout: 90000 });
  await sleep(1200);
};

try {
  // ================= 桌面端 =================
  const page = await newPage(1280, 800);
  await gotoTitle(page);

  ok('标题屏有「设置」入口', await page.evaluate(() =>
    [...document.querySelectorAll('.title-links .link-btn')].some((b) => b.textContent.includes('设置'))));

  // 标题屏直接进入设置
  await clickText(page, '.title-links .link-btn', '设置');
  await sleep(300);
  const opened = await page.evaluate(() => ({
    open: window.__mc.hud.optionsOpen,
    groups: [...document.querySelectorAll('.options-panel .opt-group h3')].map((e) => e.textContent),
    sliders: [...document.querySelectorAll('.options-panel .slider-row .slider-head span')].map((e) => e.textContent),
  }));
  await page.screenshot({ path: path.join(OUT, 'options-desktop.png') });
  ok('标题屏打开设置页', opened.open, JSON.stringify(opened.groups));
  ok('设置页含音效/视频/控制/实验性内容/实验性玩法/开发者分组',
    opened.groups.join(',') === '音效,视频,控制,实验性内容,实验性玩法,开发者', opened.groups.join(','));
  ok('设置页滑杆齐全', ['音量', '渲染距离', '视野 FOV', '视角灵敏度'].every((s) => opened.sliders.includes(s)),
    opened.sliders.join(','));
  ok('桌面端不显示触控灵敏度', !opened.sliders.includes('触控灵敏度'), opened.sliders.join(','));

  // 实验性内容：我的世界 UI 还原开关
  ok('设置页含「我的世界 UI 还原」选项行', await page.evaluate(() =>
    [...document.querySelectorAll('.options-panel .opt-row .opt-label')]
      .some((e) => e.textContent === '我的世界 UI 还原')));
  const uiBefore = await page.evaluate(() => document.getElementById('ui').classList.contains('vanilla-ui'));
  await clickRow(page, '我的世界 UI 还原');
  await sleep(200);
  const uiOn = await page.evaluate(() => ({
    cls: document.getElementById('ui').classList.contains('vanilla-ui'),
    val: [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '我的世界 UI 还原')
      ?.querySelector('.opt-val')?.textContent,
    saved: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').vanillaUI,
  }));
  ok('UI 还原开关即时给 #ui 挂上 vanilla-ui 类', !uiBefore && uiOn.cls,
    `before=${uiBefore} after=${uiOn.cls}`);
  ok('UI 还原开关显示「开」并写入 localStorage', uiOn.val === '开' && uiOn.saved === true,
    `val=${uiOn.val} saved=${uiOn.saved}`);

  // 必须用普通 mc-btn：opt-row 的伪元素被刻意 display:none，读不到真实宽度
  const btnSel = '.options-panel .options-footer .mc-btn';
  const readMarker = (sel) => page.evaluate((s) => {
    const cs = getComputedStyle(document.querySelector(s), '::before');
    return { width: parseFloat(cs.width), display: cs.display };
  }, sel);
  const markerBefore = await readMarker(btnSel);
  await page.hover(btnSel);
  const markerHover = await readMarker(btnSel);
  ok('Java 1.20 按钮 » 记号在悬停时可见',
    markerBefore.width === 0 && markerHover.width > 0 && markerHover.display !== 'none',
    `before=${JSON.stringify(markerBefore)} hover=${JSON.stringify(markerHover)}`);
  const pixelFont = await page.evaluate(() => {
    const el = document.querySelector('.options-panel .opt-label');
    return el ? getComputedStyle(el).fontFamily : '';
  });
  ok('UI 还原启用像素字体', pixelFont.includes('MC Pixel'), pixelFont);
  await clickRow(page, '我的世界 UI 还原');
  await sleep(200);
  ok('再点一次恢复默认界面', await page.evaluate(() =>
    !document.getElementById('ui').classList.contains('vanilla-ui') &&
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').vanillaUI === false));

  // Esc 关闭（标题屏来源 → 回到标题）
  // 固定 sleep 在负载高时会偶发失败，按项目硬规则改为条件轮询
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    '!window.__mc.hud.optionsOpen && window.__mc.mode === "title"',
    { timeout: 10000 },
  ).catch(() => {});
  ok('Esc 关闭设置页回到标题', await page.evaluate(() =>
    !window.__mc.hud.optionsOpen && window.__mc.mode === 'title'));

  // 进入游戏 → 菜单 → 设置
  await page.evaluate(() => { [...document.querySelectorAll('.title-buttons .mc-btn')][0]?.click(); });
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });
  await sleep(1500);
  await page.keyboard.press('Escape');
  await page.waitForFunction('window.__mc.hud.menuOpen', { timeout: 10000 }).catch(() => {});
  ok('Esc 打开暂停菜单', await page.evaluate(() => window.__mc.hud.menuOpen));
  await clickText(page, '.menu-panel .mc-btn', '设置');
  await page.waitForFunction('window.__mc.hud.optionsOpen', { timeout: 10000 }).catch(() => {});
  ok('菜单打开设置页', await page.evaluate(() => window.__mc.hud.optionsOpen));

  // 音效开关
  const sound0 = await page.evaluate(() => window.__mc.sound.enabled);
  await clickText(page, '.options-panel .opt-row', '音效');
  await sleep(200);
  const sound1 = await page.evaluate(() => ({
    enabled: window.__mc.sound.enabled,
    label: document.querySelector('.options-panel .opt-row .opt-val')?.textContent,
    muted: document.querySelector('.icon-sound').classList.contains('muted'),
  }));
  ok('音效开关即时生效并同步按钮', sound1.enabled === !sound0 && sound1.label === (sound0 ? '关' : '开') && sound1.muted === sound0,
    JSON.stringify(sound1));

  // 音量滑杆
  await setSlider(page, '音量', 80);
  await sleep(200);
  const vol = await page.evaluate(() => ({ volume: window.__mc.sound.volume, label: window.__mc.sound.volume * 100 }));
  const volStored = (await readOptions(page))?.volume;
  ok('音量即时生效', Math.abs(vol.volume - 0.8) < 1e-6, `volume=${vol.volume}`);
  ok('音量写入本地设置', volStored === 80, `stored=${volStored}`);

  // 渲染距离
  await setSlider(page, '渲染距离', 4);
  await sleep(300);
  ok('渲染距离即时生效', await page.evaluate(() => window.__mc.chunks.renderDistance === 4));

  // FOV
  await setSlider(page, '视野 FOV', 90);
  await sleep(200);
  ok('FOV 即时生效', await page.evaluate(() => Math.round(window.__mc.engine.camera.fov) === 90));

  // 反转 Y 轴
  const inv0 = await page.evaluate(() => window.__mc.input.invertY);
  await clickText(page, '.options-panel .opt-row', '反转 Y 轴');
  await sleep(200);
  const inv1 = await page.evaluate(() => ({
    invertY: window.__mc.input.invertY,
    label: [...document.querySelectorAll('.options-panel .opt-row .opt-val')].map((e) => e.textContent),
  }));
  ok('反转 Y 轴即时生效', inv1.invertY === !inv0, JSON.stringify(inv1));
  const look = await page.evaluate(() => {
    const i = window.__mc.input;
    i.addLook(0, 10);
    return i.consumeLook()[1];
  });
  ok('反转 Y 轴改变视角增量方向', inv1.invertY ? look < 0 : look > 0, `dy=${look}`);

  // 画质档位（循环行）：自动 → 高 → 均衡，引擎分辨率倍率同步变化
  const quality = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '画质');
    const before = row.querySelector('.opt-val').textContent;
    row.click();
    const high = row.querySelector('.opt-val').textContent;
    row.click();
    const balanced = row.querySelector('.opt-val').textContent;
    return { before, high, balanced, scale: window.__mc.engine.qualityScale };
  });
  ok('画质档位循环并生效', quality.before === '自动' && quality.high === '高' &&
    quality.balanced === '均衡' && Math.abs(quality.scale - 0.85) < 0.02, JSON.stringify(quality));

  // 粒子 / 视角摇晃 / 自动跳跃
  const toggles = await page.evaluate(() => {
    const pick = (l) => [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === l);
    const out = {};
    pick('粒子效果').click();
    out.particles = window.__mc.particles.enabled;
    pick('视角摇晃').click();
    out.viewBob = window.__mc.player.viewBob;
    pick('自动跳跃').click();
    out.autoJump = window.__mc.player.autoJump;
    out.labels = ['粒子效果', '视角摇晃', '自动跳跃'].map((l) => pick(l).querySelector('.opt-val').textContent);
    return out;
  });
  ok('粒子效果即时生效', toggles.particles === false, JSON.stringify(toggles));
  ok('视角摇晃即时生效', toggles.viewBob === false);
  ok('自动跳跃即时生效', toggles.autoJump === true);
  ok('开关行文案同步', toggles.labels.join(',') === '关,关,开', toggles.labels.join(','));

  // ---- 开发者设置 ----
  const greedy = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === 'Greedy 网格合并');
    row.click();
    return { greedy: window.__mc.chunks.greedy, label: row.querySelector('.opt-val').textContent };
  });
  ok('Greedy 网格合并可切换', greedy.greedy === false && greedy.label === '关', JSON.stringify(greedy));

  const threadsLabel = await clickRow(page, '网格化线程');
  await page.waitForFunction(() => window.__mc.chunks.mesherMode === 'main', { timeout: 20000 });
  const threadsState = await page.evaluate(() => ({ mode: window.__mc.chunks.mesherMode, workers: window.__mc.chunks.workerCount }));
  ok('网格化线程切到主线程', threadsLabel === '主线程' && threadsState.mode === 'main' && threadsState.workers === 0,
    JSON.stringify({ threadsLabel, ...threadsState }));
  // 切回「自动」（主线程 → 1 → 2 → 4 → 自动，共 4 次），避免影响后续对照
  await clickRow(page, '网格化线程', 4);
  await page.waitForFunction(() => window.__mc.chunks.mesherMode === 'worker', { timeout: 20000 });
  // 8 秒 → 15 秒 → 30 秒 → 关闭，点 3 次到「关闭」
  const autosave = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '自动保存间隔');
    row.click(); row.click(); row.click();
    return {
      label: row.querySelector('.opt-val').textContent,
      stored: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || 'null')?.autosaveInterval,
    };
  });
  ok('自动保存间隔可调并持久化', autosave.label === '关闭' && autosave.stored === 0, JSON.stringify(autosave));
  const debugLabel = await clickRow(page, '显示调试信息');
  ok('显示调试信息开关同步', debugLabel === '开', `label=${debugLabel}`);

  // ---- 实验性玩法（4 个 gamerule 风格开关） ----
  ok('实验性玩法分组存在', await page.evaluate(() =>
    [...document.querySelectorAll('.options-panel .opt-group h3')].some((e) => e.textContent === '实验性玩法')));

  // 随机刻速度：cycleRow 点击轮转 暂停→慢→标准→快，默认「标准」
  const tickDefault = await page.evaluate(() => ({
    label: [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '随机刻速度')?.querySelector('.opt-val')?.textContent,
    attempts: window.__mc.botany.attempts,
  }));
  ok('随机刻速度默认「标准」且采样数>0', tickDefault.label === '标准' && tickDefault.attempts > 0,
    JSON.stringify(tickDefault));
  // 点 3 次：标准→快→暂停→慢（轮转 4 档），验证到「暂停」时 attempts=0
  const tickCycle = [];
  for (let i = 0; i < 4; i++) {
    tickCycle.push(await page.evaluate(() => {
      const row = [...document.querySelectorAll('.options-panel .opt-row')]
        .find((b) => b.querySelector('.opt-label')?.textContent === '随机刻速度');
      row.click();
      return { label: row.querySelector('.opt-val').textContent, attempts: window.__mc.botany.attempts };
    }));
  }
  ok('随机刻速度档位轮转正确（暂停时采样数=0）',
    tickCycle[1].label === '暂停' && tickCycle[1].attempts === 0 &&
    tickCycle[0].attempts > tickCycle[3].attempts,
    JSON.stringify(tickCycle));
  // 回到「标准」档，避免影响后续生态
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '随机刻速度');
    const labels = ['暂停', '慢', '标准', '快'];
    while (row.querySelector('.opt-val').textContent !== '标准') row.click();
    return labels;
  });

  // 昼夜循环：关闭后 sky.advanceTime=false
  const daylightOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '昼夜循环');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, advance: window.__mc.sky.advanceTime,
      stored: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || 'null')?.doDaylightCycle };
  });
  ok('昼夜循环可冻结并即时生效', daylightOff.label === '关' && daylightOff.advance === false && daylightOff.stored === false,
    JSON.stringify(daylightOff));
  await clickRow(page, '昼夜循环'); // 恢复开启

  // 死亡保留物品：关闭后 survival.keepInventory=false
  const keepInvOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '死亡保留物品');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, keep: window.__mc.survival.keepInventory };
  });
  ok('死亡保留物品可关闭并即时生效', keepInvOff.label === '关' && keepInvOff.keep === false,
    JSON.stringify(keepInvOff));
  await clickRow(page, '死亡保留物品'); // 恢复开启

  // 生物生成：关闭后 entities.allowSpawn=false
  const spawnOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '生物生成');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, allow: window.__mc.entities.allowSpawn };
  });
  ok('生物生成可关闭并即时生效', spawnOff.label === '关' && spawnOff.allow === false,
    JSON.stringify(spawnOff));
  await clickRow(page, '生物生成'); // 恢复开启

  // 体素云层：关闭后 sky.showClouds=false，云网格隐藏
  const cloudsOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '体素云层');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, show: window.__mc.sky.showClouds,
      visible: window.__mc.sky.clouds.visible };
  });
  ok('体素云层可关闭并即时生效', cloudsOff.label === '关' && cloudsOff.show === false && cloudsOff.visible === false,
    JSON.stringify(cloudsOff));
  await clickRow(page, '体素云层'); // 恢复开启

  // 方块重力：关闭后 falling.enabled=false
  const gravityOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '方块重力');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, enabled: window.__mc.falling.enabled };
  });
  ok('方块重力可关闭并即时生效', gravityOff.label === '关' && gravityOff.enabled === false,
    JSON.stringify(gravityOff));
  await clickRow(page, '方块重力'); // 恢复开启

  // 透明排序：关闭后 chunks.transparentSortEnabled=false
  const sortOff = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.options-panel .opt-row')]
      .find((b) => b.querySelector('.opt-label')?.textContent === '透明排序');
    row.click();
    return { label: row.querySelector('.opt-val').textContent, sort: window.__mc.chunks.transparentSortEnabled };
  });
  ok('透明排序可关闭并即时生效', sortOff.label === '关' && sortOff.sort === false,
    JSON.stringify(sortOff));
  await clickRow(page, '透明排序'); // 恢复开启

  // Esc 关闭设置 → 回到暂停菜单
  await page.keyboard.press('Escape');
  // 固定 sleep 在负载高时会偶发失败，按项目硬规则改为条件轮询
  const escToMenu = await page.waitForFunction(
    () => !window.__mc.hud.optionsOpen && window.__mc.hud.menuOpen,
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  ok('Esc 关闭设置回到菜单', escToMenu);

  // 「显示调试信息」常显：回到游戏后调试面板应在场
  await clickText(page, '.menu-panel .mc-btn', '继续游戏');
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 60000 });
  // 调试面板由渲染循环逐帧刷新，等它真的在场再断言
  const debugShown = await page.waitForFunction(() => {
    const el = document.querySelector('.debug-panel');
    return !!el && el.style.display !== 'none' && el.textContent.includes('FPS');
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  ok('显示调试信息常显', debugShown);

  // 持久化：刷新后设置仍在
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__mc && window.__mc.mode === "title"', { timeout: 90000 });
  const persisted = await page.evaluate(() => ({
    sound: window.__mc.sound.enabled,
    volume: window.__mc.sound.volume,
    rd: window.__mc.chunks.renderDistance,
    fov: Math.round(window.__mc.engine.camera.fov),
    invertY: window.__mc.input.invertY,
    quality: window.__mc.engine.qualityScale,
    particles: window.__mc.particles.enabled,
    viewBob: window.__mc.player.viewBob,
    autoJump: window.__mc.player.autoJump,
    greedy: window.__mc.chunks.greedy,
    stored: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || 'null'),
  }));
  ok('刷新后音量/音效/渲染距离/FOV/反转Y 保留',
    persisted.volume === 0.8 && persisted.sound === !sound0 && persisted.rd === 4 &&
    persisted.fov === 90 && persisted.invertY === !inv0,
    JSON.stringify(persisted));
  ok('刷新后高级/开发者设置保留',
    Math.abs(persisted.quality - 0.85) < 0.02 && persisted.particles === false &&
    persisted.viewBob === false && persisted.autoJump === true && persisted.greedy === false &&
    persisted.stored?.autosaveInterval === 0 && persisted.stored?.debugOverlay === true,
    JSON.stringify(persisted));

  // 重置全部设置
  await clickText(page, '.title-links .link-btn', '设置');
  await sleep(300);
  await clickText(page, '.options-panel .mc-btn', '重置全部设置');
  await sleep(300);
  const reset = await page.evaluate(() => ({
    sound: window.__mc.sound.enabled,
    volume: window.__mc.sound.volume,
    rd: window.__mc.chunks.renderDistance,
    fov: Math.round(window.__mc.engine.camera.fov),
    invertY: window.__mc.input.invertY,
    quality: window.__mc.engine.qualityScale,
    particles: window.__mc.particles.enabled,
    viewBob: window.__mc.player.viewBob,
    autoJump: window.__mc.player.autoJump,
    greedy: window.__mc.chunks.greedy,
    stored: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || 'null'),
  }));
  await page.screenshot({ path: path.join(OUT, 'options-reset.png') });
  ok('重置全部设置回到默认', reset.sound === true && reset.volume === 0.5 && reset.rd === 5 &&
    reset.fov === 72 && reset.invertY === false && Math.abs(reset.quality - 1) < 0.02 &&
    reset.particles === true && reset.viewBob === true && reset.autoJump === false && reset.greedy === true,
    JSON.stringify(reset));
  ok('重置后本地设置同步', reset.stored?.volume === 50 && reset.stored?.invertY === false &&
    reset.stored?.quality === 'auto' && reset.stored?.mesherThreads === 'auto' &&
    reset.stored?.autosaveInterval === 8 && reset.stored?.debugOverlay === false &&
    reset.stored?.particles === true && reset.stored?.viewBob === true &&
    reset.stored?.autoJump === false && reset.stored?.greedy === true && reset.stored?.touchSensitivity === 1,
    JSON.stringify(reset.stored));
  await page.keyboard.press('Escape');
  // Esc 边沿由渲染循环消费，比 keydown 晚几帧；这里等的是「设置页真的关了」，
  // 不是 mode（重置后本来就是 title，等它等于没等，延迟的 Esc 会误关下一次打开的设置页）
  await page.waitForFunction('!window.__mc.hud.optionsOpen', { timeout: 10000 }).catch(() => {});

  // 导出 / 导入设置（开发者工具）
  await clickText(page, '.title-links .link-btn', '设置');
  await sleep(300);
  await clickText(page, '.options-panel .menu-row .mc-btn', '导出设置');
  // 等覆盖层真的打开再读 textarea，否则可能读到上一次的残留
  await page.waitForFunction(() => {
    const ov = document.querySelector('.options-io-overlay');
    return !!ov && ov.style.display !== 'none';
  }, { timeout: 10000 }).catch(() => {});
  const exported = await page.evaluate(() => {
    const ov = document.querySelector('.options-io-overlay');
    if (!ov || ov.style.display === 'none') return null;
    try { return JSON.parse(ov.querySelector('textarea')?.value || ''); } catch { return null; }
  });
  ok('导出设置为合法 JSON 且字段齐全', !!exported && exported.volume === 50 &&
    exported.quality === 'auto' && exported.mesherThreads === 'auto' &&
    exported.autosaveInterval === 8 && exported.debugOverlay === false, JSON.stringify(exported));
  await page.keyboard.press('Escape');
  // 用等待代替固定 sleep：整套 verify 并行跑浏览器时 Esc 边沿可能晚几帧
  const ioClosed = await page.waitForFunction(() => {
    if (!window.__mc.hud.optionsOpen) return false;
    const ov = document.querySelector('.options-io-overlay');
    return !ov || ov.style.display === 'none';
  }, { timeout: 8000 }).then(() => true).catch(() => false);
  ok('Esc 关闭导入导出面板（设置仍在）', ioClosed);

  await clickText(page, '.options-panel .menu-row .mc-btn', '导入设置');
  await page.waitForFunction(() => {
    const ov = document.querySelector('.options-io-overlay');
    return !!ov && ov.style.display !== 'none' && !!ov.querySelector('textarea');
  }, { timeout: 10000 }).catch(() => {});
  const imported = await page.evaluate(() => {
    const ta = document.querySelector('.options-io-overlay textarea');
    ta.value = JSON.stringify({ volume: 42, invertY: true, experimental: true, bogusField: 1 });
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.options-io-overlay .mc-btn')].find((b) => b.textContent.includes('应用'))?.click();
    return {
      vol: window.__mc.sound.volume,
      inv: window.__mc.input.invertY,
      ioOpen: window.__mc.hud.optionsIOOpen,
      stored: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || 'null'),
    };
  });
  await sleep(300);
  ok('导入设置应用并持久化', Math.abs(imported.vol - 0.42) < 1e-6 && imported.inv === true &&
    imported.stored.volume === 42 && imported.stored.invertY === true &&
    imported.stored.bogusField === undefined, JSON.stringify(imported));
  ok('导入后关闭导入导出面板', imported.ioOpen === false);

  // 导入 experimental:true 后必须推到 WASM 与插件载体
  ok('导入设置后 experimental 推到 WASM/插件载体', await page.evaluate(() => {
    const wasm = window.__mc.services.optional({ key: 'wasm' });
    return wasm?.getState() !== 'disabled' && window.__mc.plugins.getExperimental() === true;
  }));
  // 恢复，避免 experimental 开启影响后续用例
  await clickText(page, '.options-panel .menu-row .mc-btn', '导入设置');
  await page.waitForFunction(() => document.querySelector('.options-io-overlay')?.style.display !== 'none');
  await page.evaluate(() => {
    const ta = document.querySelector('.options-io-overlay textarea');
    ta.value = JSON.stringify({ experimental: false });
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.options-io-overlay .mc-btn')].find((b) => b.textContent.includes('应用'))?.click();
  });
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(250);

  // ================= 移动端 =================
  const mob = await newPage(390, 844, true);
  await gotoTitle(mob);
  await clickText(mob, '.title-links .link-btn', '设置');
  await sleep(400);
  const mobUi = await mob.evaluate(() => {
    const panel = document.querySelector('.options-panel');
    const r = panel.getBoundingClientRect();
    const btn = panel.querySelector('.mc-btn');
    const br = btn.getBoundingClientRect();
    const slider = panel.querySelector('.mc-slider');
    return {
      open: window.__mc.hud.optionsOpen,
      withinWidth: r.left >= 0 && r.right <= window.innerWidth + 1,
      panelW: Math.round(r.width),
      btnH: Math.round(br.height),
      sliderH: Math.round(slider.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      scrollable: panel.scrollHeight > panel.clientHeight,
      touch: [...panel.querySelectorAll('.slider-head span')].map((e) => e.textContent).includes('触控灵敏度'),
    };
  });
  ok('移动端含触控灵敏度滑杆', mobUi.touch);
  await mob.screenshot({ path: path.join(OUT, 'options-mobile.png') });
  ok('移动端设置页打开且不出屏', mobUi.open && mobUi.withinWidth && mobUi.overflow,
    `panelW=${mobUi.panelW} overflow=${mobUi.overflow}`);
  ok('移动端触控目标达标（按钮≥44 / 滑杆≥36）', mobUi.btnH >= 44 && mobUi.sliderH >= 36,
    `btn=${mobUi.btnH} slider=${mobUi.sliderH}`);

  // 移动端滚动到底部能点到「完成」
  const doneVisible = await mob.evaluate(() => {
    const panel = document.querySelector('.options-panel');
    const btn = [...panel.querySelectorAll('.mc-btn')].find((b) => b.textContent.includes('完成'));
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1;
  });
  ok('移动端「完成」可滚动到达', doneVisible);
  await mob.tap('.options-panel .mc-btn-big');
  await sleep(300);
  ok('移动端完成关闭设置页', await mob.evaluate(() => !window.__mc.hud.optionsOpen));

  // 移动端菜单入口
  await mob.evaluate(() => { [...document.querySelectorAll('.title-buttons .mc-btn')][0]?.click(); });
  await mob.waitForFunction('window.__mc.mode === "playing"', { timeout: 90000 });
  await sleep(2500);
  await mob.keyboard.press('Escape');
  await sleep(400);
  await clickText(mob, '.menu-panel .mc-btn', '设置');
  await sleep(300);
  ok('移动端菜单可进设置页', await mob.evaluate(() => window.__mc.hud.optionsOpen));
  await mob.screenshot({ path: path.join(OUT, 'options-mobile-menu.png') });

  // 横屏模式：开关可见、即时生效、持久化
  ok('设置页含「横屏模式」选项行', await mob.evaluate(() =>
    [...document.querySelectorAll('.options-panel .opt-row .opt-label')]
      .some((e) => e.textContent === '横屏模式')));
  await clickRow(mob, '横屏模式');
  await sleep(200);
  const landOn = await mob.evaluate(() => ({
    body: document.body.classList.contains('landscape-mode'),
    hud: document.querySelector('.hud-root')?.classList.contains('landscape-mode'),
    saved: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode,
    hint: getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none',
  }));
  ok('横屏模式即时挂 class 并写入 localStorage',
    landOn.body && landOn.hud && landOn.saved === true, JSON.stringify(landOn));
  ok('竖屏且锁定失败时显示旋转提示', landOn.hint, JSON.stringify(landOn));

  // 遮罩阻断时必须能主动退出
  await clickText(mob, '.rotate-hint button', '关闭横屏模式');
  await sleep(200);
  ok('「关闭横屏模式」按钮可退出遮罩', await mob.evaluate(() =>
    !document.body.classList.contains('landscape-mode') &&
    getComputedStyle(document.querySelector('.rotate-hint')).display === 'none' &&
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode === false));

  // 跨会话恢复：重新加载后设置应保留
  await mob.evaluate(() => localStorage.setItem('minecraft-ts-options-v1',
    JSON.stringify({ ...JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}'), landscapeMode: true })));
  await mob.reload({ waitUntil: 'load' });
  // boot 是 void 且首个 await 在 IndexedDB，load 事件会先到；必须等 __mc 就绪再读
  const restored = await mob.waitForFunction(
    () => !!window.__mc && document.body.classList.contains('landscape-mode'),
    { timeout: 20000 },
  ).then(() => true).catch(() => false);
  ok('横屏模式跨会话恢复', restored);

  // 重置回退到默认关闭（reload 后设置页已关闭，先重新打开）
  await clickText(mob, '.title-links .link-btn', '设置');
  await sleep(300);
  await clickText(mob, '.options-panel .options-footer .mc-btn', '重置全部设置');
  ok('重置后横屏模式回退为关闭', await mob.evaluate(() =>
    !document.body.classList.contains('landscape-mode') &&
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode === false));

  // 重置全部设置后，移动端 autoJump 应保持开启
  await clickRow(mob, '自动跳跃');            // 先关掉
  await clickText(mob, '.options-panel .options-footer .mc-btn', '重置全部设置');
  const resetAuto = await mob.evaluate(() =>
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').autoJump);
  ok('重置全部设置后移动端 autoJump 仍开启', resetAuto === true, `autoJump=${resetAuto}`);

  ok('设置页测试无运行时错误', errors.length === 0, errors.slice(0, 5).join(' | '));
  await page.close();
  await mob.close();
} catch (e) {
  ok('设置页测试脚本未崩溃', false, e.message);
} finally {
  await browser.close();
}

const failures = results.filter((r) => !r.pass).length;
fs.writeFileSync(path.join(OUT, 'options-results.json'), JSON.stringify({ results, failures, errors }, null, 2));
console.log(`\n设置页测试：${results.length - failures}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
