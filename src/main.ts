import './ui/styles.css';
import * as THREE from 'three';
import { Engine } from './core/engine';
import { VERSION } from './core/version';
import { clamp, type BlockId, type GameMode } from './core/types';
import { BlockRegistry, registerBuiltinBlocks, AIR } from './world/blocks';
import { TextureAtlas } from './gfx/atlas';
import { DefaultGenerator } from './world/generator';
import { World } from './world/world';
import { ChunkManager } from './world/chunkManager';
import { Sky } from './gfx/sky';
import { Particles } from './gfx/particles';
import { BlockHighlight } from './gfx/highlight';
import { Player, type HotbarState } from './player/player';
import { SurvivalState, ITEMS, MAX_HUNGER, MAX_HEALTH, parseKey, type Stack } from './player/survival';
import { Input } from './input/input';
import { TouchControls } from './input/touch';
import { EntityManager } from './entity/entity';
import { PrimedTnt } from './entity/tnt';
import { SoundEngine } from './audio/sound';
import { HUD } from './ui/hud';
import { LocalStorageProvider, validateSave, type ISaveProvider, type SaveData } from './save/save';
import { createCraftAPI } from './api';
import { createServices, TOKENS } from './services';
import type { BuiltinDeps } from './plugins/builtin/deps';
import { builtinPlugins } from './plugins/builtin';

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

  let engine: Engine;
  try {
    engine = new Engine(app);
  } catch {
    uiRoot.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e8e8e8;font-size:15px;background:#1a1a22;padding:24px;text-align:center">当前浏览器不支持 WebGL，无法运行本演示。请更换现代浏览器（Chrome / Edge / Safari / Firefox）。</div>';
    return;
  }

  const { container, events, plugins } = createServices();
  const registry = new BlockRegistry();
  registerBuiltinBlocks(registry);
  const atlas = new TextureAtlas();
  const sound = new SoundEngine();
  const isMobile = engine.isMobile;
  const particles = new Particles(engine.scene, isMobile ? 380 : 800);

  const settings = { sound: true, renderDistance: isMobile ? 3 : 5, sensitivity: 1, fov: 72 };
  const idOf = (n: string) => registry.byNameGet(n)!.id;
  const creativeSlots = ['grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log', 'oak_leaves', 'glass', 'bricks']
    .map((n) => ({ kind: 'block' as const, id: idOf(n) }));
  const hotbar: HotbarState = { slots: [...creativeSlots], index: 0 };

  // ---- 存档 ----
  let provider: ISaveProvider = new LocalStorageProvider();
  let saved = await provider.load();
  const pendingSeed = sessionStorage.getItem('mc-ts-new-seed');
  const pendingModeRaw = sessionStorage.getItem('mc-ts-new-mode');
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
    settings.sound = saved.settings?.sound ?? true;
    settings.renderDistance = clamp(saved.settings?.renderDistance ?? settings.renderDistance, 2, 8);
    settings.sensitivity = clamp(saved.settings?.sensitivity ?? 1, 0.4, 2);
    settings.fov = clamp(saved.settings?.fov ?? 72, 60, 95);
    if (Array.isArray(saved.hotbar) && saved.hotbar.length === 9) {
      hotbar.slots = saved.hotbar.map((s) => {
        if (!s || s.kind === undefined) return null;
        if (s.kind === 'block' && typeof s.id === 'number' && registry.get(s.id).id === s.id) {
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
  sound.setEnabled(settings.sound);

  // ---- 世界 ----
  const world = new World(registry, new DefaultGenerator(seed, registry), events);
  if (saved) world.loadEdits(saved.edits);
  // 调试/基准开关：?mesher=main 强制同步路径，?greedy=0 关闭合并，?workers=N 覆盖 Worker 池大小
  const qs = new URLSearchParams(location.search);
  const workersParam = qs.get('workers');
  const chunks = new ChunkManager(world, engine.scene, atlas, events, settings.renderDistance, {
    forceMainThread: qs.get('mesher') === 'main',
    greedy: qs.get('greedy') !== '0',
    workers: workersParam != null ? Number(workersParam) : undefined,
  });
  const sky = new Sky(engine.scene, engine.camera, chunks.materials, () => chunks.renderDistance, events, isMobile);
  if (saved) sky.dayTime = saved.dayTime ?? 0.32;
  const entities = new EntityManager(world, engine.scene, events);

  // ---- 生存状态 ----
  const survival = new SurvivalState(events, registry);
  survival.mode = gameMode;
  if (saved?.survival) survival.restore(saved.survival);
  if (!saved) {
    if (gameMode === 'survival') {
      // 新手补给：2 个苹果，先垫一下饥饿
      survival.addItem('apple', 2);
      hotbar.slots = [{ kind: 'item', id: 'apple' }, ...creativeSlots.slice(0, 8).map(() => null)];
      hotbar.index = 0;
    } else {
      hotbar.slots = [...creativeSlots];
      hotbar.index = 0;
    }
  }

  const input = new Input(engine.renderer.domElement, isMobile);
  const player = new Player(world, engine.camera, input, registry, atlas, events, sound, particles,
    survival, hotbar, entities, engine.scene, isMobile);
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
  engine.camera.fov = settings.fov;
  engine.camera.updateProjectionMatrix();
  input.sensitivity = settings.sensitivity;

  const tntList: PrimedTnt[] = [];
  const highlight = new BlockHighlight(engine.scene);
  let mode: Mode = 'title';
  let debugOn = false;
  let dirtySave = false;
  let saveAcc = 0;
  let debugAcc = 0;
  let wasUnderwater = false;
  let paletteReturn: 'game' | 'menu' = 'game';
  /** 新世界 / 导入存档触发 reload 时，禁止 beforeunload 用旧状态反写存档 */
  let suppressUnloadSave = false;

  const touch = isMobile ? new TouchControls(input, uiRoot, engine.renderer.domElement) : null;
  touch?.setVisible(false);
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
    savedAt: Date.now(),
  });
  const saveNow = () => {
    const data = collectSave();
    provider.save(data)
      .then((bytes) => {
        dirtySave = false;
        events.emit('save:done', { bytes: typeof bytes === 'number' ? bytes : JSON.stringify(data).length });
      })
      .catch((e) => {
        // 保存失败时保留 dirty 标记，8 秒后重试
        dirtySave = true;
        console.warn('存档失败', e);
      });
    saveAcc = 0;
  };

  // ---- TNT ----
  const igniteTnt = (x: number, y: number, z: number, playSound: boolean) => {
    const def = registry.get(world.getBlock(x, y, z));
    if (def.name !== 'tnt') return;
    world.setBlock(x, y, z, AIR);
    if (playSound) sound.fuse();
    events.emit('block:ignite', { x, y, z });
    dirtySave = true;
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
          if (id === AIR || def.liquid || !isFinite(def.hardness)) continue;
          destroyed.push([x, y, z, id]);
        }
      }
    }
    for (const [x, y, z, id] of destroyed) {
      world.setBlock(x, y, z, AIR);
      if (registry.get(id).name === 'tnt') {
        events.emit('block:ignite', { x, y, z });
      } else {
        events.emit('block:break', { x, y, z, block: id });
      }
    }
    particles.burst(cx, cy, cz, [1, 0.72, 0.3], isMobile ? 55 : 90, r * 0.45, 9);
    particles.burst(cx, cy, cz, [0.45, 0.42, 0.4], isMobile ? 40 : 60, r * 0.5, 7);
    sound.explosion();
    hud.flash();
    const blastCenter = new THREE.Vector3(cx, cy, cz);
    const dist = player.pos.distanceTo(blastCenter);
    player.shake(clamp(0.75 * (1 - dist / 12), 0, 0.75));
    if (survival.isSurvival && dist < r * 1.6) {
      survival.damage(Math.round(9 * (1 - dist / (r * 1.6))), '爆炸');
    }
    for (const e of entities.entities) {
      const d = e.pos.distanceTo(blastCenter);
      if (d < r * 2.5 && d > 0.01) {
        const k = 9 / Math.max(1, d);
        e.vel.x += (e.pos.x - cx) * k;
        e.vel.y += 4 * k;
        e.vel.z += (e.pos.z - cz) * k;
      }
    }
    events.emit('explosion', { center: { x: cx, y: cy, z: cz }, radius: r });
    dirtySave = true;
  }

  // ---- HUD ----
  const stackBlock = (s: Stack | null): BlockId => (s && s.kind === 'block' ? (s.id as BlockId) : AIR);
  const selectSlot = (i: number) => {
    hotbar.index = ((i % 9) + 9) % 9;
    events.emit('hotbar:select', { index: hotbar.index, block: stackBlock(hotbar.slots[hotbar.index]) });
    sound.click(700);
    dirtySave = true;
  };

  const hud = new HUD({
    uiRoot, atlas, registry, hotbar, isMobile,
    onStart: (cont, chosen) => {
      if (cont) { void startGame(true); return; } // 继续游戏保留存档模式
      // 标题页选的模式必须真正写回状态机，否则选「创造」仍会进入生存
      survival.mode = chosen;
      gameMode = chosen;
      if (chosen === 'survival') {
        // boot 已发过补给，避免重复进入标题再开局时叠加成 4 个苹果
        if (survival.countKey('i:apple') === 0) survival.addItem('apple', 2);
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
      dirtySave = true;
    },
    onSoundToggle: () => {
      settings.sound = !settings.sound;
      sound.setEnabled(settings.sound);
      hud.setSound(settings.sound);
      if (settings.sound) sound.click(880);
      dirtySave = true;
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
    onRenderDistance: (v) => { settings.renderDistance = v; chunks.setRenderDistance(v); dirtySave = true; },
    onSensitivity: (v) => { settings.sensitivity = v; input.sensitivity = v; dirtySave = true; },
    onFov: (v) => { settings.fov = v; engine.camera.fov = v; engine.camera.updateProjectionMatrix(); dirtySave = true; },
    onPaletteClose: () => closePalette(),
    onRespawn: () => respawn(),
    onModeToggle: () => toggleGameMode(),
    isSurvival: () => survival.isSurvival,
    getCount: (s) => survival.countStack(s),
  });
  hud.setSound(settings.sound);
  hud.refreshTitleButtons(!!saved, saved?.mode);
  hud.setFlyActive(player.fly);

  const cycleCamera = () => {
    player.cycleCamera();
    hud.toast(['第一人称视角', '第三人称（背面）', '第三人称（正面）'][player.cameraMode]);
  };

  /** 生物掉落统一进背包 */
  entities.onDrop = (name, count) => {
    survival.addDrop(name, count);
  };

  // ---- 状态机 ----
  async function startGame(cont: boolean) {
    if (mode !== 'title') return;
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
      sky.dayTime = saved.dayTime;
    } else {
      player.spawn();
      survival.spawn = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    }
    await chunks.initialLoad(player.pos.x, player.pos.z, Math.min(settings.renderDistance, 3),
      (p) => hud.setLoading(p));
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
    }
    hud.setLoading(null);
    hud.setPlaying(true);
    touch?.setVisible(true);
    mode = 'playing';
    input.enabled = true;
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
    dirtySave = true;
  }

  async function newWorld(s?: number, m?: GameMode) {
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
    input.exitLock();
    hud.syncSettings(settings.renderDistance, settings.sensitivity, settings.fov);
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

  function quitToTitle() {
    saveNow();
    saved = collectSave();
    mode = 'title';
    input.enabled = false;
    input.exitLock();
    hud.setPlaying(false);
    hud.hideDeath();
    touch?.setVisible(false);
    hud.showMenu(false);
    hud.showPalette(false);
    hud.showHelp(false);
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
    dirtySave = true;
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
    dirtySave = true;
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

  // ---- 服务装配：横切逻辑下沉，boot() 不再持有事件接线 ----
  const builtinDeps: BuiltinDeps = {
    hud, sound, player, survival, registry, hotbar,
    buzz,
    parseKey,
    syncUseMode,
    markDirty: () => { dirtySave = true; },
    saveNow,
    onDeath: () => {
      // 状态机属于组装根，UI / 音效 / 触感由插件负责
      mode = 'dead';
      input.enabled = false;
      input.exitLock();
      touch?.setVisible(false);
      saveNow();
    },
  };
  container.provide(TOKENS.BuiltinDeps, builtinDeps);

  const api = createCraftAPI({
    engine, events, plugins, registry, atlas, world, player, entities, sky, chunks, sound, survival,
    getSaveProvider: () => provider,
    setSaveProvider: (p) => { provider = p; },
    collectSave,
    applySave: async (data) => {
      if (!validateSave(data)) throw new Error('存档格式校验失败：缺少必要字段或字段类型错误');
      await provider.save(data);
      // 导入成功后禁止卸载保存，否则 reload 会把当前状态覆盖到刚导入的存档上
      suppressUnloadSave = true;
      location.reload();
    },
    igniteTnt: (x, y, z) => igniteTnt(x, y, z, true),
    onBlockRegistered: () => {
      hud.rebuildPalette();
      // 新方块/新纹理会改变网格化的元数据，必须让 Worker 重新加载 config
      chunks.invalidateConfig();
    },
    setRenderDistance: (v) => { settings.renderDistance = clamp(v, 2, 8); chunks.setRenderDistance(settings.renderDistance); },
    setSensitivity: (v) => { settings.sensitivity = clamp(v, 0.4, 2); input.sensitivity = settings.sensitivity; },
    setFov: (v) => { settings.fov = clamp(v, 60, 95); engine.camera.fov = settings.fov; engine.camera.updateProjectionMatrix(); },
    setSound: (v) => { settings.sound = v; sound.setEnabled(v); hud.setSound(v); },
    setMode: (m) => applyMode(m),
    respawn,
    parseStack: parseKey,
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
          if (mode === 'playing') openMenu();
          else if (mode === 'paused') {
            if (hud.helpOpen) hud.showHelp(false);
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
    return [
      `Minecraft TS ${VERSION} · three.js r170`,
      `FPS: ${engine.fps}  DrawCalls: ${info.calls}  三角形: ${(info.triangles / 1000).toFixed(1)}k  分辨率: ${Math.round(engine.qualityScale * 100)}%`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `区块: ${Math.floor(p.x / 16)}, ${Math.floor(p.z / 16)}  朝向: ${facing}`,
      `准星: ${targetStr}`,
      `已网格化区块: ${chunks.meshCount}  实体: ${entities.entities.length}`,
      `时间: ${sky.timeString}  种子: ${seed}`,
      survival.isSurvival
        ? `模式: 生存  生命 ${Math.ceil(survival.health)}/${MAX_HEALTH}  饥饿 ${Math.ceil(survival.hunger)}/${MAX_HUNGER}  背包 ${survival.inventory.size} 种`
        : `模式: 创造${player.fly ? '（飞行）' : ''}`,
      `渲染距离: ${chunks.renderDistance}${isMobile ? '（移动端）' : ''}`,
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
      if (mode === 'playing') {
        player.update(dt);
        entities.update(dt, {
          playerPos: player.pos,
          daylight: sky.daylight,
          playerDead: survival.dead,
          hurtPlayer: (amount, cause) => survival.damage(amount, cause),
        });
        entities.maintainPopulation(dt, player.pos, { survival: survival.isSurvival, daylight: sky.daylight });
        for (const tnt of [...tntList]) {
          tnt.update(dt);
          if (tnt.done) tntList.splice(tntList.indexOf(tnt), 1);
        }
      } else if (mode === 'title') {
        cinematic(t);
        entities.update(dt, {
          playerPos: player.pos,
          daylight: sky.daylight,
          playerDead: true,
          hurtPlayer: () => false,
        });
      }
    },
  });
  engine.addSystem(particles);
  engine.addSystem({
    name: 'ui',
    update: (dt) => {
      player.heldMaterial.color.copy(chunks.materials.opaque.color);
      chunks.materials.water.color.copy(chunks.materials.opaque.color);
      const hlTarget = mode === 'playing' && player.target &&
        registry.get(player.target.block).shape !== 'cross' ? player.target : null;
      highlight.set(hlTarget);
      const uw = mode === 'playing' && player.eyeInWater;
      if (uw && !wasUnderwater) sound.splash();
      wasUnderwater = uw;
      hud.setUnderwater(uw);
      if (mode === 'playing' || mode === 'paused' || mode === 'dead') {
        hud.setSurvival(survival);
        hud.setMining(mode === 'playing' && player.miningProgress !== null && player.miningBlock
          ? { progress: player.miningProgress, block: player.miningBlock }
          : null);
      }
      if (mode === 'playing') {
        saveAcc += dt;
        if (saveAcc > 8 && dirtySave) saveNow();
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
  engine.start();

  addEventListener('beforeunload', () => {
    if (!suppressUnloadSave && (mode === 'playing' || mode === 'paused')) saveNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'playing') openMenu();
  });

  // ---- 内部调试钩子（自动化测试 / 控制台把玩用）----
  (window as unknown as Record<string, unknown>).__mc = {
    get mode() { return mode; },
    get gameMode() { return survival.mode; },
    engine, player, world, chunks, sky, input, hud, entities, atlas, registry, sound, tntList, survival,
    services: container, events, plugins, api,
    startGame, newWorld, selectSlot, igniteTnt, explode, openMenu, resumeGame, respawn, toggleGameMode,
  };
}

void boot();
