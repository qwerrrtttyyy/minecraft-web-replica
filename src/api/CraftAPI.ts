import * as THREE from 'three';
import type { SoundEngine } from '../audio/sound';
import type { Engine } from '../core/engine';
import type { MesherThreads, QualityMode } from '../core/options';
import type { GameMode } from '../core/types';
import { RELEASE, VERSION } from '../core/version';
import type { DiagnosticReport } from '../diagnostics/RuntimeDiagnostics';
import type { EntityManager, EntityType } from '../entity/entity';
import type { TextureAtlas } from '../gfx/atlas';
import type { Sky } from '../gfx/sky';
import type { Player } from '../player/player';
import type { SurvivalState } from '../player/survival';
import { downloadSave, type ISaveProvider, parseSaveFile, type SaveData } from '../save/save';
import type {
  AnyEventHandler,
  EventChannel,
  EventChannelOptions,
  EventService,
  EventStats,
  GameEvents,
} from '../services/events';
import type {
  ExtensionInfo,
  ExtensionRegistry,
  ExtensionStats,
  PluginDefinition,
  PluginRecord,
  PluginService,
  PluginStats,
} from '../services/plugins';
import type { WasmBenchmark, WasmModuleInfo, WasmRuntime, WasmStats, WasmStatus } from '../wasm/runtime';
import type { BlockDefinition, BlockInput, BlockRegistry } from '../world/blocks';
import type { Botany, BotanyStats } from '../world/botany';
import type { ChunkManager } from '../world/chunkManager';
import type { BiomeId, ColumnInfo, IWorldGenerator } from '../world/generator';
import type { PlantRule, PlantRuleInfo } from '../world/plantRules';
import type { PlantTrait } from '../world/plantTraits';
import type { World } from '../world/world';

/**
 * 公开扩展门面（挂载到 window.CraftAPI）。
 *
 * v1.2.0 起它不再自己实现扩展机制，而只是「服务层」的薄适配：
 * 事件能力来自 EventService，插件能力来自 PluginService，业务能力来自组装根注入的依赖。
 * 旧版 22 项能力（on/off/emit/registerBlock/... /engine/blocks）签名完全保留。
 */
