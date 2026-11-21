import './ui/styles.css';
import './ui/vanilla-ui.css';
import * as THREE from 'three';
import { Engine } from './core/engine';
import { VERSION, RELEASE } from './core/version';
import { clamp, type BlockId, type GameMode } from './core/types';
import {
  loadOptions, normalizeOptions, persistOptions, qualityScale,
  type MesherThreads, type Options, type QualityMode, type RandomTickSpeed,
} from './core/options';
import { BlockRegistry, registerBuiltinBlocks, AIR } from './world/blocks';
import { TextureAtlas } from './gfx/atlas';
import { DefaultGenerator } from './world/generator';
import { World } from './world/world';
import { Botany } from './world/botany';
import { seasonAt, weatherAt } from './world/ecology';
import { ChunkManager } from './world/chunkManager';
import { Sky } from './gfx/sky';
import { Particles } from './gfx/particles';
import { BlockHighlight } from './gfx/highlight';
import { Player, type HotbarState } from './player/player';
import { SurvivalState, ITEMS, MAX_HUNGER, MAX_HEALTH, parseKey, type Stack } from './player/survival';
import {
  inventoryKeyToMaterial,
  materialToStack,
  type MaterialId,
} from './player/crafting';
import type { CraftingHost, CraftingMaterial } from './ui/crafting';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { EntityManager } from './entity/entity';
import { DropManager } from './entity/droppedItem';
import { PrimedTnt } from './entity/tnt';
import { FallingSystem } from './entity/falling';
import { SoundEngine } from './audio/sound';
import { HUD } from './ui/hud';
import { ACTION_LABELS, ACTION_KEYS, codeLabel } from './input/keybindings';
import {
  createDefaultSaveProvider, downloadSave, loadSaveResult, normalizeSave, pickSaveFile,
  validateSave, type ISaveProvider, type SaveData,
} from './save/save';
import { boxIntersectsBlock } from './player/physics';
import { createCraftAPI } from './api';
import { createServices, TOKENS } from './services';
import { WasmRuntime } from './wasm/runtime';
import type { BuiltinDeps } from './plugins/builtin/deps';
import { builtinPlugins } from './plugins/builtin';
import {
  DiagnosticsRunner,
  type DiagnosticSnapshot, type DiagnosticReport,
} from './diagnostics/RuntimeDiagnostics';

/**
 * 组装根（composition root）。
 * v1.2.0 起只负责：创建服务层 → 构造业务对象 → 注入依赖 → 注册/启用插件 → 启动主循环。
 * 事件接线、UI 反馈、存档追踪等横切逻辑全部下沉到 services/ 与 plugins/。
 */

type Mode = 'title' | 'loading' | 'playing' | 'paused' | 'dead';

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

