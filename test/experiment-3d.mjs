/**
 * 3D 优化实验（第 2 轮）——受控 A/B 测量，不是回归门禁。
 *
 * 三个待验证的改动（详见 docs/EXPERIMENTS.md）：
 *   E1 顶点属性打包：每顶点 60 B → 44 B。像素上应当零差异，收益是显存与带宽。
 *   E2 抗锯齿分档：?aa=off|msaa|ssaa。像素必须有差异，代价是帧率。
 *   E3 自发光并入不透明通道（aTint=2）：?emerge=1 为默认，?emerge=0 保留旧通道。
 *
 * 对照设计 —— 核心原则：**每个变量只在同一页内翻转**。
 * 区块流式加载的最终集合会随帧率漂移（生成有每帧预算），跨页比较场景不可比，
 * 所以 E2 的 SSAA 与 E3 都在同一页内用「运行时改像素比 / 改 mergeEmissive」翻转，
 * 只有 MSAA 因为必须在创建 GL 上下文时决定，才单独开一页（并加场景一致性闸门）。
 *
 *   A  emerge=0, pixelRatio=1.0   对照（第 1 轮渲染行为）
 *   B  emerge=1, pixelRatio=1.0   E3
 *   C  emerge=1, pixelRatio=1.5   E2 / SSAA（等价于 ?aa=ssaa 的像素比）
 *   D  emerge=1, pixelRatio=1.0   回到 B，测量噪声底
 *   M  ?aa=msaa, emerge=1, pr=1.0 E2 / MSAA（跨页，需场景闸门）
 *
 * 用法：npm run build && npm run test:experiment
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
const RENDER_DISTANCE = Number(process.env.MC_RD ?? 3);
const SSAA_SCALE = 1.5;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 visual-check.mjs 保持同一套渲染后端开关（CI 用 Xvfb + Mesa） */
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
    '--window-size=1280,760',
    '--mute-audio',
  ],
});

const sceneState = (page) =>
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
      mesh: mc.chunks.meshCount,
      gen: mc.world.chunks.size,
      busy: mc.chunks.workerBusy.reduce((a, b) => a + b, 0),
      verts,
    };
  });

/** 等玩家落地：出生点在半空，落地前区块集合并不同步 */
const waitOnGround = async (page, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__mc.player.onGround)) return true;
    await sleep(200);
  }
  return false;
};

/**
 * 等场景完全静止：连续 4 次（每次间隔 1s）区块数 / 已网格数 / 脏队列 / 在途任务都不变。
 * 只等「脏队列清空」会提前返回 —— Worker 手里可能还有在途任务，画面仍是旧网格。
 */
const waitSceneFixed = async (page, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  let last = null,
    same = 0;
  while (Date.now() < deadline) {
    const st = await sceneState(page);
    const frozen =
      st.gen === last?.gen &&
      st.mesh === last?.mesh &&
      st.verts === last?.verts &&
      st.dirty === last?.dirty &&
      st.busy === last?.busy &&
      st.dirty === 0 &&
      st.busy === 0;
    if (frozen) {
      same++;
      if (same >= 4) return st;
    } else {
      same = 0;
    }
    last = st;
    await sleep(1000);
  }
  return null;
};

