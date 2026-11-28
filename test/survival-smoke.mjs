/**
 * 生存模式 + 移动端 冒烟测试（无头 Chromium，软件 WebGL）
 * 用法：node test/survival-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 版本唯一来源：src/core/version.ts ↔ package.json 由 check:version 机械校验，
 *  这里只读 package.json，避免在测试里再抄一份版本字面量（抄一次就漂移一次）。 */
const URL_UNDER_TEST = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist/index.html')}`;
const CHROME =
  process.env.CHROME_PATH ??
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ??
  '/usr/local/bin/chromium';
const OUT = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(browser, mobile, url = URL_UNDER_TEST) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  if (mobile) {
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  } else {
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  }
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  // 固定种子：不同地形（悬崖/洞穴上方）会让光照增量更新的耗时差一个数量级，
  // 冒烟测试不应把随机世界当成变量。视觉回归同样使用 seed=2026。
  await page.evaluate((mobile) => {
    localStorage.clear();
    // 移动端默认横屏会在竖屏视口弹出 .rotate-hint 全屏遮罩（pointer-events:auto），
    // 挡住摇杆/挖掘/拖动视角。本用例沿用竖屏视口与既有触摸坐标，显式关掉该实验开关；
    // 横屏默认值本身由 test:options 覆盖，不在这里重复验证。
    if (mobile) localStorage.setItem('minecraft-ts-options-v1', JSON.stringify({ landscapeMode: false }));
    sessionStorage.setItem('mc-ts-new-seed', '2026');
    sessionStorage.setItem('mc-ts-new-mode', 'survival');
  }, mobile);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  await sleep(500);
  return { page, errors };
}

async function startGame(page) {
  await page.evaluate(() => window.__mc.startGame(false));
  await page.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
  await sleep(700);
}

/**
 * 渲染后端可配置：
 * - 默认 headless + SwiftShader（开发机有 GPU/ANGLE 时可用）
 * - Linux 无 GPU：MC_HEADLESS=0 MC_GL=desktop + xvfb-run（Mesa llvmpipe）
 * 这样浏览器实景测试不再被写成「本环境无法执行」，可直接进 CI。
 */
const HEADLESS = process.env.MC_HEADLESS !== '0';
// 这两个 flag 在软件渲染 / Xvfb 下是必需的：缺少 --disable-gpu-sandbox 会出现
// "BindToCurrentSequence failed"，导致 WebGL 上下文创建失败（曾误判为「环境不支持」）。
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
    '--window-size=1280,760',
  ],
});