async function boot() {
  const app = document.getElementById('app')!;
  const uiRoot = document.createElement('div');
  uiRoot.id = 'ui';
  document.body.appendChild(uiRoot);

  // 调试 / 基准参数必须在创建渲染器之前解析：MSAA 只能在上下文创建时决定
  const qs = new URLSearchParams(location.search);
  const aaParam = qs.get('aa');
  let engine: Engine;
  try {
    engine = new Engine(app, { aa: aaParam === 'msaa' || aaParam === 'ssaa' ? aaParam : 'off' });
  } catch {
    uiRoot.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e8e8e8;font-size:15px;background:#1a1a22;padding:24px;text-align:center">当前浏览器不支持 WebGL，无法运行本演示。请更换现代浏览器（Chrome / Edge / Safari / Firefox）。</div>';
    return;
  }

  const { container, events, plugins, extensions } = createServices();
  const registry = new BlockRegistry();
  registerBuiltinBlocks(registry);
  const atlas = new TextureAtlas();
  const sound = new SoundEngine();
  const isMobile = engine.isMobile;
  const particles = new Particles(engine.scene, isMobile ? 380 : 800);

  const idOf = (n: string) => registry.byNameGet(n)!.id;
  const creativeSlots = ['grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log', 'oak_leaves', 'glass', 'torch']
    .map((n) => ({ kind: 'block' as const, id: idOf(n) }));
  const hotbar: HotbarState = { slots: [...creativeSlots], index: 0 };

  // ---- 存档 ----
  // 默认 IndexedDB（localStorage 5MB 上限是丢档隐患），不可用时自动降级；
  // localStorage 里的历史存档会一次性迁移（createDefaultSaveProvider）
  let provider: ISaveProvider = await createDefaultSaveProvider();
  let saved: SaveData | null = null;
  /** H01：加载阶段瞬时故障时旧档状态未知，禁止一切写入以免覆盖清档 */
  let saveBlocked = false;
  /** H01：加载告警延迟到 HUD 建好后展示（toast） */
  let loadWarning: string | null = null;
  const loadRes = await loadSaveResult(provider);
  if (loadRes.status === 'ok') {
    saved = loadRes.data;
  } else if (loadRes.status === 'corrupt') {
    // 坏档先隔离保留，再当新世界开局；绝不静默丢弃旧档
    const kept = (await provider.quarantine?.()) ?? false;
    loadWarning = kept
      ? '检测到损坏的存档，已隔离保留为备份，本次将生成新世界'
      : '检测到损坏的存档且隔离失败，本次将生成新世界（旧档未被删除）';
  } else if (loadRes.status === 'transient-error') {
    saveBlocked = true;
    loadWarning = '存档读取失败，自动保存已暂停以保护旧档（可稍后刷新重试）';
  }
  const pendingSeed = sessionStorage.getItem('mc-ts-new-seed');
  const pendingModeRaw = sessionStorage.getItem('mc-ts-new-mode');
  // H02：卸载镜像（同步写 localStorage）可能比主后端最后一次自动保存更新
  if (saved && pendingSeed === null) {
    try {
      const mirrorRaw = localStorage.getItem('minecraft-ts-save-v1-unload');
      if (mirrorRaw) {
        const mirror = normalizeSave(JSON.parse(mirrorRaw));
        if (mirror && (!saved || mirror.savedAt > saved.savedAt)) {
          saved = mirror;
          void provider.save(mirror);
        }
      }
    } catch { /* 镜像损坏则忽略 */ }
  }
  let seed: number;
  let gameMode: GameMode = saved?.mode ?? 'survival';
  if (pendingSeed !== null) {
    seed = Number(pendingSeed) || randomSeed();
    sessionStorage.removeItem('mc-ts-new-seed');
    sessionStorage.removeItem('mc-ts-new-mode');
    saved = null;
    gameMode = pendingModeRaw === 'creative' ? 'creative' : 'survival';
  } else {
    seed = saved?.seed ?? randomSeed();
  }
  if (saved) {
    if (Array.isArray(saved.hotbar) && saved.hotbar.length === 9) {
      hotbar.slots = saved.hotbar.map((s) => {
        if (!s || s.kind === undefined) return null;
        if (s.kind === 'block' && typeof s.id === 'number' && s.id > 0 && registry.get(s.id).id === s.id) {
          return { kind: 'block' as const, id: s.id };
        }
        if (s.kind === 'item' && typeof s.id === 'string' && ITEMS[s.id]) {
          return { kind: 'item' as const, id: s.id };
        }
        return null;
      });
      hotbar.index = clamp(saved.slot ?? 0, 0, 8);
    }
  }
  // 设置以本地全局配置为准（设置页自动保存，换世界不丢）；
  // 旧存档里的 settings 仅作为「本机从未保存过设置」时的兜底。
  const settings: Options = loadOptions({
    sound: saved?.settings?.sound ?? true,
    renderDistance: saved?.settings?.renderDistance ?? (isMobile ? 3 : 5),
    sensitivity: saved?.settings?.sensitivity ?? 1,
    fov: saved?.settings?.fov ?? 72,
    volume: saved?.settings?.volume ?? 50,
    invertY: saved?.settings?.invertY ?? false,
    autoJump: isMobile,
  });
  sound.setEnabled(settings.sound);
  plugins.setExperimental(settings.experimental);

  // ---- 实验性内容：我的世界 UI 还原（把原版 Java 版风格样式挂到 UI 根节点）----
  // 纯 CSS 主题切换：不改 HUD 的 DOM 逻辑，开关即时生效，导入设置后也会重新应用。
  const applyVanillaUI = (v: boolean) => {
    uiRoot.classList.toggle('vanilla-ui', v);
  };
  applyVanillaUI(settings.vanillaUI);

  // ---- 实验性内容：WASM 内核（默认关闭；?wasm=0 强制关闭）----
  // 必须在 DefaultGenerator 构造前完成自检与后端安装；失败自动回退纯 JS。
  const wasm = new WasmRuntime({
    enabled: settings.experimental && qs.get('wasm') !== '0',
    onReady: (e) => events.emit('wasm:ready', e),
    onFallback: (e) => events.emit('wasm:fallback', e),
  });
  container.provide(TOKENS.Wasm, wasm);
  wasm.init();
  /** 设置页开关：立即生效；WASM 的噪声后端切换不需要重载，插件载体在下次启用插件时读取最新状态 */
  const setExperimental = (v: boolean) => {
    settings.experimental = v;
    persistOptions(settings);
    wasm.setEnabled(v && qs.get('wasm') !== '0');
    plugins.setExperimental(v);
    hud.toast(v ? '已进入实验性内容：WASM 内核已启用' : '实验性内容已关闭：回到纯 JS 内核');
  };

  // ---- 世界 ----
  const world = new World(registry, new DefaultGenerator(seed, registry), events, extensions);
  if (saved) world.loadEdits(saved.edits);
  // 调试/基准开关：?mesher=main 强制同步路径，?greedy=0 关闭合并，?workers=N 覆盖 Worker 池大小
  // ?aa=off|msaa|ssaa 选抗锯齿档位（msaa 需重启上下文，故在 boot 开头解析）
  const workersParam = qs.get('workers');
  // 实验对照：?emerge=0 保留 v1.5.1 的独立 emissive 通道（默认并入不透明通道）
  const chunks = new ChunkManager(world, engine.scene, atlas, events, settings.renderDistance, {
    forceMainThread: qs.get('mesher') === 'main',
    greedy: qs.get('greedy') !== '0',
    mergeEmissive: qs.get('emerge') !== '0',
    workers: workersParam != null ? Number(workersParam) : undefined,
    camera: engine.camera,
  });
  // 开发者设置：网格化线程（URL 调试参数优先，其次才看设置页）
  if (workersParam == null && qs.get('mesher') !== 'main') {
    if (settings.mesherThreads === 'main') chunks.setWorkerPoolSize(0);
    else if (settings.mesherThreads !== 'auto') chunks.setWorkerPoolSize(settings.mesherThreads);
  }
  if (!qs.has('greedy')) chunks.greedy = settings.greedy;
  const sky = new Sky(engine.scene, engine.camera, () => chunks.renderDistance, events, isMobile);
  if (saved) sky.dayTime = saved.dayTime ?? 0.32;
  const entities = new EntityManager(world, engine.scene, events, seed, particles);

  // ---- 生存状态 ----
  const survival = new SurvivalState(events, registry, extensions);
  survival.mode = gameMode;
  if (saved?.survival) survival.restore(saved.survival);
  if (!saved) {
    if (gameMode === 'survival') {
      // 新手补给：2 个苹果垫饥饿，8 支火把用于洞穴照明
      survival.addItem('apple', 2);
      survival.addDrop('torch', 8);
      hotbar.slots = [{ kind: 'item', id: 'apple' }, ...creativeSlots.slice(0, 8).map(() => null)];
      hotbar.index = 0;
    } else {
      hotbar.slots = [...creativeSlots];
      hotbar.index = 0;
    }
  }

  // 可见掉落物：拾取回写生存背包；几何与材质由 DropManager 内部共享缓存
  const drops = new DropManager({
    scene: engine.scene, atlas, seed: world.generator.seed, world, particles, sound,
    onPickup: (name, count) => survival.addDrop(name, count),
  });

  const input = new Input(engine.renderer.domElement, isMobile);
  const player = new Player(world, engine.camera, input, registry, atlas, events, sound, particles,
    survival, hotbar, entities, engine.scene, isMobile);
  player.dropManager = drops;
  const botany = new Botany(world, registry, seed, events, { isMobile });
  player.setBotany(botany);
  // 沙 / 沙砾重力：破坏 / 放置 / 爆炸 / 落地的方块更新都走 triggerColumn
  const falling = new FallingSystem(world, registry, atlas, engine.scene, events);
  falling.onPlantDrop = (def, x, y, z) => player.collectDrops(def, x, y, z);
  player.setFalling(falling);
  // H09：落点在玩家/生物 AABB 内的沙块悬停等待，不实体化进实体
  falling.isBlocked = (x, y, z) => {
    if (boxIntersectsBlock(player.pos, player.width, player.height, x, y, z)) return true;
    return entities.entities.some((e) => boxIntersectsBlock(e.pos, e.width, e.height, x, y, z));
  };
  // 植物蓄能开花：以粒子反馈「这不是纯装饰」——能量越高，生态越活跃
  events.on('plant:bloom', ({ x, y, z, block }) => {
    const def = registry.get(block);
    const color = atlas.avgColor(def.tiles.side);
    particles.burst(x + 0.5, y + 0.7, z + 0.5, color, 10, 0.3, 1.4);
    particles.burst(x + 0.5, y + 0.8, z + 0.5, [1, 0.93, 0.55], 5, 0.22, 1.1);
  });
  if (saved) {
    player.teleport(saved.player.x, saved.player.y, saved.player.z);
    player.yaw = saved.player.yaw;
    player.pitch = saved.player.pitch;
    player.fly = saved.player.fly && gameMode === 'creative';
    if (survival.health <= 0) {
      // 死亡状态下退出，回到游戏时先复活，避免 0 血继续游玩
      survival.health = MAX_HEALTH;
      survival.hunger = Math.max(survival.hunger, 10);
    }
    survival.dead = false;
  }
  /** 画质档位：自动档回到 100% 分辨率，交给自适应逐帧调整 */
  const applyQuality = (mode: QualityMode) => {
    engine.setQualityScale(qualityScale(mode) ?? 1);
  };

  engine.camera.fov = settings.fov;
  engine.camera.updateProjectionMatrix();
  input.sensitivity = settings.sensitivity;
  input.invertY = settings.invertY;
  sound.setVolume(settings.volume);
  chunks.setRenderDistance(settings.renderDistance);
  particles.enabled = settings.particles;
  player.viewBob = settings.viewBob;
  player.autoJump = settings.autoJump;
  applyQuality(settings.quality);
  // 实验性玩法初始值（从 localStorage / 存档还原后立即推送到子系统）
  botany.setTickSpeed(settings.randomTickSpeed);
  sky.advanceTime = settings.doDaylightCycle;
  survival.keepInventory = settings.keepInventory;
  entities.allowSpawn = settings.doMobSpawning;
  sky.setCloudsEnabled(settings.showClouds);
  falling.enabled = settings.blockGravity;
  chunks.transparentSortEnabled = settings.sortTransparent;

  const tntList: PrimedTnt[] = [];
  const highlight = new BlockHighlight(engine.scene);
  let mode: Mode = 'title';
  // 开发者设置「显示调试信息」：常显 F3 面板
  let debugOn = settings.debugOverlay;
  let dirtySave = false;
  /** 脏标记版本：保存期间产生的编辑不能被旧保存的回调清掉（异步 provider 竞态） */
  let dirtyVersion = 0;
  /** 保存序号：只允许最新一次保存清脏标记 */
  let saveSeq = 0;
  let lastSaveOkAt = 0;
  let lastSaveFailToastAt = 0;
  const markDirty = () => {
    dirtySave = true;
    dirtyVersion++;
  };
  let saveAcc = 0;
  let debugAcc = 0;
  let wasUnderwater = false;
  let paletteReturn: 'game' | 'menu' = 'game';
  /** 合成界面的来源：关闭后回到菜单还是直接恢复游戏 */
  let craftingReturn: 'game' | 'menu' = 'game';
  /** 新世界 / 导入存档触发 reload 时，禁止 beforeunload 用旧状态反写存档 */
  let suppressUnloadSave = false;

  const touch = isMobile ? new TouchControls(input, uiRoot, engine.renderer.domElement) : null;
  touch?.setVisible(false);
  if (touch) touch.lookScale = settings.touchSensitivity;
  /** 关键操作的轻触感反馈（仅移动端、不支持时静默跳过） */
  const buzz = (ms: number) => {
    if (!isMobile) return;
    try { navigator.vibrate?.(ms); } catch { /* 忽略 */ }
  };

  // ---- 存档逻辑 ----
  const collectSave = (): SaveData => ({
    version: 2,
    seed,
    mode: survival.mode,
    edits: [...world.edits.entries()],
    player: { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch, fly: player.fly },
    survival: survival.serialize(),
    dayTime: sky.dayTime,
    hotbar: [...hotbar.slots],
    slot: hotbar.index,
    settings: { ...settings },
    dayCount: sky.dayCount,
    botany: botany.serializeEcology(),
    savedAt: Date.now(),
  });
  const saveNow = () => {
    if (saveBlocked) return; // H01：旧档状态未知，写入即覆盖清档
    const data = collectSave();
    const seq = ++saveSeq;
    const version = dirtyVersion;
    provider.save(data)
      .then((bytes) => {
        // 仅当没有更新的保存、且快照之后没有新编辑时才清脏；
        // 否则异步 provider 的旧回调会吞掉新编辑的脏标记。
        // 过期保存的结果不能覆盖最新状态：仅最新一次保存才更新成功时间与事件
        if (seq !== saveSeq) return;
        if (version === dirtyVersion) dirtySave = false;
        lastSaveOkAt = Date.now();
        // H04：bytes 现在是 provider 返回的轻量度量（edits 条数），不再 stringify 全档
        events.emit('save:done', { bytes: typeof bytes === 'number' ? bytes : 0 });
      })
      .catch((e) => {
        // 保存失败时保留 dirty 标记，8 秒后重试；旧保存的失败不覆盖新保存结果
        if (seq === saveSeq) dirtySave = true;
        console.warn('存档失败', e);
        // H03：失败不能只打 console——玩家要有感知（30 秒节流，避免每个 autosave 周期刷屏）
        if (Date.now() - lastSaveFailToastAt > 30000) {
          lastSaveFailToastAt = Date.now();
          hud.toast('存档保存失败：可能是存储空间不足，建议先导出存档备份');
        }
      });
    saveAcc = 0;
  };

  /** 导入存档（文件 / CraftAPI 同路径）：校验 → 落盘 → 重载世界 */
  const applySaveData = async (data: SaveData) => {
    if (!validateSave(data)) throw new Error('存档格式校验失败：缺少必要字段或字段类型错误');
    await provider.save(data);
    // 导入成功后禁止卸载保存，否则 reload 会把当前状态覆盖到刚导入的存档上
    suppressUnloadSave = true;
    location.reload();
  };

  // ---- TNT ----
  const igniteTnt = (x: number, y: number, z: number, playSound: boolean) => {
    const def = registry.get(world.getBlock(x, y, z));
    if (def.name !== 'tnt') return;
    world.setBlock(x, y, z, AIR);
    if (playSound) sound.fuse();
    events.emit('block:ignite', { x, y, z });
    markDirty();
  };
  events.on('block:ignite', ({ x, y, z }) => {
    tntList.push(new PrimedTnt(world, atlas, registry, engine.scene, x, y, z, explode));
  });

  function explode(cx: number, cy: number, cz: number, r: number) {
    const ri = Math.ceil(r);
    const destroyed: [number, number, number, BlockId][] = [];
    for (let dx = -ri; dx <= ri; dx++) {
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dz = -ri; dz <= ri; dz++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy, z = Math.floor(cz) + dz;
          const id = world.getBlock(x, y, z);
          const def = registry.get(id);
          if (id === AIR || def.liquid || !Number.isFinite(def.hardness)) continue;
          destroyed.push([x, y, z, id]);
        }
      }
    }
    // M04：批量写入爆炸破坏的方块，光照在末尾统一排空（deferred flush），
    // 避免球形区域内相邻格的光照回收重复触发完整 BFS。
    world.setBlocks(destroyed.map(([x, y, z]) => [x, y, z, AIR] as [number, number, number, BlockId]));
    for (const [x, y, z, id] of destroyed) {
      if (registry.get(id).name === 'tnt') {
        events.emit('block:ignite', { x, y, z });
      } else {
        events.emit('block:break', { x, y, z, block: id });
      }
      // 爆炸也是一次方块更新：上方失支撑的沙类 / 植物随之处理
      falling.triggerColumn(x, y + 1, z);
    }
    particles.burst(cx, cy, cz, [1, 0.72, 0.3], isMobile ? 55 : 90, r * 0.45, 9);
    particles.burst(cx, cy, cz, [0.45, 0.42, 0.4], isMobile ? 40 : 60, r * 0.5, 7);
    sound.explosion();
    hud.flash();
    const blastCenter = new THREE.Vector3(cx, cy, cz);

    // M13: 视线检查辅助函数——从爆炸中心向目标发射射线，若被实体方块阻挡则返回 false
    const hasLineOfSight = (target: THREE.Vector3): boolean => {
      const dir = new THREE.Vector3().subVectors(target, blastCenter);
      const dist = dir.length();
      if (dist === 0) return true;
      dir.normalize();
      const hit = world.raycast(blastCenter.clone(), dir, dist - 0.01);
      return hit === null;
    };

    const dist = player.pos.distanceTo(blastCenter);
    player.shake(clamp(0.75 * (1 - dist / 12), 0, 0.75));
    if (survival.isSurvival && dist < r * 1.6 && hasLineOfSight(player.pos)) {
      survival.damage(Math.round(9 * (1 - dist / (r * 1.6))), '爆炸');
    }
    for (const e of entities.entities) {
      const d = e.pos.distanceTo(blastCenter);
      if (d < r * 2.5 && d > 0.01 && hasLineOfSight(e.pos)) {
        const k = 9 / Math.max(1, d);
        e.vel.x += (e.pos.x - cx) * k;
        e.vel.y += 4 * k;
        e.vel.z += (e.pos.z - cz) * k;
      }
    }
    events.emit('explosion', { center: { x: cx, y: cy, z: cz }, radius: r });
    markDirty();
  }

  // ---- HUD ----
  const stackBlock = (s: Stack | null): BlockId => (s && s.kind === 'block' ? (s.id as BlockId) : AIR);
  const selectSlot = (i: number) => {
    hotbar.index = ((i % 9) + 9) % 9;
    events.emit('hotbar:select', { index: hotbar.index, block: stackBlock(hotbar.slots[hotbar.index]) });
    sound.click(700);
    markDirty();
  };

  /**
   * 合成背包宿主：把 SurvivalState 的背包（'b:<id>' / 'i:<name>' 键）
   * 与合成核心的材料标识（方块名 / 'item:xxx'）互相转换。
   *
   * UI 只认材料标识，生存状态只认背包键，转换全部收在这里。
   */
  const craftingHost: CraftingHost = {
    getMaterials(): CraftingMaterial[] {
      const out: CraftingMaterial[] = [];
      for (const [key, count] of survival.inventory) {
        if (count <= 0) continue;
        const material = inventoryKeyToMaterial(key, registry);
        if (!material) continue;
        out.push({ material, count });
      }
      return out;
    },
    take(material: MaterialId): boolean {
      const stack = materialToStack(material, registry);
      if (!stack) return false;
      const key = stack.kind === 'block' ? `b:${stack.id}` : `i:${stack.id}`;
      if (survival.countKey(key) <= 0) return false;
      survival.consume(stack, 1);
      return true;
    },
    giveBack(material: MaterialId): void {
      const stack = materialToStack(material, registry);
      if (!stack) return;
      if (stack.kind === 'block') survival.addBlock(stack.id, 1);
      else survival.addItem(stack.id, 1);
    },
    produce(material: MaterialId, count: number): void {
      const stack = materialToStack(material, registry);
      if (!stack) return;
      if (stack.kind === 'block') survival.addBlock(stack.id, count);
      else survival.addItem(stack.id, count);
    },
    onCrafted(recipe, result) {
      events.emit('crafting:crafted', { recipe: recipe.id, result: result.material, count: result.count });
      sound.click(880);
      hud.toast(`合成成功：${recipe.label} ×${result.count}`);
    },
    onClose() {
      closeCrafting();
    },
  };

  const hud = new HUD({
    uiRoot, atlas, registry, hotbar, isMobile,
    craftingHost,
    onStart: (cont, chosen) => {
      if (cont) { void startGame(true); return; } // 继续游戏保留存档模式
      // 标题页选的模式必须真正写回状态机，否则选「创造」仍会进入生存
      survival.mode = chosen;
      gameMode = chosen;
      if (chosen === 'survival') {
        // boot 已发过补给，避免重复进入标题再开局时叠加成 4 个苹果
        if (survival.countKey('i:apple') === 0) survival.addItem('apple', 2);
        if (survival.countKey(`b:${idOf('torch')}`) === 0) survival.addDrop('torch', 8);
        hotbar.slots = [{ kind: 'item', id: 'apple' }, ...Array.from({ length: 8 }, () => null)];
      } else {
        hotbar.slots = [...creativeSlots];
      }
      hotbar.index = 0;
      player.setHeldStack(hotbar.slots[0]);
      syncUseMode();
      void startGame(false);
    },
    onNewWorld: (s, m) => void newWorld(s, m),
    onResume: () => resumeGame(),
    onQuitToTitle: () => quitToTitle(),
    onSlot: (i) => { if (mode === 'playing') selectSlot(i); },
    onAssign: (id) => {
      events.emit('hotbar:select', { index: hotbar.index, block: id });
      markDirty();
    },
    onSoundToggle: () => {
      settings.sound = !settings.sound;
      sound.setEnabled(settings.sound);
      hud.setSound(settings.sound);
      if (settings.sound) sound.click(880);
      persistOptions(settings);
      markDirty();
    },
    onCamera: () => { if (mode === 'playing') cycleCamera(); },
    onFly: () => {
      if (mode !== 'playing') return;
      if (!player.toggleFly()) {
        hud.toast('生存模式不能飞行，切换到创造模式即可');
        return;
      }
      hud.setFlyActive(player.fly);
      hud.toast(player.fly ? '飞行模式：空格上升 / Shift下降' : '行走模式');
    },
    onMenu: () => {
      if (mode === 'playing') openMenu();
      else if (mode === 'paused') resumeGame();
    },
    onRenderDistance: (v) => { settings.renderDistance = v; chunks.setRenderDistance(v); persistOptions(settings); markDirty(); },
    onSensitivity: (v) => { settings.sensitivity = v; input.sensitivity = v; persistOptions(settings); markDirty(); },
    onFov: (v) => { settings.fov = v; engine.camera.fov = v; engine.camera.updateProjectionMatrix(); persistOptions(settings); markDirty(); },
    onVolume: (v) => { settings.volume = v; sound.setVolume(v); persistOptions(settings); markDirty(); },
    onInvertY: (v) => { settings.invertY = v; input.invertY = v; persistOptions(settings); markDirty(); },
    onQuality: (v) => { settings.quality = v; applyQuality(v); persistOptions(settings); markDirty(); },
    onParticles: (v) => { settings.particles = v; particles.enabled = v; persistOptions(settings); markDirty(); },
    onViewBob: (v) => { settings.viewBob = v; player.viewBob = v; persistOptions(settings); markDirty(); },
    onAutoJump: (v) => { settings.autoJump = v; player.autoJump = v; persistOptions(settings); markDirty(); },
    onTouchSensitivity: (v) => {
      settings.touchSensitivity = v;
      if (touch) touch.lookScale = v;
      persistOptions(settings);
      markDirty();
    },
    onDebugOverlay: (v) => {
      settings.debugOverlay = v;
      debugOn = v;
      if (!v) hud.setDebug(null);
      persistOptions(settings);
      markDirty();
    },
    onGreedy: (v) => { settings.greedy = v; chunks.greedy = v; persistOptions(settings); markDirty(); },
    onMesherThreads: (v) => {
      settings.mesherThreads = v;
      applyMesherThreads(v);
      hud.toast(v === 'main' ? '网格化已切到主线程（对照基准会变慢）' : '网格化线程已调整');
      persistOptions(settings);
      markDirty();
    },
    onAutosaveInterval: (v) => { settings.autosaveInterval = v; saveAcc = 0; persistOptions(settings); markDirty(); },
    onExperimental: (v) => setExperimental(v),
    // ---- 实验性玩法：即时生效 + 反馈 + 持久化 ----
    onRandomTickSpeed: (v: RandomTickSpeed) => {
      settings.randomTickSpeed = v;
      botany.setTickSpeed(v);
      hud.toast(`随机刻速度：${['暂停生长', '慢', '标准', '快'][v]}`);
      persistOptions(settings);
      markDirty();
    },
    onDaylightCycle: (v) => {
      settings.doDaylightCycle = v;
      sky.advanceTime = v;
      hud.toast(v ? '昼夜循环已开启：时间继续流动' : '昼夜循环已冻结：太阳定格当前时刻');
      persistOptions(settings);
      markDirty();
    },
    onKeepInventory: (v) => {
      settings.keepInventory = v;
      survival.keepInventory = v;
      hud.toast(v ? '死亡保留物品：开启' : '死亡保留物品：关闭（死亡将清空背包）');
      persistOptions(settings);
      markDirty();
    },
    onMobSpawning: (v) => {
      settings.doMobSpawning = v;
      entities.allowSpawn = v;
      hud.toast(v ? '生物生成：开启' : '生物生成：关闭（现有生物将逐渐消散）');
      persistOptions(settings);
      markDirty();
    },
    onShowClouds: (v) => {
      settings.showClouds = v;
      sky.setCloudsEnabled(v);
      hud.toast(v ? '体素云层：开启' : '体素云层：关闭（省电）');
      persistOptions(settings);
      markDirty();
    },
    onBlockGravity: (v) => {
      settings.blockGravity = v;
      falling.enabled = v;
      hud.toast(v ? '方块重力：开启' : '方块重力：关闭（悬空方块保持原位）');
      persistOptions(settings);
      markDirty();
    },
    onSortTransparent: (v) => {
      settings.sortTransparent = v;
      chunks.transparentSortEnabled = v;
      hud.toast(v ? '透明排序：开启' : '透明排序：关闭（玻璃/水可能穿帮）');
      persistOptions(settings);
      markDirty();
    },
    onVanillaUI: (v) => {
      settings.vanillaUI = v;
      applyVanillaUI(v);
      persistOptions(settings);
      hud.toast(v ? '我的世界 UI 还原：已切换为原版 Java 版风格' : '我的世界 UI 还原：已关闭，恢复默认界面');
      markDirty();
    },
    onExportOptions: () => JSON.stringify(settings, null, 2),
    onCopyOptions: (json) => {
      void copyText(json);
    },
    onImportOptions: (json) => importOptions(json),
    onResetOptions: () => {
      Object.assign(settings, normalizeOptions({}, { renderDistance: isMobile ? 3 : 5 }));
      applyAllSettings();
      persistOptions(settings);
      hud.syncOptions(settings);
      markDirty();
    },
    onOptionsOpen: (from) => openOptions(from),
    onOptionsClose: () => closeOptions(),
    getOptions: () => settings,
    onPaletteOpen: (from) => openPalette(from),
    onPaletteClose: () => closePalette(),
    onCraftOpen: (from) => openCrafting(from),
    onRespawn: () => respawn(),
    onModeToggle: () => toggleGameMode(),
    onExportSave: () => {
      downloadSave(collectSave());
      hud.toast('存档已导出为 .json 文件');
    },
    onImportSave: () => {
      void pickSaveFile().then((data) => {
        if (!data) return;
        void applySaveData(data);
      }, (e) => {
        hud.toast(`导入失败：${e instanceof Error ? e.message : '文件无法读取'}`);
      });
    },
    getBindings: () => {
      const b = input.getBindings();
      return ACTION_KEYS.map((a) => ({ action: a, label: ACTION_LABELS[a], keyLabel: codeLabel(b[a]) }));
    },
    onRebind: (action, code) => {
      input.setBinding(action as Parameters<typeof input.setBinding>[0], code);
    },
    onResetBindings: () => input.resetBindings(),
    isSurvival: () => survival.isSurvival,
    getCount: (s) => survival.countStack(s),
  });

  // 按键捕获阶段优先于 Input：重绑定面板等待按键时消费该事件，避免触发游戏动作
  addEventListener('keydown', (e) => {
    if (hud.keybindOpen && hud.captureKey(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  hud.setSound(settings.sound);
  hud.refreshTitleButtons(!!saved, saved?.mode);
  hud.setFlyActive(player.fly);

  /** 开发者设置：网格化线程（auto = 按核数推断，main = 主线程同步） */
  const applyMesherThreads = (v: MesherThreads) => {
    if (v === 'auto') chunks.setWorkerPoolSize(chunks.recommendedPoolSize());
    else if (v === 'main') chunks.setWorkerPoolSize(0);
    else chunks.setWorkerPoolSize(v);
  };

  /** 导出面板用：写进剪贴板，失败时提示手动复制 */
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      hud.toast('设置 JSON 已复制到剪贴板');
    } catch {
      hud.toast('复制失败：请手动全选文本框内容复制');
    }
  };

  /** 导入面板用：只接受设置里已知的键，逐字段钳制后整体生效；返回生效字段数 */
  const importOptions = (json: string): number => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      hud.toast('导入失败：不是有效的 JSON');
      return 0;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      hud.toast('导入失败：设置 JSON 应该是对象');
      return 0;
    }
    const src = parsed as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(settings)) {
      if (key in src) filtered[key] = src[key];
    }
    const keys = Object.keys(filtered);
    if (keys.length === 0) {
      hud.toast('导入失败：JSON 里没有可识别的设置项');
      return 0;
    }
    Object.assign(settings, normalizeOptions(filtered as Partial<Options>, settings));
    applyAllSettings();
    persistOptions(settings);
    hud.syncOptions(settings);
    hud.showOptionsIO(false);
    hud.toast(`已导入 ${keys.length} 项设置`);
    markDirty();
    return keys.length;
  };

  /** 把设置一次性推到各子系统（启动与「重置全部设置」共用） */
  const applyAllSettings = () => {
    sound.setEnabled(settings.sound);
    sound.setVolume(settings.volume);
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    chunks.setRenderDistance(settings.renderDistance);
    engine.camera.fov = settings.fov;
    engine.camera.updateProjectionMatrix();
    hud.setSound(settings.sound);
    particles.enabled = settings.particles;
    player.viewBob = settings.viewBob;
    player.autoJump = settings.autoJump;
    if (touch) touch.lookScale = settings.touchSensitivity;
    applyQuality(settings.quality);
    debugOn = settings.debugOverlay;
    if (!debugOn) hud.setDebug(null);
    chunks.greedy = settings.greedy;
    applyMesherThreads(settings.mesherThreads);
    // 实验性玩法：启动 / 重置 / 导入时统一推送到各子系统
    botany.setTickSpeed(settings.randomTickSpeed);
    sky.advanceTime = settings.doDaylightCycle;
    survival.keepInventory = settings.keepInventory;
    entities.allowSpawn = settings.doMobSpawning;
    sky.setCloudsEnabled(settings.showClouds);
    falling.enabled = settings.blockGravity;
    chunks.transparentSortEnabled = settings.sortTransparent;
    applyVanillaUI(settings.vanillaUI);
  };

  // 空手右键工作台方块 → 打开合成界面
  events.on('crafting:open', () => openCrafting('game'));
  const cycleCamera = () => {
    player.cycleCamera();
    hud.toast(['第一人称视角', '第三人称（背面）', '第三人称（正面）'][player.cameraMode]);
  };

  /** 生物死亡掉落生成可见物；创造模式不产生掉落 */
  entities.onDrop = (name, count, x, y, z, source) => {
    if (!survival.isSurvival) return;
    drops.spawn(name, count, x, y, z, source);
  };

  // ---- 状态机 ----
  async function startGame(cont: boolean) {
    if (mode !== 'title') return;
    drops.clear(); // 掉落物不进存档，开局一律从空开始
    sound.unlock();
    // 指针锁定必须发生在用户手势的同步调用栈里，不能等 await 之后再请求
    input.requestLock();
    mode = 'loading';
    hud.showTitle(false);
    hud.setLoading(0, '扩展世界…');
    if (cont && saved) {
      player.teleport(saved.player.x, saved.player.y, saved.player.z);
      player.yaw = saved.player.yaw;
      player.pitch = saved.player.pitch;
      player.fly = saved.player.fly && survival.mode === 'creative';
      sky.setTime(saved.dayTime, saved.dayCount ?? 0);
    } else {
      player.spawn();
      survival.spawn = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    }
    await chunks.initialLoad(player.pos.x, player.pos.z, Math.min(settings.renderDistance, 3),
      (p) => hud.setLoading(p));
    // 生态状态在区块就绪后恢复：恢复函数会逐条校验当前方块是否仍是该植物
    if (cont && saved?.botany) botany.restoreEcology(saved.botany);
    // 死亡存档继续游戏时必须复活，否则 player.update 会永久冻结
    ensureAlive();
    // 防止卡在方块里（换地形算法后的旧存档尤其需要）
    {
      const px = Math.floor(player.pos.x);
      const pz = Math.floor(player.pos.z);
      const terrain = world.generator.surfaceHeight(px, pz);
      if (player.pos.y < terrain + 1.02) player.pos.y = terrain + 1.02;
      let y = Math.floor(player.pos.y);
      for (let i = 0; i < 16; i++) {
        if (!world.isSolidAt(px, y, pz) && !world.isSolidAt(px, y + 1, pz)) {
          player.pos.y = y + 0.02;
          break;
        }
        y++;
      }
      player.vel.set(0, 0, 0);
      player.resetFallDistance();
    }
    hud.setLoading(null);
    hud.setPlaying(true);
    touch?.setVisible(true);
    mode = 'playing';
    input.enabled = true;
    input.reset();
    // 丢弃加载期间累积的视角增量，避免进入世界瞬间镜头跳动
    input.consumeLook();
    hud.setFlyActive(player.fly);
    hud.setSurvival(survival);
    hud.updateHotbar();
    syncUseMode();
    events.emit('game:start', { seed });
    for (let i = 0; i < 5; i++) entities.trySpawnNear(player.pos);
    if (survival.isSurvival) {
      hud.toast(isMobile ? '生存模式：挖方块、吃苹果、躲僵尸' : '生存模式：按住左键挖掘 · 右键放置/进食 · 夜晚小心僵尸');
    } else {
      hud.toast(isMobile ? '左侧摇杆移动 · 右侧拖动视角 · 轻点破坏' : 'WASD 移动 · 左键破坏 · 右键放置 · E 打开方块库');
    }
    window.setTimeout(() => hud.fadeHint(), 12000);
    markDirty();
  }

  async function newWorld(s?: number, m?: GameMode) {
    drops.clear();
    sound.unlock();
    await provider.clear();
    // 清空成功后再禁止卸载保存，避免 beforeunload 把旧状态写回去
    suppressUnloadSave = true;
    sessionStorage.setItem('mc-ts-new-seed', String(s ?? randomSeed()));
    sessionStorage.setItem('mc-ts-new-mode', m ?? 'survival');
    location.reload();
  }

  function openMenu() {
    if (mode !== 'playing') return;
    mode = 'paused';
    input.enabled = false;
    input.reset();
    input.exitLock();
    hud.setMenuMode(survival.mode, survival.health, survival.hunger);
    hud.showMenu(true);
    saveNow();
    events.emit('game:pause', { paused: true });
  }

  function resumeGame() {
    if (mode !== 'paused') return;
    hud.showMenu(false);
    hud.showPalette(false);
    hud.showHelp(false);
    hud.showOptions(false);
    mode = 'playing';
    input.enabled = true;
    input.requestLock();
    events.emit('game:pause', { paused: false });
  }

  function openPalette(from: 'game' | 'menu') {
    paletteReturn = from;
    if (mode === 'playing') {
      mode = 'paused';
      input.enabled = false;
      input.reset();
      input.exitLock();
      // 方块库与菜单一样属于暂停态，必须发事件（v1.1.2 遗漏，插件依赖此钩子）
      events.emit('game:pause', { paused: true });
    }
    hud.showMenu(false);
    hud.showPalette(true);
  }

  function closePalette() {
    hud.showPalette(false);
    if (paletteReturn === 'menu') hud.showMenu(true);
    else resumeGame();
  }

  /** 设置页：可从游戏中 / 暂停菜单 / 标题屏进入，关闭时回到来源处 */
  let optionsReturn: 'game' | 'menu' | 'title' = 'game';

  function openOptions(from: 'game' | 'menu' | 'title') {
    optionsReturn = from;
    if (mode === 'playing') {
      mode = 'paused';
      input.enabled = false;
      input.reset();
      input.exitLock();
      // 与方块库一致：属于暂停态，插件依赖此钩子
      events.emit('game:pause', { paused: true });
    }
    hud.showMenu(false);
    hud.showOptions(true);
  }

  function closeOptions() {
    hud.showOptions(false);
    if (optionsReturn === 'menu') hud.showMenu(true);
    else if (optionsReturn === 'game') resumeGame();
    // 标题屏：直接盖回标题，无需额外操作
  }

  /**
   * 打开合成界面。
   *
   * 生存模式专用：创造模式背包为空，合成没有意义。
   * 与方块库一样属于暂停态（游戏暂停 + 释放指针锁），否则鼠标会被游戏吃掉。
   */
  function openCrafting(from: 'game' | 'menu') {
    if (!survival.isSurvival) {
      hud.toast('创造模式不需要合成');
      return;
    }
    craftingReturn = from;
    if (mode === 'playing') {
      mode = 'paused';
      input.enabled = false;
      input.reset();
      input.exitLock();
      events.emit('game:pause', { paused: true });
    }
    hud.showMenu(false);
    hud.showCrafting('工作台');
  }

  function closeCrafting() {
    hud.hideCrafting();
    if (craftingReturn === 'menu') hud.showMenu(true);
    else resumeGame();
  }

  function quitToTitle() {
    saveNow();
    saved = collectSave();
    mode = 'title';
    // 退出标题：清理现存实体（生物/动物）与移除 PrimedTnt / 下落沙的网格——标题界面不残留游走的实体
    for (const e of [...entities.entities]) entities.despawn(e);
    for (const t of [...tntList]) {
      tntList.splice(tntList.indexOf(t), 1);
      t.remove();
    }
    falling.clear();
    drops.clear();
    input.enabled = false;
    input.reset();
    input.exitLock();
    hud.setPlaying(false);
    hud.hideDeath();
    touch?.setVisible(false);
    hud.showMenu(false);
    hud.showPalette(false);
    hud.showHelp(false);
    hud.showOptions(false);
    hud.showTitle(true);
    hud.refreshTitleButtons(true, survival.mode);
  }

  /** 回到游戏前的兜底：死亡存档继续游戏时必须复活 */
  function ensureAlive() {
    if (survival.health > 0 && !survival.dead) return;
    survival.health = MAX_HEALTH;
    survival.hunger = Math.max(survival.hunger, 10);
    survival.dead = false;
    hud.hideDeath();
  }

  /** 死亡 → 重生（物品保留） */
  function respawn() {
    const sp = survival.spawn;
    drops.clear();
    survival.respawn(sp);
    player.teleport(sp.x, sp.y + 0.2, sp.z);
    player.vel.set(0, 0, 0);
    hud.hideDeath();
    hud.setPlaying(true);
    touch?.setVisible(true);
    mode = 'playing';
    input.enabled = true;
    input.requestLock();
    chunks.setCenter(player.pos.x, player.pos.z);
    markDirty();
  }

  /** 模式切换后按背包重建快捷栏，避免创造模式的无限方块格变成 count=0 的幽灵格 */
  function rebuildHotbar() {
    if (survival.isSurvival) {
      const owned: Stack[] = [];
      for (const [key, count] of survival.inventory) {
        if (count > 0) owned.push(parseKey(key));
      }
      hotbar.slots = Array.from({ length: 9 }, (_, i) => owned[i] ?? null);
    } else {
      hotbar.slots = [...creativeSlots];
    }
    hotbar.index = clamp(hotbar.index, 0, 8);
    player.setHeldStack(hotbar.slots[hotbar.index]);
    syncUseMode();
  }

  /** 统一的模式切换：菜单按钮与 CraftAPI 共用，保证死亡态 / 飞行状态一致 */
  function applyMode(m: GameMode) {
    const wasDead = survival.dead || survival.health <= 0;
    survival.mode = m;
    gameMode = m;
    player.fly = false;
    // 创造模式飞行下降积累的 fallVy 不能带到生存模式
    player.resetFallDistance();
    if (m === 'creative') {
      if (survival.health <= 0) survival.health = MAX_HEALTH;
    } else {
      survival.health = Math.max(1, survival.health);
      survival.hunger = Math.max(survival.hunger, 8);
    }
    if (wasDead && survival.health > 0) {
      survival.dead = false;
      hud.hideDeath();
    }
    rebuildHotbar();
    hud.setFlyActive(player.fly);
    hud.setMenuMode(survival.mode, survival.health, survival.hunger);
    hud.setSurvival(survival);
    hud.updateHotbar();
    syncUseMode();
    markDirty();
  }

  /** 生存 / 创造切换 */
  function toggleGameMode() {
    applyMode(survival.mode === 'survival' ? 'creative' : 'survival');
    hud.toast(survival.mode === 'survival'
      ? '已切换到生存模式：注意生命、饥饿与夜晚的僵尸'
      : '已切换到创造模式：无限方块、可飞行');
  }

  /** 移动端“放置”键的语义跟随手持物 */
  function syncUseMode() {
    const s = player.selectedStack();
    touch?.setUseMode(!s ? 'none' : s.kind === 'item' ? 'item' : 'block');
  }

  // ---- 运行时诊断组：只读快照 / API / F3 面板共用同一套检查 ----
  const collectDiagnostics = (): DiagnosticSnapshot => {
    const pcx = Math.floor(player.pos.x / 16);
    const pcz = Math.floor(player.pos.z / 16);
    const margin = chunks.renderDistance + 1;
    let generated = 0;
    let unlitChunks = 0;
    let missingMeshes = 0;
    for (const chunk of world.chunks.values()) {
      if (!chunk.generated) continue;
      generated++;
      if (!chunk.lit) unlitChunks++;
      if (Math.abs(chunk.cx - pcx) > margin || Math.abs(chunk.cz - pcz) > margin) continue;
      if (!chunks.hasMesh(chunk.cx, chunk.cz) && !chunks.hasInFlight(chunk.cx, chunk.cz)) {
        missingMeshes++;
      }
    }
    const ev = events.stats();
    return {
      version: VERSION,
      mode,
      gameMode: survival.mode,
      player: {
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        fallDistance: player.fallDistance,
      },
      input: { enabled: input.enabled, pressedKeys: input.pressedKeys },
      chunks: {
        loading: chunks.isLoading,
        mesherMode: chunks.mesherMode,
        workerCount: chunks.workerCount,
        renderDistance: chunks.renderDistance,
        generated,
        meshed: chunks.meshCount,
        dirty: world.dirty.size,
        inFlight: chunks.inFlightCount,
        configReady: chunks.configReady,
        configRevision: chunks.configRevisionValue,
        missingMeshes,
        unlitChunks,
        meshQuads: chunks.meshStats.quads,
        meshChunks: chunks.meshStats.chunks,
      },
      plugins: plugins.list().map((p) => ({
        id: p.manifest.id,
        state: p.state,
        dependencies: p.manifest.dependencies ?? [],
      })),
      wasm: (() => {
        const ws = wasm.stats();
        return {
          status: ws.status,
          abi: ws.abi,
          fallbackCount: ws.fallbacks,
          selfCheckMismatches: ws.selfCheckMismatches,
        };
      })(),
      events: {
        subscribers: ev.subscribers,
        channels: ev.channels.length,
        emitted: Object.values(ev.emitted).reduce((a, b) => a + b, 0),
      },
      survival: {
        health: survival.health, hunger: survival.hunger,
        breath: survival.breath, dead: survival.dead,
      },
      entities: entities.entities.length,
      plant: (() => {
        const stats = botany.stats(player.pos.x, player.pos.z);
        let invalidEnergy = 0;
        for (const entry of botany.serializeEcology().plants) {
          if (!Number.isFinite(entry[4]) || entry[4] < 0 || entry[4] > 100) invalidEnergy++;
        }
        return { tracked: stats.tracked, avgEnergy: stats.avgEnergy, invalidEnergy };
      })(),
      save: { dirty: dirtySave, lastOkAt: lastSaveOkAt },
    };
  };
  const diagnostics = new DiagnosticsRunner(collectDiagnostics);
  const diagnosticsApi: {
    run(): DiagnosticReport;
    last(): DiagnosticReport | null;
  } = {
    run: () => diagnostics.run(),
    last: () => diagnostics.last,
  };

  // ---- 服务装配：横切逻辑下沉，boot() 不再持有事件接线 ----
  const builtinDeps: BuiltinDeps = {
    hud, sound, player, survival, registry, hotbar,
    buzz,
    parseKey,
    syncUseMode,
    markDirty,
    saveNow,
    onDeath: () => {
      // 状态机属于组装根，UI / 音效 / 触感由插件负责
      mode = 'dead';
      input.enabled = false;
      input.reset();
      input.exitLock();
      touch?.setVisible(false);
      saveNow();
    },
  };
  container.provide(TOKENS.BuiltinDeps, builtinDeps);

  const api = createCraftAPI({
    engine, events, plugins, registry, atlas, world, player, entities, sky, chunks, sound, survival, botany,
    wasm, extensions,
    getSaveProvider: () => provider,
    setSaveProvider: (p) => { provider = p; },
    input: {
      getBinding: (a) => input.getBinding(a as Parameters<typeof input.getBinding>[0]),
      setBinding: (a, code) => input.setBinding(a as Parameters<typeof input.setBinding>[0], code),
      resetBindings: () => input.resetBindings(),
      get gamepadConnected() { return input.gamepadConnected; },
    },
    collectSave,
    applySave: applySaveData,
    igniteTnt: (x, y, z) => igniteTnt(x, y, z, true),
    onBlockRegistered: () => {
      hud.rebuildPalette();
      // 新方块/新纹理会改变网格化的元数据，必须让 Worker 重新加载 config
      chunks.invalidateConfig();
    },
    setRenderDistance: (v) => { settings.renderDistance = clamp(v, 2, 8); chunks.setRenderDistance(settings.renderDistance); },
    setSensitivity: (v) => { settings.sensitivity = clamp(v, 0.4, 2); input.sensitivity = settings.sensitivity; },
    setFov: (v) => { settings.fov = clamp(v, 60, 95); engine.camera.fov = settings.fov; engine.camera.updateProjectionMatrix(); },
    setSound: (v) => { settings.sound = v; sound.setEnabled(v); hud.setSound(v); persistOptions(settings); },
    setVolume: (v) => { settings.volume = clamp(v, 0, 100); sound.setVolume(settings.volume); persistOptions(settings); },
    setInvertY: (v) => { settings.invertY = v; input.invertY = v; persistOptions(settings); },
    setQuality: (v) => { settings.quality = v; applyQuality(v); persistOptions(settings); },
    setParticles: (v) => { settings.particles = v; particles.enabled = v; persistOptions(settings); },
    setViewBob: (v) => { settings.viewBob = v; player.viewBob = v; persistOptions(settings); },
    setAutoJump: (v) => { settings.autoJump = v; player.autoJump = v; persistOptions(settings); },
    setTouchSensitivity: (v) => {
      settings.touchSensitivity = clamp(v, 0.5, 2);
      if (touch) touch.lookScale = settings.touchSensitivity;
      persistOptions(settings);
    },
    setDebugOverlay: (v) => {
      settings.debugOverlay = v;
      debugOn = v;
      if (!v) hud.setDebug(null);
      persistOptions(settings);
    },
    setGreedy: (v) => { settings.greedy = v; chunks.greedy = v; persistOptions(settings); },
    setMesherThreads: (v) => { settings.mesherThreads = v; applyMesherThreads(v); persistOptions(settings); },
    setAutosaveInterval: (v) => { settings.autosaveInterval = clamp(v, 0, 120); persistOptions(settings); },
    exportOptions: () => JSON.stringify(settings, null, 2),
    importOptions: (json) => importOptions(json),
    setMode: (m) => applyMode(m),
    respawn,
    parseStack: parseKey,
    diagnostics: diagnosticsApi,
  });
  container.provide(TOKENS.CraftAPI, api);
  (window as unknown as Record<string, unknown>).CraftAPI = api;
  events.emit('service:ready', { services: container.keys() });

  for (const def of builtinPlugins) plugins.register(def);
  await Promise.all(builtinPlugins.map((p) => plugins.enable(p.manifest.id)));

  // ---- 输入边缘事件 ----
  function processEdges() {
    const edges = input.consumeEdges();
    // Esc 与 pointerlockchange 可能同帧产生两个 pause 边沿，去重避免菜单闪开又自动关闭
    let pauseHandled = false;
    for (const e of edges) {
      if (e.type === 'pause') {
        if (pauseHandled) continue;
        pauseHandled = true;
      }
      switch (e.type) {
        case 'pause':
          // 导入/导出面板与关于页盖在最上层，Esc 先关它们，再轮到设置页
          if (hud.aboutOpen) {
            hud.showAbout(false);
          } else if (hud.optionsIOOpen) {
            hud.showOptionsIO(false);
          } else if (hud.optionsOpen) {
            // 设置页盖在最上层，Esc 先关它（标题屏打开时也适用）
            closeOptions();
          } else if (mode === 'playing') openMenu();
          else if (mode === 'paused') {
            if (hud.keybindOpen) hud.showKeybinds(false);
            else if (hud.helpOpen) hud.showHelp(false);
            else if (hud.craftingOpen) closeCrafting();
            else if (hud.paletteOpen) closePalette();
            else if (hud.menuOpen) resumeGame();
          }
          break;
        case 'palette':
          if (mode === 'playing') openPalette('game');
          else if (mode === 'paused' && hud.paletteOpen) closePalette();
          break;
        case 'slot':
          if (mode === 'playing') selectSlot(e.absolute ? (e.value ?? 0) : hotbar.index + (e.value ?? 0));
          break;
        case 'camera':
          if (mode === 'playing') cycleCamera();
          break;
        case 'fly':
          if (mode === 'playing') {
            if (!player.toggleFly()) {
              hud.toast('生存模式不能飞行');
            } else {
              hud.setFlyActive(player.fly);
              hud.toast(player.fly ? '飞行模式：空格上升 / Shift下降' : '行走模式');
            }
          }
          break;
        case 'pick':
          if (mode === 'playing') player.pickBlock();
          break;
        case 'debug':
          debugOn = !debugOn;
          if (!debugOn) hud.setDebug(null);
          break;
        case 'hud':
          if (mode === 'playing') hud.toggleHudHidden();
          break;
        case 'tapBreak':
          if (mode === 'playing') player.tapBreak();
          break;
      }
    }
  }

  // ---- 标题电影镜头 ----
  function cinematic(t: number) {
    const c = player.pos;
    const a = t * 0.05;
    engine.camera.position.set(c.x + Math.cos(a) * 17, c.y + 9 + Math.sin(t * 0.021) * 2.5, c.z + Math.sin(a) * 17);
    engine.camera.lookAt(c.x, c.y + 2.5, c.z);
  }

  // ---- 调试面板 ----
  function debugText(): string {
    const p = player.pos;
    const info = engine.renderer.info.render;
    const yawDeg = ((player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const facing = ['北 (-Z)', '西 (-X)', '南 (+Z)', '东 (+X)'][Math.round(yawDeg / 90) % 4];
    const t = player.target;
    const targetStr = t ? `${registry.get(t.block).label} (${t.x}, ${t.y}, ${t.z})` : '无';
    const diag = diagnostics.run();
    const diagStr = diag.ok
      ? `正常（${diag.checked} 项）`
      : `${diag.errors} error / ${diag.warnings} warn${diag.issues[0] ? ` · ${diag.issues[0].id}` : ''}`;
    const plants = botany.stats(p.x, p.z);
    return [
      `Minecraft TS ${RELEASE} (${VERSION}) · three.js r170`,
      `FPS: ${engine.fps}  DrawCalls: ${info.calls}  三角形: ${(info.triangles / 1000).toFixed(1)}k  分辨率: ${Math.round(engine.qualityScale * 100)}%`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `区块: ${Math.floor(p.x / 16)}, ${Math.floor(p.z / 16)}  朝向: ${facing}`,
      `准星: ${targetStr}`,
      `已网格化区块: ${chunks.meshCount}  实体: ${entities.entities.length}`,
      `植物能量: ${plants.tracked} 株 / 开花 ${plants.charged} / 均值 ${plants.avgEnergy} / 土壤 ${plants.soilAvg}`,
      `季节: ${seasonAt(sky.dayCount)} / 天气: ${weatherAt(seed, sky.dayCount)} / 第 ${sky.dayCount} 天`,
      `运行时诊断: ${diagStr}`,
      `时间: ${sky.timeString()}  种子: ${seed}`,
      survival.isSurvival
        ? `模式: 生存  生命 ${Math.ceil(survival.health)}/${MAX_HEALTH}  饥饿 ${Math.ceil(survival.hunger)}/${MAX_HUNGER}  背包 ${survival.inventory.size} 种`
        : `模式: 创造${player.fly ? '（飞行）' : ''}`,
      `渲染距离: ${chunks.renderDistance}${isMobile ? '（移动端）' : ''}`,
      `脱困次数: ${player.unstuckCount}  透明排序条目: ${chunks.transparentOrder.length}`,
    ].join('\n');
  }

  // ---- 系统注册 ----
  engine.addSystem({ name: 'edges', update: () => processEdges() });
  engine.addSystem({
    name: 'sky',
    update: (dt, t) => {
      // 暂停 / 死亡 / 加载时不推进昼夜，避免回到游戏后时间跳变
      if (mode === 'playing' || mode === 'title') sky.update(dt, t);
    },
  });
  engine.addSystem({
    name: 'chunks',
    update: (dt) => {
      chunks.setCenter(player.pos.x, player.pos.z);
      chunks.update(dt);
    },
  });
  engine.addSystem({
    name: 'gameplay',
    update: (dt, t) => {
      // 手柄每帧轮询：暂停时也要读 Start 键（processEdges 处理恢复）
      input.pollGamepad(dt);
      // 掉落物只在 playing 推进 age / 物理 / 拾取；暂停时调用会直接返回
      drops.update(dt, player.pos, mode === 'playing');
      if (mode === 'playing') {
        player.update(dt);
        entities.update(dt, {
          playerPos: player.pos,
          daylight: sky.daylight,
          playerDead: survival.dead,
          playing: mode === 'playing',
          hurtPlayer: (amount, cause) => survival.damage(amount, cause),
        });
        entities.maintainPopulation(dt, player.pos, { survival: survival.isSurvival, daylight: sky.daylight });
        for (const tnt of [...tntList]) {
          tnt.update(dt);
          if (tnt.done) tntList.splice(tntList.indexOf(tnt), 1);
        }
        falling.update(dt);
      } else if (mode === 'title') {
        cinematic(t);
        entities.update(dt, {
          playerPos: player.pos,
          daylight: sky.daylight,
          playerDead: true,
          playing: false,
          hurtPlayer: () => false,
        });
      }
    },
  });
  engine.addSystem({
    name: 'botany',
    update: (dt) => {
      // 暂停 / 死亡 / 加载时不推进生态，避免回到游戏时世界突然变化
      if (mode !== 'playing') return;
      player.daylight = sky.daylight;
      botany.update(dt, player.pos.x, player.pos.z, sky.daylight, {
        day: sky.dayCount,
        season: seasonAt(sky.dayCount),
        weather: weatherAt(seed, sky.dayCount),
      });
    },
  });
  engine.addSystem(particles);
  engine.addSystem({
    name: 'ui',
    update: (dt) => {
      // 昼夜强度写进区块 shader；手持物按眼睛所在格的光照变暗/变亮
      const daylight = 0.16 + 0.84 * sky.daylight;
      chunks.lightUniform.value = daylight;
      chunks.sunTint.value.copy(sky.sunTint);
      const eyeX = Math.floor(player.pos.x);
      const eyeY = Math.floor(player.pos.y + 1.62);
      const eyeZ = Math.floor(player.pos.z);
      const skyL = world.getSkyLight(eyeX, eyeY, eyeZ) / 15;
      const blockL = world.getBlockLight(eyeX, eyeY, eyeZ) / 15;
      player.heldMaterial.color
        .setScalar(0.12 + 0.88 * Math.max(skyL * daylight, blockL))
        .multiply(sky.sunTint);
      const hlTarget = mode === 'playing' && player.target &&
        registry.get(player.target.block).shape !== 'cross' ? player.target : null;
      highlight.set(hlTarget);
      const uw = mode === 'playing' && player.eyeInWater;
      if (uw && !wasUnderwater) sound.splash();
      wasUnderwater = uw;
      hud.setUnderwater(uw);
      // 天空的水下大气：暂停时保持入水状态（sky.update 暂停期间不推进），回档后不闪烁
      sky.setUnderwater(player.eyeInWater && (mode === 'playing' || mode === 'paused'));
      if (mode === 'playing' || mode === 'paused' || mode === 'dead') {
        hud.setSurvival(survival);
        hud.setMining(mode === 'playing' && player.miningProgress !== null && player.miningBlock
          ? { progress: player.miningProgress, block: player.miningBlock }
          : null);
      }
      if (mode === 'playing') {
        saveAcc += dt;
        // 自动保存间隔由设置页控制，0 = 关闭自动保存（手动存档仍可用）
        if (settings.autosaveInterval > 0 && saveAcc > settings.autosaveInterval && dirtySave) saveNow();
        debugAcc += dt;
        if (debugOn && debugAcc > 0.2) {
          debugAcc = 0;
          hud.setDebug(debugText());
        }
      }
    },
  });

  // ---- 相机远平面随渲染距离收敛，减少无效深度范围与 z-fighting ----
  engine.addSystem({
    name: 'farplane',
    update: () => {
      // 天穹半径 460 / 星空 430 / 日月 400 必须留在视锥内，下限不能小于 520
      const far = Math.max(520, chunks.renderDistance * 16 * 1.3);
      if (Math.abs(engine.camera.far - far) > 1) {
        engine.camera.far = far;
        engine.camera.updateProjectionMatrix();
      }
    },
  });

  // ---- 移动端动态分辨率：帧率不足则逐级降像素比，富余再抬回 ----
  let qualityAcc = 0;
  engine.addSystem({
    name: 'quality',
    update: (dt) => {
      if (!isMobile || mode !== 'playing') return;
      // 固定画质档位不做自适应（仅「自动」档逐帧调分辨率）
      if (settings.quality !== 'auto') return;
      qualityAcc += dt;
      if (qualityAcc < 1.2) return;
      qualityAcc = 0;
      const fps = engine.fps;
      if (fps < 40 && engine.qualityScale > 0.6) {
        engine.setQualityScale(engine.qualityScale - 0.1);
      } else if (fps > 58 && engine.qualityScale < 1) {
        engine.setQualityScale(engine.qualityScale + 0.05);
      }
    },
  });

  // ---- 启动：预载出生点 → 标题全景 ----
  hud.setLoading(0, '生成地形…');
  await chunks.initialLoad(0, 0, 3, (p) => hud.setLoading(p * 0.92));
  if (!saved) player.spawn();
  for (let i = 0; i < 5; i++) entities.trySpawnNear(player.pos);
  hud.setLoading(null);
  hud.showTitle(true);
  if (loadWarning) hud.toast(loadWarning);
  engine.start();
  // 运行时诊断组：每 10 秒采样一次，异常集合变化时才输出（避免刷屏）
  diagnostics.start();

  // H02：beforeunload 阶段浏览器不等待异步 IndexedDB 事务提交，大概率丢档。
  // 改为 pagehide（关页/刷新/杀进程都会触发）+ visibilitychange（切后台）双触发，
  // 并同步双写 localStorage 镜像兜底（下次启动取 savedAt 较新的一份）
  const unloadSave = () => {
    if (suppressUnloadSave || saveBlocked) return;
    if (mode !== 'playing' && mode !== 'paused') return;
    try {
      localStorage.setItem('minecraft-ts-save-v1-unload', JSON.stringify(collectSave()));
    } catch { /* 配额超限：IndexedDB 路径仍在尝试 */ }
    saveNow();
  };
  addEventListener('pagehide', unloadSave);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (mode === 'playing' || mode === 'paused') unloadSave();
    if (mode === 'playing') openMenu();
  });

  // ---- 内部调试钩子（自动化测试 / 控制台把玩用）----
  (window as unknown as Record<string, unknown>).__mc = {
    get mode() { return mode; },
    get gameMode() { return survival.mode; },
    engine, player, world, chunks, sky, input, hud, entities, atlas, registry, sound, particles, tntList, survival,
    botany, falling,
    services: container, events, plugins, api,
    diagnostics, diagnosticsReport: () => diagnostics.run(),
    startGame, newWorld, selectSlot, igniteTnt, explode, openMenu, resumeGame, respawn, toggleGameMode,
    openCrafting, closeCrafting,
  };
}

void boot();