/** 真实帧率：在页面内用 rAF 计 2.5 秒帧数（软件渲染下这就是端到端成本） */
const measureFps = (page, ms = 2500) =>
  page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const t0 = performance.now();
        let frames = 0;
        const tick = () => {
          frames++;
          if (performance.now() - t0 < dur) requestAnimationFrame(tick);
          else resolve(frames / ((performance.now() - t0) / 1000));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

/** 采集结构指标 + 像素签名（归一化坐标抽样，见下） */
const collect = async (page) =>
  page.evaluate(() => {
    const mc = window.__mc;
    const r = mc.engine.renderer;

    // 强制渲染一次：拿到确定性的 draw call / 三角形计数（renderer.info 每帧自动重置）
    r.render(mc.engine.scene, mc.engine.camera);
    const info = {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      programs: r.info.programs.length,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
    };

    // 连续渲染 N 次取均值：软件渲染下这是填充率成本的直接代理
    const N = 10;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) r.render(mc.engine.scene, mc.engine.camera);
    const renderMs = (performance.now() - t0) / N;

    // 几何体量：逐通道的 mesh 数 / 顶点数 / 顶点缓冲字节
    const per = { opaque: 0, emissive: 0, transparent: 0, water: 0 };
    let meshes = 0,
      verts = 0,
      vertexBytes = 0,
      indexBytes = 0;
    for (const m of mc.chunks.meshes.values()) {
      for (const ch of ['opaque', 'emissive', 'transparent', 'water']) {
        const mesh = m[ch];
        if (!mesh) continue;
        per[ch]++;
        meshes++;
        const g = mesh.geometry;
        let vb = 0;
        for (const key in g.attributes) vb += g.attributes[key].array.byteLength;
        vertexBytes += vb;
        indexBytes += g.index ? g.index.array.byteLength : 0;
        verts += g.attributes.position.count;
      }
    }

    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight;

    // 像素签名：在**归一化坐标**上均匀抽样。
    // SSAA 会改变 drawingBuffer 尺寸，按像素步长抽样会把「分辨率不同」误判成「画面不同」。
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const pix = [];
    const NX = 96,
      NY = 54;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const x = Math.min(w - 1, Math.floor(((i + 0.5) / NX) * w));
        const y = Math.min(h - 1, Math.floor(((j + 0.5) / NY) * h));
        const k = (y * w + x) * 4;
        pix.push(buf[k], buf[k + 1], buf[k + 2]);
      }
    }

    // 只统计「脏标记派发半径」（renderDistance + 1）内的区块。
    // 半径外的区块在 step 2 里直接丢掉脏标记、根本不会被重新网格化，
    // 它们保留旧通道是引擎的正常行为，不该算进 E3 的对照里。
    const margin = mc.chunks.renderDistance + 1;
    const pcx = Math.floor(mc.player.pos.x / 16),
      pcz = Math.floor(mc.player.pos.z / 16);
    const emissiveKeys = [];
    for (const [key, entry] of mc.chunks.meshes) {
      if (!entry.emissive) continue;
      const [x, z] = key.split(',').map(Number);
      if (Math.abs(x - pcx) > margin || Math.abs(z - pcz) > margin) continue;
      emissiveKeys.push([key, entry.emissive.geometry.attributes.position.count]);
    }

    return {
      info,
      renderMs,
      per,
      meshes,
      verts,
      vertexBytes,
      indexBytes,
      emissiveInMargin: emissiveKeys.length,
      emissiveKeys,
      buffer: { w, h },
      pixelRatio: r.getPixelRatio(),
      aaMode: mc.engine.aaMode,
      antialias: gl.getContextAttributes().antialias,
      pixelCount: pix.length / 3,
      sig: Array.from(pix),
    };
  });

const diffSig = (a, b) => {
  const n = Math.min(a.length, b.length);
  let sum = 0,
    max = 0,
    changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
    if (d > 8) changed++;
  }
  return { mad: sum / n, max, changed, samples: n };
};