export interface CraftAPI {
  version: string;
  /** 正式里程碑版本（vN），与迭代版本 version 相互独立 */
  release: string;
  /** 注册新方块（tiles 必须是已注册纹理名） */
  registerBlock(input: BlockInput): BlockDefinition;
  /** 注册自定义 16×16 像素纹理 */
  registerTile(
    name: string,
    painter: (setPixel: (x: number, y: number, hex: number, alpha?: number) => void, rng: () => number) => void,
  ): void;
  /** 注册新实体类型 */
  registerEntity(type: EntityType): void;
  /** 替换世界生成器（只影响未生成的区块） */
  setGenerator(gen: IWorldGenerator): void;
  /** 事件订阅，返回取消函数 */
  on<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void): () => void;
  off<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void): void;
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void;

  /** v1.2.0：事件服务视图（作用域订阅、异步等待、派发统计、全局观测） */
  events: {
    /** options.canEmit 用于创建受权限约束的插件通道（默认放行） */
    scope(ns: string, options?: EventChannelOptions): EventChannel;
    stats(): EventStats;
    onAny(fn: AnyEventHandler): () => void;
    waitFor<K extends keyof GameEvents>(type: K, timeoutMs?: number): Promise<GameEvents[K]>;
  };

  /** v1.2.0：插件服务（注册 / 启用 / 停用 / 卸载 / 列表） */
  plugins: {
    register(def: PluginDefinition): PluginRecord;
    enable(id: string): Promise<void>;
    disable(id: string): void;
    unload(id: string): void;
    list(): PluginRecord[];
    get(id: string): PluginRecord | undefined;
    reload(id: string): Promise<void>;
    enableAll(): Promise<void>;
    stats(): PluginStats;
    install(source: string): PluginRecord;
    findByCapability(capability: string): string[];
  };

  /** 实验性功能：WebAssembly 运行时视图（开关由设置页「实验性内容」控制） */
  wasm: {
    status(): WasmStatus;
    stats(): WasmStats;
    benchmark(iterations?: number): WasmBenchmark | null;
    setEnabled(v: boolean): WasmStatus;
    listModules(): WasmModuleInfo[];
    call(name: string, ...args: number[]): number;
    callModule(id: string, fn: string, ...args: number[]): number;
    registerModule(id: string, data: Uint8Array | ArrayBuffer | string): WasmModuleInfo;
    unregisterModule(id: string): boolean;
  };

  /** 实验性功能：扩展点注册表视图（只读查询，注册请通过 ctx.extensions） */
  extensions: {
    points(): ExtensionInfo[];
    stats(): ExtensionStats;
    has(point: string): boolean;
    list(point?: string): ExtensionInfo[];
  };

  /** v1.4.3：生态扩展点。插件注册植物特性与生态规则（需 botany:register 权限） */
  botany: {
    registerPlant(name: string, trait: PlantTrait): void;
    unregisterPlant(name: string): void;
    registerRule(rule: PlantRule): void;
    unregisterRules(owner: string): number;
    listRules(): PlantRuleInfo[];
    stats(): BotanyStats;
  };

  /** v1.3.2：运行时诊断组（Worker 配置 / 区块收敛 / 输入 / 插件 / 存档） */
  diagnostics: {
    run(): DiagnosticReport;
    last(): DiagnosticReport | null;
  };

  world: {
    seed(): number;
    getBlock(x: number, y: number, z: number): number;
    setBlock(x: number, y: number, z: number, id: number): boolean;
    /** 生成期装饰写入：不记录存档差分、不标脏（需 world:write 权限） */
    decorate(x: number, y: number, z: number, id: number): boolean;
    surfaceHeight(x: number, z: number): number;
    /** 该坐标的群系；自定义生成器未实现时返回 'unknown' */
    biomeAt(x: number, z: number): BiomeId | 'unknown';
    /** 完整列信息（高度/群系/温湿度/坡度）；自定义生成器未实现时返回 null */
    terrain(x: number, z: number): ColumnInfo | null;
    raycast(
      origin: { x: number; y: number; z: number },
      dir: { x: number; y: number; z: number },
      maxDist: number,
    ): unknown;
  };
  player: {
    position(): { x: number; y: number; z: number };
    teleport(x: number, y: number, z: number): void;
    setFly(v: boolean): void;
    setCamera(mode: 0 | 1 | 2): void;
    break(): void;
    place(): void;
    selectedBlock(): BlockDefinition;
  };
  time: {
    get(): number;
    set(v: number): void;
    setDayLength(seconds: number): void;
    text(): string;
  };
  entities: {
    spawn(type: string, x: number, y: number, z: number): unknown;
    list(): { id: number; type: string; x: number; y: number; z: number }[];
  };
  tnt: { ignite(x: number, y: number, z: number): void };
  save: {
    export(): SaveData;
    import(data: SaveData): Promise<void>;
    setProvider(p: ISaveProvider): void;
    /** v1.5.0：导出为 .json 文件下载（备份 / 跨浏览器迁移） */
    exportFile(): void;
    /** v1.5.0：从 .json 文件导入（校验失败抛错），成功后重载世界 */
    importFile(file: File): Promise<void>;
  };
  settings: {
    renderDistance(v: number): void;
    sensitivity(v: number): void;
    fov(v: number): void;
    sound(v: boolean): void;
    /** 音量 0~100 */
    volume(v: number): void;
    /** 反转 Y 轴 */
    invertY(v: boolean): void;
    /** 画质档位（自动 / 高 / 均衡 / 省电） */
    quality(v: QualityMode): void;
    particles(v: boolean): void;
    viewBob(v: boolean): void;
    autoJump(v: boolean): void;
    /** 触控灵敏度 0.5~2（仅移动端生效） */
    touchSensitivity(v: number): void;
    /** 开发者：常显调试信息 */
    debugOverlay(v: boolean): void;
    greedy(v: boolean): void;
    mesherThreads(v: MesherThreads): void;
    /** 自动保存间隔（秒），0 = 关闭 */
    autosaveInterval(v: number): void;
    /** 导出当前设置为 JSON 文本 */
    exportOptions(): string;
    /** 导入设置 JSON（未知键忽略、越界值钳制），返回生效字段数 */
    importOptions(json: string): number;
  };
  /** 输入：可重绑定按键 + 手柄状态（v1.5.0） */
  input: {
    getBinding(action: string): string;
    setBinding(action: string, code: string): void;
    resetBindings(): void;
    gamepadConnected: boolean;
  };
  /** 生存模式：生命 / 饥饿 / 背包（创造模式下多数接口为 no-op） */
  survival: {
    mode(): GameMode;
    setMode(m: GameMode): void;
    health(): number;
    hunger(): number;
    /** 饱和度（0~20），进食缓冲，先于 hunger 被消耗 */
    saturation(): number;
    /** 温暖值（0~100），由 WarmthSystem 驱动 */
    warmth(): number;
    breath(): number;
    damage(amount: number, cause?: string): boolean;
    heal(amount: number): void;
    /** name 支持方块名（'stone'）或物品名（'item:apple'） */
    give(name: string, count?: number): void;
    count(name: string): number;
    inventory(): { key: string; count: number }[];
    respawn(): void;
  };
  engine: Engine;
  blocks: BlockRegistry;
}

