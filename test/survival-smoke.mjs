/**
 * 生存模式 + 移动端 冒烟测试（无头 Chromium，软件 WebGL）
 * 用法：node test/survival-smoke.mjs
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL_UNDER_TEST = process.env.MC_URL ?? `file://${path.join(ROOT, 'dist/index.html')}`;
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/chromium';
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

async function openPage(browser, mobile) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  if (mobile) {
    await page.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
  } else {
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  }
  await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
  await page.waitForFunction('window.__mc !== undefined', { timeout: 25000 });
  await page.evaluate(() => localStorage.clear());
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--allow-file-access-from-files',
    '--window-size=1280,760',
  ],
});

try {
  // ============ 回归：标题 UI → 状态机 / 事件 / 流式加载 ============
  {
    const { page: uiPage } = await openPage(browser, false);
    await uiPage.click('.mode-btn[data-mode="creative"]');
    ok('标题页可选择创造模式',
      await uiPage.$eval('.mode-btn[data-mode="creative"]', (el) => el.classList.contains('active')));
    await uiPage.click('.title-buttons .mc-btn');
    await uiPage.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
    ok('标题选创造后进入世界即为创造模式',
      await uiPage.evaluate(() => window.__mc.gameMode === 'creative'));

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
    await sleep(3000);
    const q = await uiPage.evaluate(() => ({
      gen: window.__mc.world.chunks.size,
      mesh: window.__mc.chunks.meshCount,
      dirty: window.__mc.world.dirty.size,
    }));
    ok('流式加载：生成的区块都有网格', q.gen > 0 && q.mesh >= q.gen - 1,
      `gen=${q.gen} mesh=${q.mesh} dirty=${q.dirty}`);

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
  ok('生命/饥饿 HUD 可见', await page.$eval('.stats-wrap', (el) => el.style.display !== 'none' && el.offsetParent !== null));
  ok('心形与鸡腿各 10 格',
    (await page.$$eval('.stat-heart .stat-pip', (e) => e.length)) === 10 &&
    (await page.$$eval('.stat-hunger .stat-pip', (e) => e.length)) === 10);
  ok('新手补给苹果在背包', await page.evaluate(() => window.__mc.survival.countKey('i:apple') === 2));
  ok('手持物品为苹果（扁平精灵）', await page.evaluate(() => window.__mc.player.selectedStack()?.kind === 'item'));
  ok('快捷栏渲染物品数量', (await page.$eval('.hotbar-slot .slot-count', (el) => el.textContent)) === '2');

  // 移动
  const p0 = await page.evaluate(() => ({ ...window.__mc.player.pos }));
  await page.keyboard.down('KeyW');
  await sleep(900);
  await page.keyboard.up('KeyW');
  const p1 = await page.evaluate(() => ({ ...window.__mc.player.pos }));
  ok('键盘移动生效', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.7,
    `位移 ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)}`);

  // ---- 挖掘：在正前方 3 格处强制放一块石头并瞄准 ----
  const mineCell = await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const x = Math.floor(p.x), y = Math.floor(p.y) + 1, z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
    return { x, y, z };
  });
  await sleep(150);
  await page.evaluate((c) => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const ex = p.x, ey = p.y + 1.62, ez = p.z;
    const dx = c.x + 0.5 - ex, dy = c.y + 0.5 - ey, dz = c.z + 0.5 - ez;
    mc.player.yaw = Math.atan2(-dx, -dz);
    mc.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, mineCell);
  await sleep(250);
  const aim = await page.evaluate(() => {
    const t = window.__mc.player.target;
    return t ? { x: t.x, y: t.y, z: t.z, name: window.__mc.registry.get(t.block).name } : null;
  });
  ok('准星命中测试方块', !!aim && aim.x === mineCell.x && aim.y === mineCell.y && aim.z === mineCell.z,
    aim ? `${aim.name}@${aim.x},${aim.y},${aim.z}` : 'null');

  await page.mouse.move(640, 380);
  await page.mouse.down({ button: 'left' });
  let midProgress = null;
  let sawMid = false;
  let barVisible = false;
  let brokenId = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const st = await page.evaluate((c) => ({
      progress: window.__mc.player.miningProgress,
      block: window.__mc.world.getBlock(c.x, c.y, c.z),
    }), mineCell);
    if (typeof st.progress === 'number' && st.progress > 0.25 && st.progress < 1) {
      midProgress = st.progress;
      if (!sawMid) {
        sawMid = true;
        barVisible = await page.$eval('.mining-bar', (el) => el.style.display !== 'none');
        await page.screenshot({ path: path.join(OUT, 'desktop-mining.png') });
      }
    }
    if (st.block === 0) { brokenId = 0; break; }
  }
  await page.mouse.up({ button: 'left' });
  await sleep(250);
  ok('挖掘进度累积（非瞬间破坏）', sawMid, `progress=${midProgress}`);
  ok('挖掘进度条可见', barVisible);
  if (brokenId !== 0) brokenId = await page.evaluate((c) => window.__mc.world.getBlock(c.x, c.y, c.z), mineCell);
  ok('生存模式按住可破坏方块', brokenId === 0, `block=${brokenId}`);
  ok('石头掉落为圆石', await page.evaluate(() => window.__mc.survival.countKey('b:' + window.__mc.registry.byNameGet('cobblestone').id) >= 1));
  ok('掉落自动补进快捷栏',
    await page.evaluate(() => window.__mc.player.hotbar.slots.some((s) => s && s.kind === 'block' && s.id === window.__mc.registry.byNameGet('cobblestone').id)));

  // ---- 放置：瞄准 3 格外的方块顶面，放下泥土 ----
  const placeSetup = await page.evaluate(() => {
    const mc = window.__mc;
    const dirt = mc.registry.byNameGet('dirt').id;
    mc.survival.addBlock(dirt, 3);
    const slot = mc.player.hotbar.slots.findIndex((s) => s === null);
    mc.player.hotbar.slots[slot] = { kind: 'block', id: dirt };
    mc.selectSlot(slot);
    const p = mc.player.pos;
    const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
    return { x, y, z, dirt, slot };
  });
  await sleep(150);
  await page.evaluate((c) => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const ex = p.x, ey = p.y + 1.62, ez = p.z;
    const dx = c.x + 0.5 - ex, dy = c.y + 1.0 - ey, dz = c.z + 0.5 - ez;
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
  await page.mouse.down({ button: 'right' });
  await sleep(280);
  await page.mouse.up({ button: 'right' });
  await sleep(300);
  const placedCell = { x: placeTarget.x + placeTarget.nx, y: placeTarget.y + 1, z: placeTarget.z + placeTarget.nz };
  const placedId = await page.evaluate((c) => window.__mc.world.getBlock(c.x, c.y, c.z), placedCell);
  const dirtAfter = await page.evaluate((d) => window.__mc.survival.countKey('b:' + d), placeSetup.dirt);
  ok('生存模式放置方块', placedId === placeSetup.dirt, `placed=${placedId} want=${placeSetup.dirt}`);
  ok('放置消耗背包方块', dirtAfter === dirtBefore - 1, `${dirtBefore}→${dirtAfter}`);

  // ---- 伤害 / 死亡 / 重生 ----
  await page.evaluate(() => window.__mc.survival.damage(6, '测试伤害'));
  await sleep(300);
  ok('受到伤害扣血', await page.evaluate(() => window.__mc.survival.health === 14));
  ok('受伤红屏触发', await page.$eval('.hurt-flash', (el) => el.classList.contains('go')));
  await page.evaluate(() => {
    const iv = setInterval(() => {
      if (window.__mc.mode === 'dead') { clearInterval(iv); return; }
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
  const appleAfter = await page.evaluate(() => window.__mc.survival.countKey('i:apple'));
  ok('吃苹果恢复饥饿', hungerNow > 8, `hunger=${hungerNow}`);
  ok('进食消耗苹果', appleAfter === appleBefore - 1 || appleBefore === 0, `${appleBefore}→${appleAfter}`);

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

  // ---- 模式切换 ----
  await page.evaluate(() => window.__mc.toggleGameMode());
  ok('可切换到创造模式', (await page.evaluate(() => window.__mc.survival.mode)) === 'creative');
  ok('创造模式隐藏生命条', await page.$eval('.stats-wrap', (el) => el.style.display === 'none'));
  await page.evaluate(() => window.__mc.toggleGameMode());
  ok('可切回生存模式', (await page.evaluate(() => window.__mc.survival.mode)) === 'survival');
  ok('生存模式再次显示生命条', await page.$eval('.stats-wrap', (el) => el.style.display !== 'none'));

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
  ok('重载后识别到存档（继续游戏按钮）',
    await r.page.evaluate(() => !!localStorage.getItem('minecraft-ts-save-v1')));
  await r.page.evaluate(() => window.__mc.startGame(true));
  await r.page.waitForFunction('window.__mc.mode === "playing"', { timeout: 40000 });
  await sleep(400);
  ok('继续游戏保持生存模式', await r.page.evaluate(() => window.__mc.survival.mode === 'survival'));
  ok('继续游戏恢复背包', await r.page.evaluate(() => window.__mc.survival.inventory.size > 0));
  ok('继续游戏恢复快捷栏',
    await r.page.evaluate(() => window.__mc.player.hotbar.slots.filter(Boolean).length > 0));

  // ==================== 移动端 ====================
  const m = await openPage(browser, true);
  const mpage = m.page;
  const merrors = m.errors;

  ok('移动端被识别', await mpage.evaluate(() => window.__mc.engine.isMobile));
  await mpage.screenshot({ path: path.join(OUT, 'mobile-title.png') });
  ok('移动端标题屏模式按钮可点', (await mpage.$$eval('.mode-btn', (e) => e.length)) === 2);

  await startGame(mpage);

  ok('触控层显示', await mpage.$eval('.touch-ui', (el) => el.style.display !== 'none'));
  ok('虚拟摇杆存在', await mpage.$eval('.joy-zone', (el) => el.offsetWidth > 100));
  ok('动作按钮 5 个', (await mpage.$$eval('.tbtn', (e) => e.length)) === 5);
  ok('移动端渲染距离默认更低', await mpage.evaluate(() => window.__mc.chunks.renderDistance <= 4),
    `rd=${await mpage.evaluate(() => window.__mc.chunks.renderDistance)}`);
  ok('动态分辨率接口就绪', await mpage.evaluate(() => typeof window.__mc.engine.setQualityScale === 'function'));
  ok('移动端锁定像素比上限 1.5', await mpage.evaluate(() => window.__mc.engine.basePixelRatio <= 1.5),
    `dpr=${await mpage.evaluate(() => window.__mc.engine.basePixelRatio)}`);

  // 摇杆推动
  const joy = await mpage.$('.joy-zone');
  const jb = await joy.boundingBox();
  const jx = jb.x + jb.width / 2, jy = jb.y + jb.height / 2;
  const m0 = await mpage.evaluate(() => ({ ...window.__mc.player.pos }));
  await mpage.touchscreen.touchStart(jx, jy);
  await mpage.touchscreen.touchMove(jx, jy - jb.height * 0.45);
  await sleep(1200);
  await mpage.touchscreen.touchEnd();
  await sleep(200);
  const m1 = await mpage.evaluate(() => ({ ...window.__mc.player.pos }));
  ok('摇杆可推动玩家', Math.hypot(m1.x - m0.x, m1.z - m0.z) > 0.8,
    `位移 ${Math.hypot(m1.x - m0.x, m1.z - m0.z).toFixed(2)}`);

  // 长按挖掘按钮
  const mcell = await mpage.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const x = Math.floor(p.x), y = Math.floor(p.y) + 1, z = Math.floor(p.z) - 3;
    mc.world.setBlock(x, y, z, mc.registry.byNameGet('stone').id);
    const ex = p.x, ey = p.y + 1.62, ez = p.z;
    const dx = x + 0.5 - ex, dy = y + 0.5 - ey, dz = z + 0.5 - ez;
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
    if (st === 0) { mbroken = true; break; }
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
      hotbarLeft: hb.left, hotbarRight: hb.right, hotbarTop: hb.top,
      statsBottom: stats.bottom, jumpRight: tb.right,
    };
  });
  ok('页面无横向溢出', layout.scrollW <= layout.innerW + 1, `${layout.scrollW}/${layout.innerW}`);
  ok('快捷栏在视口内', layout.hotbarLeft >= 0 && layout.hotbarRight <= layout.innerW);
  ok('状态条不遮挡快捷栏', layout.statsBottom <= layout.hotbarTop + 1,
    `${layout.statsBottom.toFixed(0)} vs ${layout.hotbarTop.toFixed(0)}`);
  ok('跳跃按钮在安全区内', layout.jumpRight <= layout.innerW + 1);

  // 触摸拖动视角
  const yawBefore = await mpage.evaluate(() => window.__mc.player.yaw);
  await mpage.touchscreen.touchStart(300, 420);
  await mpage.touchscreen.touchMove(190, 420);
  await mpage.touchscreen.touchEnd();
  await sleep(200);
  const yawAfter = await mpage.evaluate(() => window.__mc.player.yaw);
  ok('右侧拖动可转视角', Math.abs(yawAfter - yawBefore) > 0.05,
    `${yawBefore.toFixed(2)}→${yawAfter.toFixed(2)}`);

  await mpage.screenshot({ path: path.join(OUT, 'mobile-game.png') });
  ok('移动端无运行时错误', merrors.length === 0, merrors.slice(0, 3).join(' | '));
  await mpage.close();
} catch (e) {
  ok('测试脚本未崩溃', false, e.message);
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures, url: URL_UNDER_TEST }, null, 2));
console.log(`\n合计 ${results.length} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