/** 进世界 + 固定相机 / 昼夜 / 渲染距离，并摆好光源阵列 */
const openWorld = async (query) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const sep = BASE_URL.includes('?') ? '&' : '?';
  await page.goto(`${BASE_URL}${sep}${query}`, { waitUntil: 'load' });
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
  await page.evaluate((rd) => {
    const mc = window.__mc;
    mc.chunks.setRenderDistance(rd);
    mc.sky.dayLength = 1000000; // 冻结昼夜，避免采样期间光照漂移
    mc.sky.dayTime = 0.32;
    mc.player.yaw = 0.65;
    mc.player.pitch = -0.06;
  }, RENDER_DISTANCE);
  await waitOnGround(page);

  // 先换最小系统组，再等出生点的流式加载收敛，最后才钉点。
  // 顺序很关键：如果先钉点，两个页面在「钉点之前」生成的区块集合会随帧率漂移
  // （每帧生成预算 + 加载耗时不同），跨页 A/B 就不可比。收敛后两页的区块集合相同，
  // 之后的差异只可能来自钉点半径，而那是确定性的。
  await installMinimalSystems(page);
  const pre = await waitSceneFixed(page);
  if (!pre) console.log('   警告：出生点区块未收敛，跨页场景可能不可比');

  // 把玩家与相机钉在固定坐标：落地位置会随物理帧时序漂移，
  // 两个页面的中心区块就不同，跨页 A/B 便不可比。
  await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player;
    p.pos.set(8, mc.world.surfaceHeight(8, 8) + 1.02, 8);
    p.vel.set(0, 0, 0);
    p.yaw = 0.65;
    p.pitch = -0.06;
    mc.engine.camera.position.set(p.pos.x, p.pos.y + 1.62, p.pos.z);
    mc.engine.camera.rotation.order = 'YXZ';
    mc.engine.camera.rotation.set(p.pitch, p.yaw, 0);
    mc.chunks.setCenter(p.pos.x, p.pos.z);
  });

  // 裁剪到渲染半径：出生点附近可能残留几个「已生成／已网格化」的区块（传送前
  // 那几帧它们还在派发半径内）。残留几个取决于时序，两个页面就不同，跨页 A/B
  // 不可比。这里复刻 ChunkManager 的卸载步骤，把世界裁成确定性的 (2R+1)²。
  const pruned = await page.evaluate(() => {
    const mc = window.__mc;
    const cx = Math.floor(mc.player.pos.x / 16),
      cz = Math.floor(mc.player.pos.z / 16);
    const R = mc.chunks.renderDistance;
    const c = mc.chunks;
    let n = 0;
    for (const [key, chunk] of [...mc.world.chunks]) {
      if (Math.abs(chunk.cx - cx) <= R && Math.abs(chunk.cz - cz) <= R) continue;
      const m = c.meshes.get(key);
      if (m) {
        for (const mesh of [m.opaque, m.emissive, m.transparent, m.water]) {
          if (!mesh) continue;
          c.scene.remove(mesh);
          mesh.geometry.dispose();
        }
        c.meshes.delete(key);
      }
      const rec = c.inFlight.get(key);
      if (rec) {
        c.inFlight.delete(key);
        rec.resolve();
      }
      mc.world.chunks.delete(key);
      mc.world.dirty.delete(key);
      n++;
    }
    return n;
  });
  if (process.env.MC_DEBUG) console.log(`   裁剪出生点残留区块：${pruned}`);

  // 再一次性 ensureChunk 整个半径：流式加载按每帧预算推进，冻结系统后就会停在
  // 「当时生成到哪算哪」的状态。强制生成后，场景由种子唯一决定。
  await page.evaluate((R) => {
    const mc = window.__mc;
    const pcx = Math.floor(mc.player.pos.x / 16),
      pcz = Math.floor(mc.player.pos.z / 16);
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) mc.world.ensureChunk(pcx + dx, pcz + dz);
    }
  }, RENDER_DISTANCE);

  // 在每个区块中心摆一个萤石 + 一支火把：
  // 让 E3 的对照路径必然产生 N 个独立 emissive mesh，A/B 才有东西可比。
  const placed = await page.evaluate(() => {
    const mc = window.__mc;
    const p = mc.player.pos;
    const pcx = Math.floor(p.x / 16),
      pcz = Math.floor(p.z / 16);
    const glow = mc.registry.byNameGet('glowstone').id;
    const torch = mc.registry.byNameGet('torch').id;
    let n = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const cx = pcx + dx,
          cz = pcz + dz;
        const y = mc.world.surfaceHeight(cx * 16 + 8, cz * 16 + 8);
        mc.world.setBlock(cx * 16 + 8, y + 1, cz * 16 + 8, glow);
        mc.world.setBlock(cx * 16 + 9, y + 1, cz * 16 + 8, torch);
        n++;
      }
    }
    return n;
  });
  await waitSceneFixed(page);
  await sleep(1200);
  await setFrozen(page, true);
  return { page, errors, placed };
};