export interface APIDeps {
  engine: Engine;
  events: EventService;
  plugins: PluginService;
  registry: BlockRegistry;
  atlas: TextureAtlas;
  world: World;
  player: Player;
  entities: EntityManager;
  sky: Sky;
  chunks: ChunkManager;
  sound: SoundEngine;
  survival: SurvivalState;
  respawn(): void;
  setMode(m: GameMode): void;
  parseStack(key: string): { kind: 'block' | 'item'; id: number | string };
  getSaveProvider(): ISaveProvider;
  setSaveProvider(p: ISaveProvider): void;
  collectSave(): SaveData;
  applySave(data: SaveData): Promise<void>;
  igniteTnt(x: number, y: number, z: number): void;
  onBlockRegistered(): void;
  setRenderDistance(v: number): void;
  input: {
    getBinding(action: string): string;
    setBinding(action: string, code: string): void;
    resetBindings(): void;
    gamepadConnected: boolean;
  };
  setSensitivity(v: number): void;
  setFov(v: number): void;
  setSound(v: boolean): void;
  setVolume(v: number): void;
  setInvertY(v: boolean): void;
  setQuality(v: QualityMode): void;
  setParticles(v: boolean): void;
  setViewBob(v: boolean): void;
  setAutoJump(v: boolean): void;
  setTouchSensitivity(v: number): void;
  setDebugOverlay(v: boolean): void;
  setGreedy(v: boolean): void;
  setMesherThreads(v: MesherThreads): void;
  setAutosaveInterval(v: number): void;
  exportOptions(): string;
  importOptions(json: string): number;
  botany: Botany;
  wasm: WasmRuntime;
  extensions: ExtensionRegistry;
  diagnostics: {
    run(): DiagnosticReport;
    last(): DiagnosticReport | null;
  };
}

