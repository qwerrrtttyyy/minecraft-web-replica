import * as THREE from 'three';
import type { EventService, GameEvents, EventChannel, EventStats, AnyEventHandler } from '../services/events';
import type { PluginService, PluginDefinition, PluginRecord } from '../services/plugins';
import { VERSION } from '../core/version';
import type { Engine } from '../core/engine';
import type { BlockRegistry, BlockInput, BlockDefinition } from '../world/blocks';
import type { World } from '../world/world';
import type { IWorldGenerator, BiomeId, ColumnInfo } from '../world/generator';
import type { Player } from '../player/player';
import type { EntityManager, EntityType } from '../entity/entity';
import type { Sky } from '../gfx/sky';
import type { ChunkManager } from '../world/chunkManager';
import type { TextureAtlas } from '../gfx/atlas';
import type { ISaveProvider, SaveData } from '../save/save';
import type { SoundEngine } from '../audio/sound';
import type { SurvivalState } from '../player/survival';
import type { GameMode } from '../core/types';
import type { DiagnosticReport } from '../diagnostics/RuntimeDiagnostics';

/**
 * 公开扩展门面（挂载到 window.CraftAPI）。
 *
 * v1.2.0 起它不再自己实现扩展机制，而只是「服务层」的薄适配：
 * 事件能力来自 EventService，插件能力来自 PluginService，业务能力来自组装根注入的依赖。
 * 旧版 22 项能力（on/off/emit/registerBlock/... /engine/blocks）签名完全保留。
 */
export interface CraftAPI {
  version: string;
  /** 注册新方块（tiles 必须是已注册纹理名） */
  registerBlock(input: BlockInput): BlockDefinition;
  /** 注册自定义 16×16 像素纹理 */
  registerTile(name: string, painter: (setPixel: (x: number, y: number, hex: number, alpha?: number) => void, rng: () => number) => void): void;
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
    scope(ns: string): EventChannel;
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
    surfaceHeight(x: number, z: number): number;
    /** 该坐标的群系；自定义生成器未实现时返回 'unknown' */
    biomeAt(x: number, z: number): BiomeId | 'unknown';
    /** 完整列信息（高度/群系/温湿度/坡度）；自定义生成器未实现时返回 null */
    terrain(x: number, z: number): ColumnInfo | null;
    raycast(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist: number): unknown;
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
  };
  settings: {
    renderDistance(v: number): void;
    sensitivity(v: number): void;
    fov(v: number): void;
    sound(v: boolean): void;
  };
  /** 生存模式：生命 / 饥饿 / 背包（创造模式下多数接口为 no-op） */
  survival: {
    mode(): GameMode;
    setMode(m: GameMode): void;
    health(): number;
    hunger(): number;
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
  setSensitivity(v: number): void;
  setFov(v: number): void;
  setSound(v: boolean): void;
  diagnostics: {
    run(): DiagnosticReport;
    last(): DiagnosticReport | null;
  };
}

export function createCraftAPI(d: APIDeps): CraftAPI {
  return {
    version: VERSION,
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
    },
    diagnostics: {
      run: () => d.diagnostics.run(),
      last: () => d.diagnostics.last(),
    },
    world: {
      seed: () => d.world.generator.seed,
      getBlock: (x, y, z) => d.world.getBlock(x, y, z),
      setBlock: (x, y, z, id) => d.world.setBlock(x, y, z, id),
      surfaceHeight: (x, z) => d.world.surfaceHeight(x, z),
      biomeAt: (x, z) => d.world.generator.biomeAt?.(x, z) ?? 'unknown',
      terrain: (x, z) => d.world.generator.columnInfo?.(x, z) ?? null,
      raycast: (o, dir, max) =>
        d.world.raycast(new THREE.Vector3(o.x, o.y, o.z), new THREE.Vector3(dir.x, dir.y, dir.z), max),
    },
    player: {
      position: () => ({ x: d.player.pos.x, y: d.player.pos.y, z: d.player.pos.z }),
      teleport: (x, y, z) => d.player.teleport(x, y, z),
      setFly: (v) => { if (v && d.survival.isSurvival) return; d.player.fly = v; },
      setCamera: (m) => { d.player.cameraMode = m; },
      break: () => d.player.breakBlock(),
      place: () => d.player.doPlace(),
      selectedBlock: () => d.player.selectedBlock(),
    },
    time: {
      get: () => d.sky.dayTime,
      set: (v) => { d.sky.dayTime = ((v % 1) + 1) % 1; },
      setDayLength: (s) => { d.sky.dayLength = Math.max(10, s); },
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
    },
    settings: {
      renderDistance: (v) => d.setRenderDistance(v),
      sensitivity: (v) => d.setSensitivity(v),
      fov: (v) => d.setFov(v),
      sound: (v) => d.setSound(v),
    },
    survival: {
      mode: () => d.survival.mode,
      setMode: (m) => d.setMode(m),
      health: () => d.survival.health,
      hunger: () => d.survival.hunger,
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