/**
 * 换上最小系统组：只保留「区块」一项，其余全部停。
 *
 * main.ts 注册的是闭包 system（内部自己调 chunks.update / sky.update），
 * 所以这里必须整体替换 engine.systems，按对象引用过滤是无效的。
 *
 * 被摘掉的系统每一个都会破坏受控性：
 *   - botany 会种树 —— 几何体量真的变多（不是噪声，是世界变了）
 *   - gameplay 推进玩家物理 —— 相机位置会变
 *   - particles / tnt / entities —— 画面内容会变
 *   - sky 推 localTime —— 云漂移、星星闪烁、月相
 *   - chunks 推 waterTime —— 水面微波
 * 天空只在此处推一次（dt=0），把昼夜 / 光照系数钉死，之后不再进主循环。
 */
const installMinimalSystems = (page) =>
  page.evaluate(() => {
    const mc = window.__mc;
    mc.sky.dayLength = 1000000;
    mc.sky.dayTime = 0.32;
    mc.sky.update(0, 0); // 只推一次：定住 daylight / 云 / 星月相位
    mc.chunks.lightUniform.value = 0.16 + 0.84 * mc.sky.daylight;
    mc.chunks.sunTint.value.copy(mc.sky.sunTint);
    mc.chunks.waterTime.value = 0; // 水面微波相位归零，作为基准帧
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

/**
 * 冻结 / 解冻场景：直接清空 engine.systems。
 * main.ts 注册的是闭包 system（内部自己调 chunks.update / sky.update），
 * 按对象引用过滤是无效的，必须整组摘掉。
 * 冻结的动机：ChunkManager 推 waterTime（水面波浪）、Sky 推 localTime（云漂移 / 星星闪烁），
 * 玩家物理与粒子也在动 —— 不冻住就没有任何两帧像素相同，A/B 无从谈起。
 * 冻住后渲染循环仍在跑，所以帧率依然是真实渲染成本。
 */
const setFrozen = (page, frozen) =>
  page.evaluate((frozen) => {
    const mc = window.__mc;
    const e = mc.engine;
    if (frozen) {
      if (!window.__expSysBackup) window.__expSysBackup = e.systems.slice();
      e.systems = [];
      // 解冻窗口里 chunks.update 会推进 waterTime、天空相位也会随 dt 走，
      // 每次冻结都回到同一相位，两次探针才是同一帧画面。
      mc.chunks.waterTime.value = 0;
      mc.sky.localTime = 0;
      mc.sky.update(0, 0);
    } else if (window.__expSysBackup) {
      e.systems = window.__expSysBackup;
    }
  }, frozen);

/** 翻一个变量（E3 的通道归属 / E2 的像素比），等静止、冻结后测一次 */
const measureRun = async (page, { emerge, pixelRatio }) => {
  await setFrozen(page, false);
  await page.evaluate(
    ({ emerge, pixelRatio }) => {
      const mc = window.__mc;
      const c = mc.chunks;
      if (c.mergeEmissiveOption !== emerge) {
        c.mergeEmissiveOption = emerge;
        c.invalidateConfig(); // 重建 MeshConfig 并把所有区块重新入队
      }
      // 与 Engine.applyPixelRatio 同一套做法：改像素比后必须重新 setSize 才生效
      const r = mc.engine.renderer;
      r.setPixelRatio(pixelRatio);
      r.setSize(mc.engine.container.clientWidth || innerWidth, mc.engine.container.clientHeight || innerHeight, false);
    },
    { emerge, pixelRatio },
  );
  const st = await waitSceneFixed(page);
  await setFrozen(page, true);
  const probe = () =>
    page.evaluate(() => {
      const mc = window.__mc;
      let verts = 0;
      for (const mm of mc.chunks.meshes.values()) {
        for (const ch of ['opaque', 'emissive', 'transparent', 'water']) {
          if (mm[ch]) verts += mm[ch].geometry.attributes.position.count;
        }
      }
      return {
        gen: mc.world.chunks.size,
        mesh: mc.chunks.meshCount,
        dirty: mc.world.dirty.size,
        verts,
        sys: mc.engine.systems.length,
      };
    });
  const p1 = await probe();
  await sleep(800);
  const p2 = await probe();
  const fps = await measureFps(page);
  const m = await collect(page);
  const p3 = await probe();
  if (p1.verts !== p2.verts || p2.verts !== p3.verts) {
    console.log(`   探针：冻结后几何仍在变 ${JSON.stringify(p1)} → ${JSON.stringify(p2)} → ${JSON.stringify(p3)}`);
  }
  return { st, fps, m, probe: { p1, p2, p3 } };
};

/** 页面内的 2×2 扫描：A 对照 / B E3 / C SSAA / D 回到 B 的噪声底 */
const sweep = async (query, tag) => {
  const { page, errors, placed } = await openWorld(query);
  const runs = {};
  for (const [id, cfg] of [
    ['A', { emerge: false, pixelRatio: 1 }],
    ['B', { emerge: true, pixelRatio: 1 }],
    ['C', { emerge: true, pixelRatio: SSAA_SCALE }],
    ['D', { emerge: true, pixelRatio: 1 }],
  ]) {
    runs[id] = await measureRun(page, cfg);
    const r = runs[id];
    console.log(
      `  [${tag}:${id}] gen=${r.st?.gen} calls=${r.m.info.calls} emissiveMesh=${r.m.per.emissive}` +
        ` programs=${r.m.info.programs} fps=${r.fps.toFixed(1)} verts=${r.m.verts}` +
        ` buf=${r.m.buffer.w}x${r.m.buffer.h} pr=${r.m.pixelRatio} aa=${r.m.aaMode} antialias=${r.m.antialias}`,
    );
  }
  await page.screenshot({ path: path.join(OUT, `exp-${tag}.png`) });
  await page.close();
  return { tag, placed, errors, runs };
};

let main = null;
let msaa = null;
try {
  console.log('场景：seed=2026 creative，渲染距离 ' + RENDER_DISTANCE + '，每个区块中心摆萤石 + 火把');
  main = await sweep('aa=off&emerge=0', 'main');
  msaa = await sweep('aa=msaa&emerge=1', 'msaa');
  console.log(`摆光源区块数：main=${main.placed} msaa=${msaa.placed}`);
} finally {
  await browser.close();
}

// ---------- 比对 ----------
const { A, B, C, D } = main.runs;
const M = msaa.runs.B; // MSAA 页的 B（emerge=1, pr=1）
const cmpE3 = diffSig(A.m.sig, B.m.sig); // 同页，只翻 E3
const cmpSSAA = diffSig(B.m.sig, C.m.sig); // 同页，只翻像素比
const cmpNoise = diffSig(B.m.sig, D.m.sig); // 同页，什么都不翻（噪声底）
const cmpMSAA = diffSig(B.m.sig, M.m.sig); // 跨页，只翻 MSAA
const bytesPerVert = A.m.vertexBytes / Math.max(1, A.m.verts);

console.log('\n===== 实验结果 =====');
console.log('E1 顶点属性打包（结构指标，无运行时开关）');
console.log(`   每顶点字节 = ${bytesPerVert.toFixed(1)} B（旧布局 60 B）`);
console.log(`   顶点缓冲合计 ${A.m.vertexBytes} B / ${A.m.verts} 顶点`);
console.log('E3 自发光并入不透明通道（同页 A→B，只翻这一个变量）');
console.log(`   draw calls ${A.m.info.calls} → ${B.m.info.calls}`);
console.log(`   emissive mesh（派发半径内）${A.m.emissiveInMargin} → ${B.m.emissiveInMargin}`);
console.log(`   programs ${A.m.info.programs} → ${B.m.info.programs}（几何 ${A.m.verts} → ${B.m.verts} 顶点）`);
console.log(`   帧率 ${A.fps.toFixed(1)} → ${B.fps.toFixed(1)}`);
console.log(`   像素差 MAD=${cmpE3.mad.toFixed(3)} max=${cmpE3.max} 变化采样=${cmpE3.changed}/${cmpE3.samples}`);
console.log('E2 抗锯齿');
console.log(
  `   SSAA 同页 B→C：帧率 ${B.fps.toFixed(1)} → ${C.fps.toFixed(1)}，像素差 MAD=${cmpSSAA.mad.toFixed(3)}，buf ${B.m.buffer.w}x${B.m.buffer.h} → ${C.m.buffer.w}x${C.m.buffer.h}`,
);
console.log(
  `   MSAA 跨页 B→M：帧率 ${B.fps.toFixed(1)} → ${M.fps.toFixed(1)}，像素差 MAD=${cmpMSAA.mad.toFixed(3)}，antialias=${M.m.antialias}`,
);
console.log(
  `   噪声底 B→D（同页重复测量）：像素差 MAD=${cmpNoise.mad.toFixed(3)}，帧率 ${B.fps.toFixed(1)} → ${D.fps.toFixed(1)}`,
);

const badErrors = [main, msaa].filter((r) => r.errors.length);
const report = {
  arms: {
    main: Object.fromEntries(Object.entries(main.runs).map(([k, r]) => [k, { fps: r.fps, m: r.m }])),
    msaa: Object.fromEntries(Object.entries(msaa.runs).map(([k, r]) => [k, { fps: r.fps, m: r.m }])),
  },
  placed: { main: main.placed, msaa: msaa.placed },
  compare: { e3: cmpE3, ssaa: cmpSSAA, msaa: cmpMSAA, noise: cmpNoise },
  bytesPerVert,
  runtimeErrors: badErrors.map((r) => ({ tag: r.tag, errors: r.errors })),
};
fs.writeFileSync(path.join(OUT, 'experiment-3d.json'), JSON.stringify(report, null, 2));
console.log(`\n原始数据：${path.join(OUT, 'experiment-3d.json')}`);

// ---------- 实验有效性检查 ----------
const fails = [];
// E3：同页翻转，画面必须零差异
if (cmpE3.changed > 0) fails.push(`E3 应当零画面差异，实际 ${cmpE3.changed} 个采样变化（max=${cmpE3.max}）`);
if (B.m.emissiveInMargin !== 0) fails.push(`E3 打开后派发半径内仍有 ${B.m.emissiveInMargin} 个 emissive mesh`);
if (A.m.emissiveInMargin === 0) fails.push('对照路径没有产生 emissive mesh，E3 的 A/B 无对照');
if (B.m.info.calls >= A.m.info.calls) fails.push('E3 没有减少 draw call');
if (B.m.info.programs !== A.m.info.programs)
  fails.push(`E3 改变了 program 数（${A.m.info.programs} → ${B.m.info.programs}）`);
if (B.m.verts !== A.m.verts) fails.push(`E3 翻转前后几何体量应一致（${A.m.verts} → ${B.m.verts}）`);
// E2 / SSAA：同页翻转，画面必须有差异、帧率必须下降
if (cmpSSAA.changed === 0) fails.push('SSAA 没有产生任何像素差异，超采样未生效');
if (C.fps >= B.fps) fails.push('SSAA 没有降低帧率，测量无效');
if (C.m.buffer.w <= B.m.buffer.w) fails.push('SSAA 没有提高渲染分辨率');
// E2 / MSAA：跨页比较必须先证明场景一致
const parity =
  M.m.verts === B.m.verts &&
  M.m.per.opaque === B.m.per.opaque &&
  M.m.buffer.w === B.m.buffer.w &&
  msaa.placed === main.placed;
if (!parity) fails.push(`MSAA 页与主场景不同（verts ${M.m.verts} vs ${B.m.verts}），跨页 A/B 不可比`);
if (!M.m.antialias) fails.push('MSAA 页的 GL 上下文 antialias=false，抗锯齿未生效');
if (cmpMSAA.changed === 0) fails.push('MSAA 没有产生任何像素差异');
if (M.fps >= B.fps) fails.push('MSAA 没有降低帧率，测量无效');
// 噪声底：同页重复测量必须稳定，否则上面的「零差异」结论不可信
if (cmpNoise.changed > 0) fails.push(`同页重复测量出现 ${cmpNoise.changed} 个像素变化，测量本身不稳定`);
// E1：顶点布局必须是 44 B
if (Math.abs(bytesPerVert - 44) > 0.01) fails.push(`每顶点字节应为 44，实际 ${bytesPerVert.toFixed(2)}`);
if (badErrors.length) fails.push(`${badErrors.length} 个页面出现运行时错误`);

if (fails.length) {
  console.error('\n实验有效性检查未通过：');
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n实验有效性检查全部通过');