export function createCraftAPI(d: APIDeps): CraftAPI {
  return {
    version: VERSION,
    release: RELEASE,
    registerBlock(input) {
      for (const t of [input.tiles.top, input.tiles.bottom, input.tiles.side]) {
        if (!d.atlas.hasTile(t)) throw new Error(`纹理未注册: ${t}（先用 registerTile 注册）`);
      }
      const def = d.registry.register(input);
      d.onBlockRegistered();
      return def;
    },
    registerTile(name, painter) {
      d.atlas.registerTile(name, painter);
      d.onBlockRegistered();
    },
    registerEntity(type) {
      d.entities.registerType(type);
    },
    setGenerator(gen) {
      d.world.generator = gen;
    },
    on: (t, fn) => d.events.on(t, fn),
    off: (t, fn) => d.events.off(t, fn),
    emit: (t, p) => d.events.emit(t, p),
    events: {
      scope: (ns) => d.events.scope(ns),
      stats: () => d.events.stats(),
      onAny: (fn) => d.events.onAny(fn),
      waitFor: (t, ms) => d.events.waitFor(t, ms),
    },
    plugins: {
      register: (def) => d.plugins.register(def),
      enable: (id) => d.plugins.enable(id),
      disable: (id) => d.plugins.disable(id),
      unload: (id) => d.plugins.unload(id),
      list: () => d.plugins.list(),
      get: (id) => d.plugins.get(id),
      reload: (id) => d.plugins.reload(id),
      enableAll: () => d.plugins.enableAll(),
      stats: () => d.plugins.stats(),
      install: (source) => d.plugins.install(source),
      findByCapability: (c) => d.plugins.findByCapability(c),
    },
    wasm: {
      status: () => d.wasm.getState(),
      stats: () => d.wasm.stats(),
      benchmark: (n) => d.wasm.benchmark(n),
      setEnabled: (v) => d.wasm.setEnabled(v),
      listModules: () => d.wasm.listModules(),
      call: (name, ...args) => d.wasm.callKernel(name, args),
      callModule: (id, fn, ...args) => d.wasm.callModule(id, fn, args),
      registerModule: (id, data) => d.wasm.registerModule(id, data),
      unregisterModule: (id) => d.wasm.unregisterModule(id),
    },
    extensions: {
      points: () => d.extensions.list(),
      stats: () => d.extensions.stats(),
      has: (point) => d.extensions.has(point),
      list: (point) => d.extensions.list(point),
    },
    botany: {
      registerPlant: (name, trait) => d.botany.registerTrait(name, trait),
      unregisterPlant: (name) => d.botany.unregisterTrait(name),
      registerRule: (rule) => d.botany.registerRule(rule),
      unregisterRules: (owner) => d.botany.unregisterRules(owner),
      listRules: () => d.botany.listRules(),
      stats: () => d.botany.stats(),
    },
    diagnostics: {
      run: () => d.diagnostics.run(),
      last: () => d.diagnostics.last(),
    },
    world: {
      seed: () => d.world.generator.seed,
      getBlock: (x, y, z) => d.world.getBlock(x, y, z),
      setBlock: (x, y, z, id) => d.world.setBlock(x, y, z, id),
      decorate: (x, y, z, id) => d.world.setBlockGeneratedWithLight(x, y, z, id),
      surfaceHeight: (x, z) => d.world.surfaceHeight(x, z),
      biomeAt: (x, z) => d.world.generator.biomeAt?.(x, z) ?? 'unknown',
      terrain: (x, z) => d.world.generator.columnInfo?.(x, z) ?? null,
      raycast: (o, dir, max) =>
        d.world.raycast(new THREE.Vector3(o.x, o.y, o.z), new THREE.Vector3(dir.x, dir.y, dir.z), max),
    },
    player: {
      position: () => ({ x: d.player.pos.x, y: d.player.pos.y, z: d.player.pos.z }),
      teleport: (x, y, z) => d.player.teleport(x, y, z),
      setFly: (v) => {
        if (v && d.survival.isSurvival) return;
        d.player.fly = v;
      },
      setCamera: (m) => {
        d.player.cameraMode = m;
      },
      break: () => d.player.breakBlock(),
      place: () => d.player.doPlace(),
      selectedBlock: () => d.player.selectedBlock(),
    },
    time: {
      get: () => d.sky.dayTime,
      set: (v) => {
        d.sky.dayTime = ((v % 1) + 1) % 1;
      },
      setDayLength: (s) => {
        d.sky.dayLength = Math.max(10, s);
      },
      text: () => d.sky.timeString(),
    },
    entities: {
      spawn: (type, x, y, z) => d.entities.spawn(type, x, y, z),
      list: () => d.entities.entities.map((e) => ({ id: e.id, type: e.type.id, x: e.pos.x, y: e.pos.y, z: e.pos.z })),
    },
    tnt: { ignite: (x, y, z) => d.igniteTnt(x, y, z) },
    save: {
      export: () => d.collectSave(),
      import: (data) => d.applySave(data),
      setProvider: (p) => d.setSaveProvider(p),
      exportFile: () => downloadSave(d.collectSave()),
      importFile: async (file) => {
        const data = parseSaveFile(await file.text());
        if (!data) throw new Error('存档文件格式校验失败');
        await d.applySave(data);
      },
    },
    settings: {
      renderDistance: (v) => d.setRenderDistance(v),
      sensitivity: (v) => d.setSensitivity(v),
      fov: (v) => d.setFov(v),
      sound: (v) => d.setSound(v),
      volume: (v) => d.setVolume(v),
      invertY: (v) => d.setInvertY(v),
      quality: (v) => d.setQuality(v),
      particles: (v) => d.setParticles(v),
      viewBob: (v) => d.setViewBob(v),
      autoJump: (v) => d.setAutoJump(v),
      touchSensitivity: (v) => d.setTouchSensitivity(v),
      debugOverlay: (v) => d.setDebugOverlay(v),
      greedy: (v) => d.setGreedy(v),
      mesherThreads: (v) => d.setMesherThreads(v),
      autosaveInterval: (v) => d.setAutosaveInterval(v),
      exportOptions: () => d.exportOptions(),
      importOptions: (json) => d.importOptions(json),
    },
    input: {
      getBinding: (a) => d.input.getBinding(a),
      setBinding: (a, code) => d.input.setBinding(a, code),
      resetBindings: () => d.input.resetBindings(),
      get gamepadConnected() {
        return d.input.gamepadConnected;
      },
    },
    survival: {
      mode: () => d.survival.mode,
      setMode: (m) => d.setMode(m),
      health: () => d.survival.health,
      hunger: () => d.survival.hunger,
      saturation: () => d.survival.saturation,
      warmth: () => d.survival.warmth,
      breath: () => d.survival.breath,
      damage: (n, cause) => d.survival.damage(n, cause ?? 'API'),
      heal: (n) => d.survival.heal(n),
      give: (name, count = 1) => d.survival.addDrop(name, count),
      count: (name) => {
        const itemName = name.startsWith('item:') ? name.slice(5) : name;
        const byItem = d.survival.countKey(`i:${itemName}`);
        if (byItem > 0) return byItem;
        const def = d.registry.byNameGet(itemName);
        return def ? d.survival.countKey(`b:${def.id}`) : 0;
      },
      inventory: () => [...d.survival.inventory.entries()].map(([key, count]) => ({ key, count })),
      respawn: () => d.respawn(),
    },
    engine: d.engine,
    blocks: d.registry,
  };
}