try {
  // ============ 回归：标题 UI → 状态机 / 事件 / 流式加载 ============
  {
    const { page: uiPage } = await openPage(browser, false);
    await uiPage.click('.mode-btn[data-mode="creative"]');
    ok(
      '标题页可选择创造模式',
      await uiPage.$eval('.mode-btn[data-mode="creative"]', (el) => el.classList.contains('active')),
    );
    await uiPage.click('.title-buttons .mc-btn');
    await uiPage.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
    ok('标题选创造后进入世界即为创造模式', await uiPage.evaluate(() => window.__mc.gameMode === 'creative'));

    await uiPage.evaluate(() => {
      window.__probe = { pause: 0, hurt: 0 };
      CraftAPI.on('game:pause', () => window.__probe.pause++);
      CraftAPI.on('entity:hurt', () => window.__probe.hurt++);
    });
    await uiPage.evaluate(() => window.__mc.openMenu());
    await sleep(200);
    ok('打开菜单发出 game:pause 事件', await uiPage.evaluate(() => window.__probe.pause === 1));
    await uiPage.evaluate(() => window.__mc.resumeGame());
    await uiPage.evaluate(() => {
      const mc = window.__mc;
      if (!mc.entities.entities.length) mc.entities.spawn('pig', mc.player.pos.x + 2, mc.player.pos.y, mc.player.pos.z);
      mc.entities.entities[0].hurt(1);
    });
    await sleep(200);
    ok('实体受击发出 entity:hurt 事件', await uiPage.evaluate(() => window.__probe.hurt > 0));

    await uiPage.evaluate(() => {
      const p = window.__mc.player.pos;
      window.__mc.player.teleport(p.x + 320, p.y, p.z + 320);
    });
    // 轮询等待队列收敛，取代固定 sleep(3000)。v1.1.2 的失败源于采样过早，
    // 断言本身也不该用「睡多久」来赌时序。
    const q = await uiPage.evaluate(async () => {
      const mc = window.__mc;
      let lastGen = -1;
      let stable = 0;
      for (let i = 0; i < 75; i++) {
        const gen = mc.world.chunks.size;
        const mesh = mc.chunks.meshCount;
        const dirty = mc.world.dirty.size;
        if (dirty === 0 && mesh >= gen - 1 && gen === lastGen) {
          if (++stable >= 3) return { gen, mesh, dirty, converged: true };
        } else {
          stable = 0;
        }
        lastGen = gen;
        await new Promise((r) => setTimeout(r, 200));
      }
      return {
        gen: mc.world.chunks.size,
        mesh: mc.chunks.meshCount,
        dirty: mc.world.dirty.size,
        converged: false,
      };
    });
    ok(
      '流式加载：生成的区块都有网格且队列收敛',
      q.converged && q.gen > 0,
      `gen=${q.gen} mesh=${q.mesh} dirty=${q.dirty}`,
    );

    const terra = await uiPage.evaluate(() => {
      const biomes = new Set();
      for (let x = -160; x < 160; x += 16) {
        for (let z = -160; z < 160; z += 16) biomes.add(CraftAPI.world.biomeAt(x, z));
      }
      const info = CraftAPI.world.terrain(0, 0);
      return {
        biomes: [...biomes],
        spawnHeight: CraftAPI.world.surfaceHeight(0, 0),
        hasInfo: !!info && info.slope >= 0 && info.slope <= 1,
        spawnY: window.__mc.player.pos.y,
      };
    });
    ok('群系查询可用且地貌多样', terra.biomes.length >= 3, terra.biomes.join('/'));
    ok('terrain() 返回列信息', terra.hasInfo);
    ok('出生点是陆地', terra.spawnHeight > 30, `h=${terra.spawnHeight}`);
    await uiPage.close();
  }

  // ==================== 桌面端 ====================
  const { page, errors } = await openPage(browser, false);

  ok('标题屏渲染', await page.$eval('.title-screen', (el) => el.offsetParent !== null));
  ok('模式选择有生存/创造两个按钮', (await page.$$eval('.mode-btn', (els) => els.length)) === 2);
  ok('默认选中生存模式', await page.$eval('.mode-btn[data-mode="survival"]', (el) => el.classList.contains('active')));
  await page.screenshot({ path: path.join(OUT, 'desktop-title.png') });

  await startGame(page);

  ok('进入游戏（默认生存）', (await page.evaluate(() => window.__mc.mode)) === 'playing');
  ok('游戏模式为 survival', (await page.evaluate(() => window.__mc.survival.mode)) === 'survival');

  // ---- v1.3.0：Worker 池网格化 / Greedy Meshing ----
  const mesh = await page.evaluate(() => ({
    mode: window.__mc.chunks.mesherMode,
    workers: window.__mc.chunks.workerCount,
    greedy: window.__mc.chunks.greedy,
    stats: window.__mc.chunks.meshStats,
  }));
  ok('网格化默认在 Worker 中执行', mesh.mode === 'worker', mesh.mode);
  ok('网格化启用 Worker 池（≥1）', mesh.mode === 'worker' && mesh.workers >= 1, `workers=${mesh.workers}`);
  ok('Greedy Meshing 默认启用', mesh.greedy === true);
  ok(
    '合并已产生实际收益',
    mesh.stats.quads > 0 && mesh.stats.merged > 0,
    `quads=${mesh.stats.quads} merged=${mesh.stats.merged}`,
  );

  // ---- v1.3.2：运行时诊断组 ----
  await page.waitForFunction('window.__mc.chunks.configReady', { timeout: 15000 }).catch(() => {});
  const diag0 = await page.evaluate(() => window.CraftAPI.diagnostics.run());
  ok('运行时诊断组可用且无 error', diag0.errors === 0, diag0.issues.map((i) => `${i.id}:${i.message}`).join(' | '));
  ok('诊断 last() 返回最近一次报告', await page.evaluate(() => window.CraftAPI.diagnostics.last()?.checked > 0));

  // ---- v1.2.0 服务层 / 插件服务 实景断言 ----
  const svc = await page.evaluate(() => ({
    version: CraftAPI.version,
    services: window.__mc.services.keys(),
    plugins: CraftAPI.plugins.list().map((p) => `${p.manifest.id}:${p.state}`),
    emittedStart: CraftAPI.events.stats().emitted['game:start'] ?? 0,
  }));

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  ok('版本号单一来源与 package.json 一致', svc.version === pkgVersion, `${svc.version} / ${pkgVersion}`);
  ok(
    '服务容器注册了事件/插件/API/内置依赖',
    ['events', 'plugins', 'api', 'builtin-deps'].every((k) => svc.services.includes(k)),
    svc.services.join(','),
  );
  ok(
    '内置插件全部启用',
    ['core:autosave', 'core:hud-feedback', 'core:botany-expansion'].every((id) =>
      svc.plugins.includes(`${id}:enabled`),
    ),
    svc.plugins.join(','),
  );
  ok('事件服务记录了 game:start 派发', svc.emittedStart >= 1, `n=${svc.emittedStart}`);

  const plug = await page.evaluate(async () => {
    const before = CraftAPI.events.stats().subscribers;
    const def = {
      manifest: { id: 'test:probe', version: '1.0.0' },
      setup(ctx) {
        ctx.events.on('block:break', () => {
          window.__probeHits = (window.__probeHits || 0) + 1;
        });
      },
    };
    CraftAPI.plugins.register(def);
    await CraftAPI.plugins.enable('test:probe');
    const during = CraftAPI.events.stats().subscribers;
    CraftAPI.emit('block:break', { x: 0, y: 1, z: 0, block: 1 });
    const hits = window.__probeHits || 0;
    CraftAPI.plugins.disable('test:probe');
    const after = CraftAPI.events.stats().subscribers;
    CraftAPI.plugins.unload('test:probe');
    return { before, during, after, hits, list: CraftAPI.plugins.list().map((p) => p.manifest.id) };
  });
  ok('插件可热注册并收到事件', plug.hits === 1, JSON.stringify(plug));
  ok('插件停用后订阅自动清理', plug.after === plug.before, `${plug.before}→${plug.during}→${plug.after}`);
  ok('插件卸载后从注册表移除', !plug.list.includes('test:probe'));

  // ---- v1.3.2：运行时注册方块后 Worker 配置必须同步（Config ACK） ----
  const runtimeBlock = await page.evaluate(async () => {
    CraftAPI.registerTile('diag_probe', (set, rng) => {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) set(x, y, rng() > 0.5 ? 0xff00ff : 0x990099);
      }
    });
    const def = CraftAPI.registerBlock({
      name: 'diag_probe_block',
      label: '诊断探针方块',
      shape: 'cube',
      solid: true,
      opaque: true,
      liquid: false,
      transparentPass: false,
      lightEmission: 0,
      hardness: 1,
      sound: 'stone',
      tiles: { top: 'diag_probe', bottom: 'diag_probe', side: 'diag_probe' },
    });
    const mc = window.__mc;
    const p = mc.player.pos;
    const x = Math.floor(p.x) + 2;
    const y = Math.floor(p.y) + 5;
    const z = Math.floor(p.z);
    mc.world.setBlock(x, y, z, def.id);
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      if (mc.chunks.configReady && mc.world.dirty.size === 0 && mc.chunks.inFlightCount === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const diag = CraftAPI.diagnostics.run();
    return {
      id: def.id,
      block: mc.world.getBlock(x, y, z),
      configReady: mc.chunks.configReady,
      revision: mc.chunks.configRevisionValue,
      errors: diag.errors,
      issues: diag.issues.map((i) => `${i.id}:${i.message}`),
    };
  });
  ok(
    '运行时注册方块后 Worker 配置就绪',
    runtimeBlock.configReady && runtimeBlock.revision >= 1,
    JSON.stringify(runtimeBlock),
  );
  ok('运行时注册方块写入世界数据', runtimeBlock.block === runtimeBlock.id, JSON.stringify(runtimeBlock));
  ok('运行时诊断组在扩展后仍无 error', runtimeBlock.errors === 0, runtimeBlock.issues.join(' | '));

  // ---- v1.3.2：菜单 → 方块库 → 关闭应当回到菜单 ----
  await page.evaluate(() => window.__mc.openMenu());
  await sleep(150);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.menu-panel .menu-row .mc-btn')];
    btns.find((b) => b.textContent.includes('方块库')).click();
  });
  await sleep(150);
  const paletteFromMenu = await page.evaluate(() => ({
    open: window.__mc.hud.paletteOpen,
    menu: window.__mc.hud.menuOpen,
  }));
  // 真实指针点击（而非 DOM.click()）验证调色板条目的 pointer-events 通路
  const slotsBeforePaletteAssign = await page.evaluate(() => JSON.stringify(window.__mc.player.hotbar.slots));
  await page.click('.palette-cell');
  await sleep(150);
  ok(
    '创造/生存方块库条目可真实点击放入快捷栏',
    await page.$eval('.toast', (el) => el.textContent.includes('已放入快捷栏')),
  );
  await page.evaluate((snapshot) => {
    const mc = window.__mc;
    mc.player.hotbar.slots = JSON.parse(snapshot);
    mc.player.setHeldStack(mc.player.hotbar.slots[mc.player.hotbar.index]);
    mc.hud.updateHotbar();
  }, slotsBeforePaletteAssign);
  await page.evaluate(() => document.querySelector('.palette-close').click());
  await sleep(150);
  const afterPaletteClose = await page.evaluate(() => ({
    mode: window.__mc.mode,
    menu: window.__mc.hud.menuOpen,
    palette: window.__mc.hud.paletteOpen,
  }));
  ok(
    '菜单打开方块库后关闭返回菜单',
    paletteFromMenu.open &&
      !paletteFromMenu.menu &&
      afterPaletteClose.mode === 'paused' &&
      afterPaletteClose.menu &&
      !afterPaletteClose.palette,
    JSON.stringify({ paletteFromMenu, afterPaletteClose }),
  );
  await page.evaluate(() => window.__mc.resumeGame());

  await sleep(200);

  ok(
    '生命/饥饿 HUD 可见',
    await page.$eval('.stats-wrap', (el) => el.style.display !== 'none' && el.offsetParent !== null),
  );
  ok(
    '心形与鸡腿各 10 格',
    (await page.$$eval('.stat-heart .stat-pip', (e) => e.length)) === 10 &&
      (await page.$$eval('.stat-hunger .stat-pip', (e) => e.length)) === 10,
  );
  ok('新手补给苹果在背包', await page.evaluate(() => window.__mc.survival.countKey('i:apple') === 2));
  ok('手持物品为苹果（扁平精灵）', await page.evaluate(() => window.__mc.player.selectedStack()?.kind === 'item'));
  ok('快捷栏渲染物品数量', (await page.$eval('.hotbar-slot .slot-count', (el) => el.textContent)) === '2');

  // ---- BugFix：快捷栏槽位（div）必须可命中，且不能让全屏 HUD 吞掉 canvas 点击 ----
  const slotHit = await page.evaluate(() => {
    const slot = document.querySelectorAll('.hotbar-slot')[3];
    const r = slot.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      pointer: getComputedStyle(slot).pointerEvents,
      hud: getComputedStyle(document.querySelector('.game-hud')).pointerEvents,
      hotbar: getComputedStyle(document.querySelector('.hotbar')).pointerEvents,
      hit: !!hit && (hit === slot || slot.contains(hit)),
      center: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName ?? null,
    };
  });
  ok(
    '快捷栏槽位 pointer-events:auto 且命中自身',
    slotHit.pointer === 'auto' && slotHit.hit && slotHit.hud === 'none' && slotHit.hotbar === 'none',
    JSON.stringify(slotHit),
  );
  ok('游戏画面中心仍命中 canvas（HUD 未吞掉点击）', slotHit.center === 'CANVAS', String(slotHit.center));

  const slotBefore = await page.evaluate(() => window.__mc.player.hotbar.index);
  await page.evaluate(() => {
    const slot = document.querySelectorAll('.hotbar-slot')[3];
    slot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
  });
  await sleep(120);
  ok('点击快捷栏槽位可切换手持物品', await page.evaluate(() => window.__mc.player.hotbar.index === 3));

  await page.keyboard.press('Digit7');
  const digitOk = await page
    .waitForFunction(() => window.__mc.player.hotbar.index === 6, { timeout: 5000, polling: 50 })
    .then(() => true)
    .catch(() => false);
  ok('数字键 1-9 仍可切槽', digitOk);
  await page.evaluate(() => {
    document.querySelector('#app canvas').dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const wheelOk = await page
    .waitForFunction(() => window.__mc.player.hotbar.index === 5, { timeout: 5000, polling: 50 })
    .then(() => true)
    .catch(() => false);
  ok('滚轮仍可切槽', wheelOk);
  await page.evaluate((i) => window.__mc.selectSlot(i), slotBefore);

  // 移动
  const p0 = await page.evaluate(() => ({ ...window.__mc.player.pos }));
  await page.keyboard.down('KeyW');
  let moveDist = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const p = await page.evaluate(() => ({ ...window.__mc.player.pos }));
    moveDist = Math.hypot(p.x - p0.x, p.z - p0.z);
    if (moveDist > 0.7) break;
  }
  await page.keyboard.up('KeyW');
  ok('键盘移动生效', moveDist > 0.7, `位移 ${moveDist.toFixed(2)}`);

  // ---- v1.3.2：输入禁用期间的 keyup 不能丢失 ----
  await page.keyboard.down('KeyW');
  await sleep(120);
  await page.evaluate(() => {
    window.__mc.input.enabled = false;
  });
  await page.keyboard.up('KeyW');
  const stuckKeys = await page.evaluate(() => {
    const keys = [...window.__mc.input.pressedKeys];
    window.__mc.input.enabled = true;
    return keys;
  });
  ok('输入禁用期间 keyup 仍会清理按键', stuckKeys.length === 0, stuckKeys.join(','));

  // ---- 摄影模式（P）：暂停态不可进入 / 冻结玩家 / 同帧 PNG ----
  await page.evaluate(() => window.__mc.openMenu());
  await page.keyboard.press('KeyP');
  await sleep(150);
  const pausedPhoto = await page.evaluate(() => ({
    active: CraftAPI.photo.active,
    display: getComputedStyle(document.querySelector('#photo-overlay')).display,
    mode: window.__mc.mode,
  }));
  ok(
    '暂停态按 P 不进入摄影模式',
    !pausedPhoto.active && pausedPhoto.display === 'none' && pausedPhoto.mode === 'paused',
    JSON.stringify(pausedPhoto),
  );
  await page.evaluate(() => window.__mc.resumeGame());
  await sleep(150);

  await page.keyboard.press('KeyP');
  await page.waitForFunction('CraftAPI.photo.active === true', { timeout: 10000 }).catch(() => {});
  // 基线必须在摄影模式已激活后取：按 P 与 waitForFunction 之间仍会跑正常游戏帧，
  // 若拿按键前的状态做基线，重力/时间推进会被误判成摄影预览的污染。
  // 时刻/天数直接用 PhotoMode 进入时冻结的快照，与 collectSave 的口径一致。
  const beforePhoto = await page.evaluate(() => ({
    dayTime: CraftAPI.photo.savedDayTime ?? window.__mc.sky.dayTime,
    dayCount: CraftAPI.photo.savedDayCount ?? window.__mc.sky.dayCount,
    pos: { ...window.__mc.player.pos },
    cam: { ...window.__mc.engine.camera.position },
  }));
  const inPhoto = await page.evaluate(() => {
    const overlay = document.querySelector('#photo-overlay');
    const style = getComputedStyle(overlay);
    const info = overlay.querySelector('.photo-info').getBoundingClientRect();
    const hints = overlay.querySelector('.photo-hints').getBoundingClientRect();
    return {
      active: CraftAPI.photo.active,
      display: style.display,
      flexDirection: style.flexDirection,
      justifyContent: style.justifyContent,
      hintsBelowInfo: hints.top > info.bottom,
      visible: overlay.offsetParent !== null,
      hudHidden: document.querySelector('.game-hud').classList.contains('hud-hidden'),
      owner: window.__mc.engine.cameraOwner,
    };
  });
  ok(
    '按 P 进入摄影模式：覆盖层可见 / HUD 隐藏 / 相机归属 photo',
    inPhoto.active && inPhoto.visible && inPhoto.display !== 'none' && inPhoto.hudHidden && inPhoto.owner === 'photo',
    JSON.stringify(inPhoto),
  );
  ok(
    '摄影覆盖层 flex 生效：上下分栏且操作提示在底部',
    inPhoto.display === 'flex' &&
      inPhoto.flexDirection === 'column' &&
      inPhoto.justifyContent === 'space-between' &&
      inPhoto.hintsBelowInfo,
    JSON.stringify(inPhoto),
  );

  // 按住 W：玩家绝不能移动（否则会标脏、挪动区块中心、污染存档坐标），相机应自由平移
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 6; i++) await sleep(150);
  await page.keyboard.up('KeyW');
  const photoMove = await page.evaluate((before) => {
    const p = window.__mc.player.pos;
    const c = window.__mc.engine.camera.position;
    return {
      player: Math.hypot(p.x - before.pos.x, p.z - before.pos.z),
      camera: Math.hypot(c.x - before.cam.x, c.z - before.cam.z),
    };
  }, beforePhoto);
  ok('摄影模式冻结玩家坐标', photoMove.player < 1e-6, `位移 ${photoMove.player}`);
  ok('摄影模式自由相机可平移', photoMove.camera > 0.5, `位移 ${photoMove.camera.toFixed(2)}`);

  // sky.update 无条件推进 localTime：即使 dayTime 冻结，dayCount 也会跨日。
  // 手动推进超过一整天，验证 collectSave 暴露的 dayCount/dayTime 仍是进入前快照。
  const savePreview = await page.evaluate((before) => {
    const sky = window.__mc.sky;
    sky.update(sky.dayLength + 1, 0);
    const data = CraftAPI.save.export();
    return {
      liveDayCount: sky.dayCount,
      savedDayCount: data.dayCount,
      savedDayTime: data.dayTime,
      beforeDayCount: before.dayCount,
      beforeDayTime: before.dayTime,
    };
  }, beforePhoto);
  ok(
    '摄影跨日后 collectSave 的 dayCount/dayTime 仍取进入前快照',
    savePreview.liveDayCount === savePreview.beforeDayCount + 1 &&
      savePreview.savedDayCount === savePreview.beforeDayCount &&
      Math.abs(savePreview.savedDayTime - savePreview.beforeDayTime) < 1e-9,
    JSON.stringify(savePreview),
  );

  await page.evaluate(() => {
    CraftAPI.photo.lastDataUrl = '';
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction('CraftAPI.photo.lastDataUrl.length > 0', { timeout: 10000 }).catch(() => {});
  const shot = await page.evaluate(async () => {
    const url = CraftAPI.photo.lastDataUrl || '';
    const png = url.startsWith('data:image/png;base64');
    if (!png) return { prefix: url.slice(0, 32), png, colors: 0, length: url.length };
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { prefix: url.slice(0, 22), png, colors: colors.size, length: url.length };
  });
  ok('摄影模式回车导出非空 PNG 截图', shot.png && shot.colors > 1 && shot.length > 2000, JSON.stringify(shot));

  await page.keyboard.press('KeyP');
  await page.waitForFunction('CraftAPI.photo.active === false', { timeout: 10000 }).catch(() => {});
  const afterPhoto = await page.evaluate(
    (before) => ({
      active: CraftAPI.photo.active,
      display: getComputedStyle(document.querySelector('#photo-overlay')).display,
      owner: window.__mc.engine.cameraOwner,
      hudHidden: document.querySelector('.game-hud').classList.contains('hud-hidden'),
      timeDelta: Math.abs(window.__mc.sky.dayTime - before.dayTime),
      dayCountDelta: window.__mc.sky.dayCount - before.dayCount,
      posDelta: Math.hypot(window.__mc.player.pos.x - before.pos.x, window.__mc.player.pos.z - before.pos.z),
    }),
    beforePhoto,
  );
  ok(
    '按 P 退出摄影模式：覆盖层隐藏 / 相机与 HUD 恢复',
    !afterPhoto.active && afterPhoto.display === 'none' && afterPhoto.owner === null && !afterPhoto.hudHidden,
    JSON.stringify(afterPhoto),
  );
  ok(
    '摄影预览未污染时刻、天数与玩家坐标',
    afterPhoto.timeDelta < 0.01 && afterPhoto.dayCountDelta === 0 && afterPhoto.posDelta < 1e-6,
    `dt=${afterPhoto.timeDelta} dd=${afterPhoto.dayCountDelta} dp=${afterPhoto.posDelta}`,
  );
  await page.evaluate(() => {
    CraftAPI.photo.lastDataUrl = '';
  });

  // ---- 摄影常驻入口（触控可点）与真实 Esc 不被伪 pause 吞掉 ----
  const enterBtn = await page.evaluate(() => {
    const el = document.querySelector('#photo-enter');
    return el ? { display: getComputedStyle(el).display, label: el.getAttribute('aria-label') } : null;
  });
  ok('摄影模式常驻入口按钮在游戏中可见', !!enterBtn && enterBtn.display !== 'none', JSON.stringify(enterBtn));
  await page.evaluate(() => document.querySelector('#photo-enter').click());
  await page.waitForFunction('CraftAPI.photo.active === true', { timeout: 10000 }).catch(() => {});
  const viaButton = await page.evaluate(() => ({
    active: CraftAPI.photo.active,
    owner: window.__mc.engine.cameraOwner,
  }));
  ok('点击常驻入口进入摄影模式', viaButton.active && viaButton.owner === 'photo', JSON.stringify(viaButton));
  await page.keyboard.press('Escape');
  await page.waitForFunction('CraftAPI.photo.active === false', { timeout: 10000 }).catch(() => {});
  const escaped = await page.evaluate(() => ({
    active: CraftAPI.photo.active,
    mode: window.__mc.mode,
    menu: window.__mc.hud.menuOpen,
  }));
  ok(
    'Esc 退出摄影模式且不开暂停菜单（伪 pause 不吞真实 Esc）',
    !escaped.active && escaped.mode === 'playing' && !escaped.menu,
    JSON.stringify(escaped),
  );

  // ---- JEI 面板在输入禁用期间仍能按 J 关闭 ----
  await page.evaluate(() => window.__mc.jeiOpen());
  const jeiOpened = await page.evaluate(() => window.__mc.jeiIsOpen());
  ok('JEI 面板可打开', jeiOpened === true, String(jeiOpened));
  await page.keyboard.press('KeyJ');
  await sleep(100);
  const jeiClosed = await page.evaluate(() => window.__mc.jeiIsOpen());
  ok('JEI 面板内按 J 可关闭（禁用输入下 jei 边沿仍上报）', jeiClosed === false, String(jeiClosed));

  // ---- 挖掘：在正前方 3 格处强制放一块石头并瞄准 ----
  const mineCell = await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    // 与眼睛同高、正前方 3 格：水平射线不会被地形/树冠干扰
    // （v1.1.2 把方块放在脚下高度，实际准星打到下方地面，断言却读了上一帧的旧 target）
    const x = Math.floor(p.x),
      y = Math.floor(p.y + 1.62),
      z = Math.floor(p.z) - 3;
    const stone = mc.registry.byNameGet('stone').id;
    for (let dz = 1; dz <= 3; dz++) mc.world.setBlock(x, y, Math.floor(p.z) - dz, 0);
    mc.world.setBlock(x, y, z, stone);
    return { x, y, z };
  });
  await sleep(150);
  await page.evaluate((c) => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const ex = p.x,
      ey = p.y + 1.62,
      ez = p.z;
    const dx = c.x + 0.5 - ex,
      dy = c.y + 0.5 - ey,
      dz = c.z + 0.5 - ez;
    mc.player.yaw = Math.atan2(-dx, -dz);
    mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    // 立即重算准星，避免「准星命中」断言读到设置视角之前的旧值
    mc.player.update(0.016);
  }, mineCell);
  // 轮询等待而不是固定 sleep：整套 verify 高负载下渲染帧可能延迟，
  // 单帧读取容易拿到设置视角之前的旧 target（历史 flake）
  const aim = await page
    .waitForFunction(
      (c) => {
        const t = window.__mc.player.target;
        return t && t.x === c.x && t.y === c.y && t.z === c.z
          ? { x: t.x, y: t.y, z: t.z, name: window.__mc.registry.get(t.block).name }
          : null;
      },
      { timeout: 8000 },
      mineCell,
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  ok(
    '准星命中测试方块',
    !!aim && aim.x === mineCell.x && aim.y === mineCell.y && aim.z === mineCell.z,
    aim ? `${aim.name}@${aim.x},${aim.y},${aim.z}` : 'null',
  );

  // 指针锁已激活时不要再移动鼠标：page.mouse.move 会作为 movementX 进入视角，
  // 把准星转走（真实玩家不会在锁定时做绝对坐标跳转）。
  await page.bringToFront();
  await page.evaluate(() => document.querySelector('#app canvas')?.focus());
  const lockedBeforeMine = await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas'));
  if (!lockedBeforeMine) await page.mouse.move(640, 380);
  await page.mouse.down({ button: 'left' });
  // Xvfb / 无头切换窗口焦点后偶尔丢首个 pointerdown：等到挖掘真正开始，必要时重按一次。
  let miningStarted = await page
    .waitForFunction(
      (c) => window.__mc.player.miningProgress > 0 || window.__mc.world.getBlock(c.x, c.y, c.z) === 0,
      { timeout: 5000, polling: 50 },
      mineCell,
    )
    .then(() => true)
    .catch(() => false);
  if (!miningStarted) {
    await page.mouse.up({ button: 'left' });
    await page.mouse.move(640, 380);
    await page.mouse.down({ button: 'left' });
    await page
      .waitForFunction(
        (c) => window.__mc.player.miningProgress > 0 || window.__mc.world.getBlock(c.x, c.y, c.z) === 0,
        { timeout: 5000, polling: 50 },
        mineCell,
      )
      .then(() => {
        miningStarted = true;
      })
      .catch(() => {});
  }
  // 指针锁定生效的瞬间，Chromium 可能补发合成 movement；按住期间持续校正准星，
  // 避免「读断言时还对准、真正挖掘时已经转走」的时序问题。
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const aimDrift = await page.evaluate((c) => {
      const t = window.__mc.player.target;
      return !t || t.x !== c.x || t.y !== c.y || t.z !== c.z;
    }, mineCell);
    if (!aimDrift) break;
    await page.evaluate((c) => {
      const mc = window.__mc;
      const p = mc.player.pos;
      const dx = c.x + 0.5 - p.x,
        dy = c.y + 0.5 - (p.y + 1.62),
        dz = c.z + 0.5 - p.z;
      mc.player.yaw = Math.atan2(-dx, -dz);
      mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      mc.player.update(0.016);
      mc.input.consumeLook();
    }, mineCell);
  }
  let midProgress = null;
  let sawMid = false;
  let barVisible = false;
  let brokenId = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const st = await page.evaluate(
      (c) => ({
        progress: window.__mc.player.miningProgress,
        block: window.__mc.world.getBlock(c.x, c.y, c.z),
      }),
      mineCell,
    );
    if (typeof st.progress === 'number' && st.progress > 0.25 && st.progress < 1) {
      midProgress = st.progress;
      if (!sawMid) {
        sawMid = true;
        barVisible = await page.$eval('.mining-bar', (el) => el.style.display !== 'none');
        await page.screenshot({ path: path.join(OUT, 'desktop-mining.png') });
      }
    }
    if (st.block === 0) {
      brokenId = 0;
      break;
    }
  }
  // 软件渲染下 FPS 可能只有 10，而引擎把 dt 钳制到 0.05（防穿墙），
  // 游戏时间流速约为真实的一半。固定循环次数会差最后一帧，
  // 这里补一段「按条件轮询」的等待，而不是继续赌 sleep 时长。
  if (brokenId !== 0) {
    const broke = await page
      .waitForFunction(
        (c) => window.__mc.world.getBlock(c.x, c.y, c.z) === 0,
        { timeout: 20000, polling: 100 },
        mineCell,
      )
      .then(() => true)
      .catch(() => false);
    if (broke) brokenId = 0;
  }
  await page.mouse.up({ button: 'left' });
  await sleep(250);
  ok('挖掘进度累积（非瞬间破坏）', sawMid, `progress=${midProgress}`);
  ok('挖掘进度条可见', barVisible);
  if (brokenId !== 0) brokenId = await page.evaluate((c) => window.__mc.world.getBlock(c.x, c.y, c.z), mineCell);
  ok('生存模式按住可破坏方块', brokenId === 0, `block=${brokenId}`);
  // 可见掉落物有 1.2 格拾取半径与 0.4s 游戏时间的拾取延迟；石头在正前方 3 格，
  // 玩家原地不动永远不会拾取。先走到落点，再按条件轮询（软件渲染下游戏时间约
  // 为真实一半，固定 sleep 会偶发抢在拾取之前）。
  await page.evaluate((c) => window.__mc.player.teleport(c.x + 0.5, c.y, c.z + 0.5), mineCell);
  const cobbleId = await page.evaluate(() => window.__mc.registry.byNameGet('cobblestone').id);
  // Xvfb + llvmpipe 下帧率可能低于 10，固定位置 + 8s 超时仍会偶发错过拾取。
  // 等掉落物实体真正出现后直接传送到其实体坐标，再轮询入包，验证的是拾取语义而不是时序运气。
  await page
    .waitForFunction(
      () =>
        window.__mc.drops.items.length > 0 ||
        window.__mc.survival.countKey('b:' + window.__mc.registry.byNameGet('cobblestone').id) >= 1,
      { timeout: 20000, polling: 100 },
    )
    .catch(() => {});
  const dropPos = await page.evaluate(() => {
    const item = window.__mc.drops.items.find((d) => d.name === 'cobblestone');
    return item ? { x: item.pos.x, y: item.pos.y, z: item.pos.z } : null;
  });
  if (dropPos) await page.evaluate((p) => window.__mc.player.teleport(p.x, p.y, p.z), dropPos);
  const gotCobble = await page
    .waitForFunction((id) => window.__mc.survival.countKey('b:' + id) >= 1, { timeout: 20000, polling: 100 }, cobbleId)
    .then(() => true)
    .catch(() => false);
  ok('石头掉落为圆石', gotCobble, dropPos ? `drop=${JSON.stringify(dropPos)}` : 'no-drop');
  ok(
    '掉落自动补进快捷栏',
    await page.evaluate(
      (id) => window.__mc.player.hotbar.slots.some((s) => s && s.kind === 'block' && s.id === id),
      cobbleId,
    ),
  );

  // ---- 放置：瞄准 3 格外的方块顶面，放下泥土 ----
  console.log('[smoke] placement setup');
  const placeSetup = await page.evaluate(() => {
    const mc = window.__mc;
    const dirt = mc.registry.byNameGet('dirt').id;
    mc.survival.addBlock(dirt, 3);
    const slot = mc.player.hotbar.slots.indexOf(null);
    mc.player.hotbar.slots[slot] = { kind: 'block', id: dirt };
    mc.selectSlot(slot);
    const p = mc.player.pos;
    const x = Math.floor(p.x) + 2,
      y = Math.floor(p.y),
      z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
    return { x, y, z, dirt, slot };
  });
  await sleep(150);
  await page.evaluate((c) => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const ex = p.x,
      ey = p.y + 1.62,
      ez = p.z;
    const dx = c.x + 0.5 - ex,
      dy = c.y + 1.0 - ey,
      dz = c.z + 0.5 - ez;
    mc.player.yaw = Math.atan2(-dx, -dz);
    mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, placeSetup);
  await sleep(250);
  const placeTarget = await page.evaluate(() => {
    const t = window.__mc.player.target;
    return t ? { x: t.x, y: t.y, z: t.z, nx: t.nx, ny: t.ny, nz: t.nz } : null;
  });
  ok('瞄准方块顶面', !!placeTarget && placeTarget.ny === 1, JSON.stringify(placeTarget));
  const dirtBefore = await page.evaluate((d) => window.__mc.survival.countKey('b:' + d), placeSetup.dirt);
  const placedCell = { x: placeTarget.x + placeTarget.nx, y: placeTarget.y + 1, z: placeTarget.z + placeTarget.nz };
  let placed = { direct: 0, lastKey: null, lastId: 0 };
  // 每次放置前重新对准并清掉残留 look delta；最多重试 3 次，
  // 兼容指针锁合成 movement 造成的首次点击落空。
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((c) => {
      const mc = window.__mc;
      const p = mc.player.pos;
      const dx = c.x + 0.5 - p.x,
        dy = c.y + 1.0 - (p.y + 1.62),
        dz = c.z + 0.5 - p.z;
      mc.player.yaw = Math.atan2(-dx, -dz);
      mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      mc.input.consumeLook();
    }, placeSetup);
    await sleep(120);
    await page.mouse.down({ button: 'right' });
    await sleep(280);
    await page.mouse.up({ button: 'right' });
    await sleep(300);
    // 指针锁合成移动可能让实际放置格偏移 1 格；以世界差分里最后一次 dirt 编辑为准，
    // 同时保留目标格的直读值用于诊断。
    placed = await page.evaluate(
      ({ dirt, cell }) => {
        let lastKey = null;
        for (const [k, v] of window.__mc.world.edits) if (v === dirt) lastKey = k;
        let lastId = 0;
        if (lastKey) {
          const [x, y, z] = lastKey.split(',').map(Number);
          lastId = window.__mc.world.getBlock(x, y, z);
        }
        return {
          direct: window.__mc.world.getBlock(cell.x, cell.y, cell.z),
          lastKey,
          lastId,
        };
      },
      { dirt: placeSetup.dirt, cell: placedCell },
    );
    console.log('[smoke] placement attempt', attempt, placed.lastKey, placed.direct);
    if (placed.direct === placeSetup.dirt || placed.lastId === placeSetup.dirt) break;
  }
  const dirtAfter = await page.evaluate((d) => window.__mc.survival.countKey('b:' + d), placeSetup.dirt);
  ok(
    '生存模式放置方块',
    placed.direct === placeSetup.dirt || placed.lastId === placeSetup.dirt,
    `direct=${placed.direct} edit=${placed.lastKey}:${placed.lastId} want=${placeSetup.dirt}`,
  );
  // 按住右键 280ms 跨过 placeTimer=0.24s 的连放窗口时可能连放 2 次，
  // 因此这里只断言「确实消耗了背包方块」，连放本身是预期行为。
  ok('放置消耗背包方块', dirtAfter < dirtBefore && dirtAfter >= dirtBefore - 3, `${dirtBefore}→${dirtAfter}`);

  // ---- 目标格已是同一方块：不应白扣背包（v1.3.1 修复） ----
  // 火把 / 草丛是非实心方块，existing.solid 拦不住，而 setBlock 对同 id 返回 false，
  // 先扣后放就会吞掉背包。这里直接驱动 doPlace，不依赖鼠标与帧时长。
  const samePlace = await page.evaluate(() => {
    const mc = window.__mc;
    const stone = mc.registry.byNameGet('stone').id;
    const torch = mc.registry.byNameGet('torch').id;
    mc.survival.addBlock(torch, 2);
    const slot = mc.player.hotbar.slots.indexOf(null);
    mc.player.hotbar.slots[slot] = { kind: 'block', id: torch };
    mc.selectSlot(slot);
    const p = mc.player.pos;
    const x = Math.floor(p.x) + 2,
      y = Math.floor(p.y),
      z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, stone, false);
    mc.world.setBlock(x, y + 1, z, torch, false);
    const before = mc.survival.countKey('b:' + torch);
    mc.player.target = { x, y, z, nx: 0, ny: 1, nz: 0, block: stone, dist: 0.8 };
    mc.player.doPlace();
    const after = mc.survival.countKey('b:' + torch);
    const cell = mc.world.getBlock(x, y + 1, z);
    mc.player.target = null;
    return { before, after, cell, torch };
  });
  ok(
    '重复放置同一方块不白扣背包',
    samePlace.cell === samePlace.torch && samePlace.after === samePlace.before,
    `${samePlace.before}→${samePlace.after} cell=${samePlace.cell} want=${samePlace.torch}`,
  );

  // ---- 伤害 / 死亡 / 重生 ----
  await page.evaluate(() => window.__mc.survival.damage(6, '测试伤害'));
  await sleep(300);
  ok('受到伤害扣血', await page.evaluate(() => window.__mc.survival.health === 14));
  ok('受伤红屏触发', await page.$eval('.hurt-flash', (el) => el.classList.contains('go')));
  await page.evaluate(() => {
    const iv = setInterval(() => {
      if (window.__mc.mode === 'dead') {
        clearInterval(iv);
        return;
      }
      window.__mc.survival.damage(30, '测试致死');
    }, 120);
    setTimeout(() => clearInterval(iv), 6000);
  });
  await page.waitForFunction('window.__mc.mode === "dead"', { timeout: 6000 }).catch(() => {});
  ok('生命归零进入死亡状态', (await page.evaluate(() => window.__mc.mode)) === 'dead');
  ok('死亡界面显示', await page.$eval('.death-overlay', (el) => el.style.display !== 'none'));
  ok('死亡原因展示', (await page.$eval('.death-cause', (el) => el.textContent)).includes('测试致死'));
  await page.screenshot({ path: path.join(OUT, 'desktop-death.png') });

  await page.click('.death-actions .mc-btn-big');
  await sleep(900);
  ok('点击重生回到游戏', (await page.evaluate(() => window.__mc.mode)) === 'playing');
  ok('重生后满血', await page.evaluate(() => window.__mc.survival.health === 20));
  ok('重生后保留背包', (await page.evaluate(() => window.__mc.survival.inventory.size)) > 0);
  ok('重生后清空饥饿压力', await page.evaluate(() => window.__mc.survival.hunger > 0));

  // ---- 进食 ----
  await page.evaluate(() => {
    const mc = window.__mc;
    mc.survival.hunger = 8;
    mc.survival.saturation = 0; // 基线清零，确保「上升」断言不是恒真
    const appleSlot = mc.player.hotbar.slots.findIndex((s) => s && s.kind === 'item' && s.id === 'apple');
    if (appleSlot >= 0) mc.selectSlot(appleSlot);
  });
  await sleep(200);
  const appleBefore = await page.evaluate(() => window.__mc.survival.countKey('i:apple'));
  await page.mouse.down({ button: 'right' });
  await sleep(250);
  await page.mouse.up({ button: 'right' });
  await sleep(350);
  const hungerNow = await page.evaluate(() => window.__mc.survival.hunger);
  const satNow = await page.evaluate(() => window.__mc.survival.saturation);
  const appleAfter = await page.evaluate(() => window.__mc.survival.countKey('i:apple'));
  ok('吃苹果恢复饥饿', hungerNow > 8, `hunger=${hungerNow}`);
  ok('进食提升饱和度', satNow > 0 && satNow <= hungerNow, `saturation=${satNow}`);
  ok('进食消耗苹果', appleAfter === appleBefore - 1 || appleBefore === 0, `${appleBefore}→${appleAfter}`);

  // ---- 火光与饥饿端到端（v1.5.3）----
  // 火焰灼烧：脚下放火，关闭蔓延（只验伤害，不点燃地形），轮询等待掉血
  let fireSetup;
  {
    fireSetup = await page.evaluate(() => {
      const mc = window.__mc;
      const fireEnabled = mc.fire.enabled;
      mc.fire.enabled = false;
      const p = mc.player.pos;
      const x = Math.floor(p.x),
        y = Math.floor(p.y),
        z = Math.floor(p.z);
      const stone = mc.registry.byNameGet('stone').id;
      const fire = mc.registry.byNameGet('fire').id;
      mc.world.setBlock(x, y - 1, z, stone, false);
      mc.world.setBlock(x, y, z, fire, false);
      return { x, y, z, health: mc.survival.health, fireEnabled };
    });
    const burned = await page
      .waitForFunction((c) => window.__mc.survival.health < c.health, { timeout: 8000, polling: 100 }, fireSetup)
      .then(() => true)
      .catch(() => false);
    const healthAfterFire = await page.evaluate(() => window.__mc.survival.health);
    ok('火焰灼烧：站火上持续掉血', burned, `${fireSetup.health}→${healthAfterFire}`);
    await page.evaluate((c) => {
      const mc = window.__mc;
      mc.world.setBlock(c.x, c.y, c.z, 0, false);
    }, fireSetup);
    // 补回火焰测试造成的掉血，避免把后续「僵尸能攻击玩家」的基线压低成恒真
    await page.evaluate(() => window.__mc.survival.heal(20));
  }

  // 温暖：附近放营火 → 上升；传送远离 → 下降
  // 放在熔炉之前：熔炉燃烧时也是热源，若先做熔炉，温暖基线会被抬高导致「上升」断言失真
  {
    const warmSetup = await page.evaluate(() => {
      const mc = window.__mc;
      const p = mc.player.pos;
      const x = Math.floor(p.x) + 2,
        y = Math.floor(p.y),
        z = Math.floor(p.z);
      mc.world.setBlock(x, y, z, mc.registry.byNameGet('campfire').id, false);
      return { x, y, z, ox: p.x, oy: p.y, oz: p.z, warmth: mc.survival.warmth };
    });
    const riseTo = Math.max(20, warmSetup.warmth + 10);
    const rose = await page
      .waitForFunction((t) => window.__mc.survival.warmth > t, { timeout: 15000, polling: 100 }, riseTo)
      .then(() => true)
      .catch(() => false);
    const peak = await page.evaluate(() => window.__mc.survival.warmth);
    ok('温暖：靠近营火上升', rose, `${warmSetup.warmth}→${peak}（阈值 ${riseTo}）`);
    // 传送到 24 格外（渲染距离内，地面已加载），远离热源后等待下降
    await page.evaluate((w) => window.__mc.player.teleport(w.ox + 24, w.oy, w.oz), warmSetup);
    const fell = await page
      .waitForFunction((p) => window.__mc.survival.warmth < p * 0.5, { timeout: 20000, polling: 100 }, peak)
      .then(() => true)
      .catch(() => false);
    const low = await page.evaluate(() => window.__mc.survival.warmth);
    ok('温暖：远离热源下降', fell, `${peak}→${low}`);
    await page.evaluate(
      (w, fireEnabled) => {
        const mc = window.__mc;
        mc.world.setBlock(w.x, w.y, w.z, 0, false);
        mc.player.teleport(w.ox, w.oy, w.oz);
        mc.fire.enabled = fireEnabled;
      },
      warmSetup,
      fireSetup.fireEnabled,
    );
    await sleep(200);
  }

  // 熔炉产出：放熔炉 + 燃料 + 生食，等待烤熟（远端 Smelting：putFuelFrom / putInput）
  {
    const furnaceSetup = await page.evaluate(() => {
      const mc = window.__mc;
      const p = mc.player.pos;
      const x = Math.floor(p.x) + 2,
        y = Math.floor(p.y),
        z = Math.floor(p.z);
      mc.world.setBlock(x, y, z, mc.registry.byNameGet('furnace').id, false);
      mc.survival.addItem('coal', 1);
      mc.survival.addItem('beef', 1);
      const fuelOk = mc.smelting.putFuelFrom(mc.survival, x, y, z, 'coal', 1, { kind: 'item', id: 'coal' });
      const inputOk = mc.smelting.putInput(mc.survival, x, y, z, 'beef', 1, { kind: 'item', id: 'beef' });
      return { x, y, z, fuelOk, inputOk };
    });
    const cooked = await page
      .waitForFunction(
        (c) => window.__mc.smelting.cell(c.x, c.y, c.z).output?.material === 'cooked_beef',
        { timeout: 60000, polling: 250 },
        furnaceSetup,
      )
      .then(() => true)
      .catch(() => false);
    const out = await page.evaluate((c) => window.__mc.smelting.cell(c.x, c.y, c.z).output ?? null, furnaceSetup);
    ok(
      '熔炉产出熟食',
      cooked && furnaceSetup.fuelOk && furnaceSetup.inputOk,
      `output=${out ? `${out.material}x${out.count}` : 'null'}`,
    );
    await page.evaluate((c) => {
      const mc = window.__mc;
      mc.smelting.takeOutput(mc.survival, c.x, c.y, c.z);
      mc.world.setBlock(c.x, c.y, c.z, 0, false);
    }, furnaceSetup);
  }

  // ---- 夜晚 + 僵尸 ----
  await page.evaluate(() => {
    const mc = window.__mc;
    mc.sky.dayTime = 0.82;
    const p = mc.player.pos;
    mc.entities.spawn('zombie', p.x + 0.9, p.y, p.z);
  });
  await sleep(600);
  ok('夜间存在敌对生物', await page.evaluate(() => window.__mc.entities.entities.some((e) => e.type.hostile)));
  let hpAfterZombie = 20;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    hpAfterZombie = await page.evaluate(() => window.__mc.survival.health);
    if (hpAfterZombie < 20) break;
  }
  ok('僵尸能攻击玩家', hpAfterZombie < 20, `health=${hpAfterZombie}`);
  ok('日照强度随夜晚下降', await page.evaluate(() => window.__mc.sky.daylight < 0.4));

  // ---- 合成界面（v1.5.0）：背包取料 → 合成 → 产出 ----
  {
    await page.evaluate(() => {
      const mc = window.__mc;
      mc.survival.addBlock(mc.registry.byNameGet('oak_log').id, 1);
      mc.openCrafting('game');
    });
    await page.waitForSelector('.crafting-overlay', { timeout: 8000 });
    ok('合成界面可打开', await page.$eval('.crafting-overlay', (el) => el.style.display !== 'none'));
    ok('合成界面是 3×3 网格', await page.$eval('.crafting-grid', (el) => el.dataset.size === '3'));
    ok('配方列表非空', (await page.$$eval('.crafting-recipe', (e) => e.length)) >= 5);

    // 点「橡木木板」配方自动摆放，再点结果槽合成
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.crafting-recipe')];
      rows.find((r) => r.textContent.includes('橡木木板')).click();
    });
    await sleep(200);
    ok('自动摆放把原木放进格子', (await page.$$eval('.crafting-cell img', (e) => e.length)) === 1);
    ok('结果槽显示可合成产物', (await page.$$eval('.crafting-result.ready', (e) => e.length)) === 1);

    await page.click('.crafting-result');
    await sleep(250);
    const craft = await page.evaluate(() => ({
      planks: window.__mc.survival.countKey('b:' + window.__mc.registry.byNameGet('oak_planks').id),
      logs: window.__mc.survival.countKey('b:' + window.__mc.registry.byNameGet('oak_log').id),
    }));
    ok('合成产出 4 橡木木板', craft.planks === 4, `count=${craft.planks}`);
    ok('原木被消耗', craft.logs === 0, `count=${craft.logs}`);

    // 真实指针点击背包条目 / 合成格（不是 DOM.click()），覆盖「背包点不动」的另一种解释
    const chipPos = await page.evaluate(() => {
      const el = document.querySelector('.crafting-chip');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(chipPos.x, chipPos.y);
    await sleep(150);
    ok('合成背包条目真实点击可放入格子', (await page.$$eval('.crafting-cell img', (e) => e.length)) === 1);
    const cellPos = await page.evaluate(() => {
      const el = document.querySelector('.crafting-cell');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(cellPos.x, cellPos.y);
    await sleep(150);
    ok('合成格真实点击可退回背包', (await page.$$eval('.crafting-cell img', (e) => e.length)) === 0);

    // 关闭界面，剩余材料应退回背包
    await page.click('.crafting-close');
    await sleep(200);
    ok('合成界面可关闭', await page.$eval('.crafting-overlay', (el) => el.style.display === 'none'));
    ok('关闭后游戏恢复', await page.evaluate(() => window.__mc.mode === 'playing'));
  }

  // ---- 模式切换 ----
  await page.evaluate(() => window.__mc.toggleGameMode());
  ok('可切换到创造模式', (await page.evaluate(() => window.__mc.survival.mode)) === 'creative');
  ok('创造模式隐藏生命条', await page.$eval('.stats-wrap', (el) => el.style.display === 'none'));
  await page.evaluate(() => window.__mc.toggleGameMode());
  ok('可切回生存模式', (await page.evaluate(() => window.__mc.survival.mode)) === 'survival');
  ok('生存模式再次显示生命条', await page.$eval('.stats-wrap', (el) => el.style.display !== 'none'));

  // ---- v1.4.0 工程续作：透明通道按几何距离排序 ----
  await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const glass = mc.registry.byNameGet('glass').id;
    const fx = Math.floor(p.x),
      fy = Math.floor(p.y),
      fz = Math.floor(p.z);
    // 只在玩家周围环形造玻璃（跳过中心 3×3 列），避免把玩家自己卡进实体
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (let y = fy - 1; y <= fy + 3; y++) mc.world.setBlock(fx + dx, y, fz + dz, glass);
      }
  });
  await sleep(900);
  const sort = await page.evaluate(() => {
    const ord = window.__mc.chunks.transparentOrder;
    if (!ord.length) return { n: 0, monotone: false, ascending: false, minOrder: 0 };
    let monotone = true,
      ascending = true,
      minOrder = Infinity;
    for (let i = 1; i < ord.length; i++) if (ord[i].dist > ord[i - 1].dist + 1e-6) monotone = false;
    for (let i = 1; i < ord.length; i++) if (ord[i].order <= ord[i - 1].order) ascending = false;
    minOrder = Math.min(...ord.map((o) => o.order));
    return { n: ord.length, monotone, ascending, minOrder };
  });
  ok('透明/水通道产生了排序条目', sort.n > 0, `n=${sort.n}`);
  ok('透明排序按几何中心距离远→近单调', sort.monotone, `n=${sort.n}`);
  ok('renderOrder 严格递增且 ≥10', sort.ascending && sort.minOrder >= 10, `min=${sort.minOrder}`);

  // ---- v1.4.0 工程续作：AABB 脱困 ----
  {
    const before = await page.evaluate(() => {
      const mc = window.__mc;
      const p = mc.player.pos;
      // 在玩家即将落入的格子里塞进一个实心块，再传送进去 → 身体必然与实心块相交
      const x = Math.floor(p.x),
        z = Math.floor(p.z),
        y = Math.floor(p.y) - 2;
      if (!mc.registry.isSolid(mc.world.getBlock(x, y, z))) {
        mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
      }
      mc.player.teleport(x + 0.5, y, z + 0.5);
      return { count: mc.player.unstuckCount, isStuck: mc.player.isStuck, x, y, z, ox: p.x, oy: p.y, oz: p.z };
    });
    ok('玩家嵌入实心方块后被判定为卡住', before.isStuck);
    await page
      .waitForFunction(
        (n) => window.__mc.player.unstuckCount > n && !window.__mc.player.isStuck,
        { timeout: 8000 },
        before.count,
      )
      .catch(() => {});
    const after = await page.evaluate(() => ({
      count: window.__mc.player.unstuckCount,
      isStuck: window.__mc.player.isStuck,
    }));
    ok('AABB 脱困自动完成并计数', after.count > before.count && !after.isStuck, `${before.count}→${after.count}`);
    // 恢复现场：清除嵌入的石头并回到原位，避免污染后续存档 / 重载断言
    await page.evaluate((b) => {
      const mc = window.__mc;
      mc.world.setBlock(b.x, b.y, b.z, 0);
      mc.player.teleport(b.ox, b.oy, b.oz);
    }, before);
    await sleep(200);
  }

  // ---- 存档 v2 ----
  const save = await page.evaluate(() => window.CraftAPI.save.export());
  ok('存档版本为 v2', save.version === 2);
  ok('存档包含模式与生存状态', save.mode === 'survival' && Array.isArray(save.survival.inventory));
  ok('存档快捷栏 9 格（允许空位）', save.hotbar.length === 9);

  ok('桌面端无运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'desktop-game.png') });

  // ---- 存档重载：继续游戏保持生存状态 ----
  const savedJson = await page.evaluate(() => JSON.stringify(window.CraftAPI.save.export()));
  await page.close();
  const r = await openPage(browser, false);
  await r.page.evaluate((raw) => localStorage.setItem('minecraft-ts-save-v1', raw), savedJson);
  await r.page.reload({ waitUntil: 'load' });
  await r.page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  await sleep(500);
  ok('重载后识别到存档（继续游戏按钮）', await r.page.evaluate(() => !!localStorage.getItem('minecraft-ts-save-v1')));
  await r.page.evaluate(() => window.__mc.startGame(true));
  await r.page.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
  await sleep(400);
  ok('继续游戏保持生存模式', await r.page.evaluate(() => window.__mc.survival.mode === 'survival'));
  ok('继续游戏恢复背包', await r.page.evaluate(() => window.__mc.survival.inventory.size > 0));
  ok('继续游戏恢复快捷栏', await r.page.evaluate(() => window.__mc.player.hotbar.slots.filter(Boolean).length > 0));

  // ==================== 移动端 ====================
  const m = await openPage(browser, true);
  const mpage = m.page;
  const merrors = m.errors;

  ok('移动端被识别', await mpage.evaluate(() => window.__mc.engine.isMobile));
  await mpage.screenshot({ path: path.join(OUT, 'mobile-title.png') });
  ok('移动端标题屏模式按钮可点', (await mpage.$$eval('.mode-btn', (e) => e.length)) === 2);

  await startGame(mpage);

  // N1：竖屏粗指针会显示旋转引导遮罩。真实玩家需先点「仍要游玩」才能操作 HUD，
  // 冒烟测试沿用同一路径（直接触摸会被遮罩拦截，这是预期行为而非输入回归）。
  const gateShown = await mpage.evaluate(() => {
    const gate = document.getElementById('rotate-gate');
    return !!gate && !gate.hidden;
  });
  if (gateShown) await mpage.click('.rotate-gate-play');
  ok(
    'N1 竖屏引导可点「仍要游玩」进入',
    await mpage.evaluate(() => document.getElementById('rotate-gate')?.hidden === true),
    `shown=${gateShown}`,
  );

  ok('触控层显示', await mpage.$eval('.touch-ui', (el) => el.style.display !== 'none'));
  ok('虚拟摇杆存在', await mpage.$eval('.joy-zone', (el) => el.offsetWidth > 100));
  ok('动作按钮 5 个', (await mpage.$$eval('.tbtn', (e) => e.length)) === 5);
  ok(
    '移动端渲染距离默认更低',
    await mpage.evaluate(() => window.__mc.chunks.renderDistance <= 4),
    `rd=${await mpage.evaluate(() => window.__mc.chunks.renderDistance)}`,
  );
  ok('动态分辨率接口就绪', await mpage.evaluate(() => typeof window.__mc.engine.setQualityScale === 'function'));
  ok(
    '移动端锁定像素比上限 1.5',
    await mpage.evaluate(() => window.__mc.engine.basePixelRatio <= 1.5),
    `dpr=${await mpage.evaluate(() => window.__mc.engine.basePixelRatio)}`,
  );

  // BugFix：手机横竖屏轻点快捷栏槽位必须切换手持物（此前 pointer-events 穿透）
  const touchSlot = await mpage.evaluate(() => {
    const slot = document.querySelectorAll('.hotbar-slot')[2];
    const r = slot.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      pointer: getComputedStyle(slot).pointerEvents,
      hit: !!hit && (hit === slot || slot.contains(hit)),
      before: window.__mc.player.hotbar.index,
    };
  });
  ok('移动端快捷栏槽位可命中', touchSlot.pointer === 'auto' && touchSlot.hit, JSON.stringify(touchSlot));
  await mpage.touchscreen.touchStart(touchSlot.x, touchSlot.y);
  await mpage.touchscreen.touchEnd();
  await sleep(150);
  ok(
    '移动端轻点快捷栏可切换手持物',
    await mpage.evaluate((before) => window.__mc.player.hotbar.index === 2 && before !== 2, touchSlot.before),
  );

  // 摇杆推动
  const joy = await mpage.$('.joy-zone');
  const jb = await joy.boundingBox();
  const jx = jb.x + jb.width / 2,
    jy = jb.y + jb.height / 2;
  const m0 = await mpage.evaluate(() => ({ ...window.__mc.player.pos }));
  await mpage.touchscreen.touchStart(jx, jy);
  await mpage.touchscreen.touchMove(jx, jy - jb.height * 0.45);
  let joyDist = 0;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const p = await mpage.evaluate(() => ({ ...window.__mc.player.pos }));
    joyDist = Math.hypot(p.x - m0.x, p.z - m0.z);
    if (joyDist > 0.8) break;
  }
  await mpage.touchscreen.touchEnd();
  await sleep(200);
  ok('摇杆可推动玩家', joyDist > 0.8, `位移 ${joyDist.toFixed(2)}`);

  // 长按挖掘按钮
  const mcell = await mpage.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const x = Math.floor(p.x),
      y = Math.floor(p.y) + 1,
      z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
    const ex = p.x,
      ey = p.y + 1.62,
      ez = p.z;
    const dx = x + 0.5 - ex,
      dy = y + 0.5 - ey,
      dz = z + 0.5 - ez;
    mc.player.yaw = Math.atan2(-dx, -dz);
    mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return { x, y, z };
  });
  await sleep(300);
  const mtarget = await mpage.evaluate(() => {
    const t = window.__mc.player.target;
    return t ? { x: t.x, y: t.y, z: t.z } : null;
  });
  ok('移动端准星命中测试方块', !!mtarget && mtarget.x === mcell.x && mtarget.y === mcell.y);
  const bb = await (await mpage.$('.tbtn-break')).boundingBox();
  await mpage.touchscreen.touchStart(bb.x + bb.width / 2, bb.y + bb.height / 2);
  let mbroken = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const st = await mpage.evaluate((c) => window.__mc.world.getBlock(c.x, c.y, c.z), mcell);
    if (st === 0) {
      mbroken = true;
      break;
    }
  }
  await mpage.touchscreen.touchEnd();
  await sleep(200);
  ok('移动端长按挖掘按钮可破坏', mbroken);

  // 手持苹果 → 放置键变进食
  await mpage.evaluate(() => {
    const mc = window.__mc;
    const slot = mc.player.hotbar.slots.findIndex((s) => s && s.kind === 'item' && s.id === 'apple');
    mc.survival.hunger = 9;
    if (slot >= 0) mc.selectSlot(slot);
  });
  await sleep(250);
  const placeLabel = await mpage.$eval('.tbtn-place', (el) => el.getAttribute('aria-label'));
  ok('放置键语义跟随手持物（进食）', placeLabel === '进食', `label=${placeLabel}`);

  // 布局检查
  const layout = await mpage.evaluate(() => {
    const hb = document.querySelector('.hotbar').getBoundingClientRect();
    const stats = document.querySelector('.stats-wrap').getBoundingClientRect();
    const tb = document.querySelector('.tbtn-jump').getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      hotbarLeft: hb.left,
      hotbarRight: hb.right,
      hotbarTop: hb.top,
      statsBottom: stats.bottom,
      jumpRight: tb.right,
    };
  });
  ok('页面无横向溢出', layout.scrollW <= layout.innerW + 1, `${layout.scrollW}/${layout.innerW}`);
  ok('快捷栏在视口内', layout.hotbarLeft >= 0 && layout.hotbarRight <= layout.innerW);
  ok(
    '状态条不遮挡快捷栏',
    layout.statsBottom <= layout.hotbarTop + 1,
    `${layout.statsBottom.toFixed(0)} vs ${layout.hotbarTop.toFixed(0)}`,
  );
  ok('跳跃按钮在安全区内', layout.jumpRight <= layout.innerW + 1);

  // 触摸拖动视角
  const yawBefore = await mpage.evaluate(() => window.__mc.player.yaw);
  await mpage.touchscreen.touchStart(300, 420);
  await mpage.touchscreen.touchMove(190, 420);
  await mpage.touchscreen.touchEnd();
  await sleep(200);
  const yawAfter = await mpage.evaluate(() => window.__mc.player.yaw);
  ok('右侧拖动可转视角', Math.abs(yawAfter - yawBefore) > 0.05, `${yawBefore.toFixed(2)}→${yawAfter.toFixed(2)}`);

  await mpage.screenshot({ path: path.join(OUT, 'mobile-game.png') });
  ok('移动端无运行时错误', merrors.length === 0, merrors.slice(0, 3).join(' | '));
  await mpage.close();

  // ==================== 降级路径：?mesher=main&greedy=0 ====================
  // Worker 在 file:// 或受限环境下可能创建失败，必须保证同步路径仍可玩。
  {
    const url = `${URL_UNDER_TEST}${URL_UNDER_TEST.includes('?') ? '&' : '?'}mesher=main&greedy=0`;
    const { page: fb, errors: ferr } = await openPage(browser, false, url);
    await fb.evaluate(() => window.__mc.startGame(false));
    await fb.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
    const fbState = await fb.evaluate(async () => {
      const mc = window.__mc;
      for (let i = 0; i < 50; i++) {
        if (mc.chunks.meshCount > 0 && mc.world.dirty.size === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return {
        mode: mc.chunks.mesherMode,
        greedy: mc.chunks.greedy,
        mesh: mc.chunks.meshCount,
        stats: mc.chunks.meshStats,
      };
    });
    ok('可强制主线程同步网格化', fbState.mode === 'main', fbState.mode);
    ok('可关闭 Greedy 做对照', fbState.greedy === false);
    ok('同步路径仍能产出网格', fbState.mesh > 0, `mesh=${fbState.mesh} merged=${fbState.stats.merged}`);
    ok('降级路径无运行时错误', ferr.length === 0, ferr.slice(0, 3).join(' | '));
    await fb.close();
  }
} catch (e) {
  ok('测试脚本未崩溃', false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures, url: URL_UNDER_TEST }, null, 2));
console.log(`\n合计 ${results.length} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
