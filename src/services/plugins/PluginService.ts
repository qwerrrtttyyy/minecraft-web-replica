import type { CraftAPI } from '../../api/CraftAPI';
import { PLUGIN_API_VERSION, UNSPECIFIED_PLUGIN_VERSION } from '../../core/version';
import type { EventChannel, EventChannelOptions } from '../events/EventChannel';
import type { AnyEventHandler, EventService } from '../events/EventService';
import type { GameEvents } from '../events/GameEvents';
import type { Disposable, ServiceContainer } from '../ServiceContainer';
import { activateHostCarrier, activateModuleCarrier } from './carriers';
import type { CarrierHost, CarrierInfo, WasmBytes } from './carriers/types';
import { ExtensionRegistry } from './extensions';
import { loadPluginDefinition } from './loader';
import {
  PLUGIN_PERMISSIONS,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  type PluginPermission,
  type PluginRecord,
  type PluginState,
  type PluginStats,
} from './PluginContext';
import { parseDependency, satisfies } from './semver';
import { createPluginStorage, defaultPluginStorageProvider, type PluginStorageProvider } from './storage';

interface InternalRecord {
  def: PluginDefinition;
  state: PluginState;
  error?: string;
  channel?: EventChannel;
  teardown: (() => void)[];
  /** v1.6.0：本次激活的载体信息 */
  carrier?: CarrierInfo;
  /** 每次 enable / disable 自增：异步 setup 返回时据此判断是否已被取消 */
  epoch: number;
  /** v1.5.0：可选依赖缺失 / 失败等非致命问题 */
  warnings: string[];
  durationMs?: number;
  /** v1.5.0：插件私有服务注册表，停用即清空 */
  registry: Map<string, unknown>;
}

const deny = (p: PluginPermission): never => {
  throw new Error(`[plugins] 缺少权限 ${p}（在 manifest.permissions 中声明后重试）`);
};

/** 按权限裁剪公开 API：未授权的写能力换成抛错桩，读能力全部保留。
 *
 * 表面以 src/api/CraftAPI.ts 的 interface 为准（H14）——由
 * test/permission-table-check.cjs 机械校验，改名/新增写入口不同步会直接失败。
 */
const WRITE_CAPABILITIES: Record<PluginPermission, readonly string[][]> = {
  'world:write': [
    ['world', 'setBlock'],
    ['world', 'decorate'],
    ['tnt', 'ignite'],
    ['entities', 'spawn'],
  ],
  'player:write': [
    ['player', 'teleport'],
    ['player', 'setFly'],
    ['player', 'setCamera'],
    ['player', 'break'],
    ['player', 'place'],
    ['survival', 'setMode'],
    ['survival', 'respawn'],
    ['survival', 'give'],
    ['survival', 'damage'],
    ['survival', 'heal'],
  ],
  // H14：export / exportFile 可全量读出并存档外带，与 import 同属 save:write 约束
  'save:write': [
    ['save', 'export'],
    ['save', 'import'],
    ['save', 'exportFile'],
    ['save', 'importFile'],
    ['save', 'setProvider'],
  ],
  'blocks:register': [['registerBlock'], ['registerTile'], ['registerEntity'], ['setGenerator']],
  'time:write': [
    ['time', 'set'],
    ['time', 'setDayLength'],
  ],
  // H14：settings 实际 17 个写入口此前只拦 4 个（可改线程数 / 关自动保存 /
  // importOptions 一键改全部设置）；input.setBinding 可改键位，一并列入。
  'settings:write': [
    ['settings', 'renderDistance'],
    ['settings', 'sensitivity'],
    ['settings', 'fov'],
    ['settings', 'sound'],
    ['settings', 'volume'],
    ['settings', 'invertY'],
    ['settings', 'quality'],
    ['settings', 'particles'],
    ['settings', 'viewBob'],
    ['settings', 'autoJump'],
    ['settings', 'touchSensitivity'],
    ['settings', 'debugOverlay'],
    ['settings', 'greedy'],
    ['settings', 'mesherThreads'],
    ['settings', 'autosaveInterval'],
    ['settings', 'importOptions'],
    ['input', 'setBinding'],
    ['input', 'resetBindings'],
  ],
  'plugins:manage': [
    ['plugins', 'register'],
    ['plugins', 'enable'],
    ['plugins', 'disable'],
    ['plugins', 'unload'],
  ],
  'botany:register': [
    ['botany', 'registerPlant'],
    ['botany', 'unregisterPlant'],
    ['botany', 'registerRule'],
    ['botany', 'unregisterRules'],
  ],
  'api:emit': [['emit']],
  'wasm:use': [
    ['wasm', 'call'],
    ['wasm', 'callModule'],
    ['wasm', 'registerModule'],
    ['wasm', 'unregisterModule'],
    ['wasm', 'setEnabled'],
  ],
  'events:subscribe': [['on'], ['off']],
};

/** 在白名单副本上打 deny 桩（副本原型是 Object.prototype，桩之外爬不到原对象） */
const denyPath = (root: Record<string, unknown>, path: readonly string[], permission: PluginPermission): void => {
  let obj = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = (obj[key] ?? {}) as Record<string, unknown>;
    obj[key] = next;
    obj = next;
  }
  obj[path[path.length - 1]] = () => deny(permission);
};

/**
 * H13：把 src（含原型链）的全部成员拷成全新普通对象——函数 bind 回 src
 * （私有字段仍有效），getter/setter 转发到 src。产出对象的原型是
 * Object.prototype，插件无法再经 Object.getPrototypeOf 摸到未裁剪的真方法。
 */
function copyObject(src: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let o: object | null = src; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor' || key in out) continue;
      const d = Object.getOwnPropertyDescriptor(o, key)!;
      if (d.get || d.set) {
        Object.defineProperty(out, key, {
          get() {
            return d.get!.call(src);
          },
          set(v) {
            d.set?.call(src, v);
          },
          enumerable: true,
        });
      } else if (typeof d.value === 'function') {
        out[key] = (d.value as (...a: unknown[]) => unknown).bind(src);
      } else {
        out[key] = d.value;
      }
    }
  }
  return out;
}

/**
 * 公开 API 的命名空间级白名单：只暴露 CraftAPI interface 声明的成员。
 * 白名单决定「可见性」，WRITE_CAPABILITIES 决定「可写性」，二者不混用。
 * 原型链隔离由 copyObject 负责（产出对象的原型是 Object.prototype），
 * 不再依赖 Proxy 或 Object.freeze——冻结 Proxy 的 target 会触发 Node 24
 * 的不变式校验，把 deny 桩换成真方法时抛 TypeError。
 */
const API_TOP_LEVEL = [
  'version',
  'release',
  'registerBlock',
  'registerTile',
  'registerEntity',
  'setGenerator',
  'on',
  'off',
  'emit',
] as const;

const API_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  events: ['scope', 'stats', 'onAny', 'waitFor'],
  plugins: [
    'register',
    'enable',
    'disable',
    'unload',
    'list',
    'get',
    'reload',
    'enableAll',
    'stats',
    'install',
    'findByCapability',
  ],
  wasm: [
    'status',
    'stats',
    'benchmark',
    'setEnabled',
    'listModules',
    'call',
    'callModule',
    'registerModule',
    'unregisterModule',
  ],
  extensions: ['points', 'stats', 'has', 'list'],
  botany: ['registerPlant', 'unregisterPlant', 'registerRule', 'unregisterRules', 'listRules', 'stats'],
  diagnostics: ['run', 'last'],
  world: ['seed', 'getBlock', 'setBlock', 'decorate', 'surfaceHeight', 'biomeAt', 'terrain', 'raycast'],
  player: ['position', 'teleport', 'setFly', 'setCamera', 'break', 'place', 'selectedBlock'],
  time: ['get', 'set', 'setDayLength', 'text'],
  entities: ['spawn', 'list'],
  tnt: ['ignite'],
  save: ['export', 'import', 'setProvider', 'exportFile', 'importFile'],
  settings: [
    'renderDistance',
    'sensitivity',
    'fov',
    'sound',
    'volume',
    'invertY',
    'quality',
    'particles',
    'viewBob',
    'autoJump',
    'touchSensitivity',
    'debugOverlay',
    'greedy',
    'mesherThreads',
    'autosaveInterval',
    'exportOptions',
    'importOptions',
  ],
  input: ['getBinding', 'setBinding', 'resetBindings', 'gamepadConnected'],
  survival: [
    'mode',
    'setMode',
    'health',
    'hunger',
    'breath',
    'damage',
    'heal',
    'give',
    'count',
    'inventory',
    'respawn',
  ],
  // 不透明门面：整段复制（见 OPAQUE_NAMESPACES）
  blocks: [],
  engine: [],
};

/** 不透明门面（注册表 / 引擎）：整段复制，不按成员白名单裁剪。 */
const OPAQUE_NAMESPACES = new Set(['blocks', 'engine']);

/** 只挑白名单成员，保留 getter/setter 描述符与 bind 后的函数。 */
function pickAllowed(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(src, key);
    if (d) Object.defineProperty(out, key, d);
  }
  return out;
}

/**
 * 按权限裁剪公开 API：只暴露命名空间白名单内的成员，未授权的写能力换成抛错桩。
 *
 * `channel` 是插件的命名空间通道（PluginService 启用时注入）：
 * - `api.on / off` 路由进通道，停用时自动撤销，杜绝「api.on 订阅泄漏」；
 * - `api.events.scope(ns)` 返回通道的子通道，同样随插件销毁；
 * - `api.events.waitFor / onAny` 也归属通道，避免绕过通道作用域。
 */
export function scopeAPI(base: CraftAPI, permissions: PluginPermission[] = [], channel?: EventChannel): CraftAPI {
  const perms = new Set(permissions);
  const baseCopy = copyObject(base) as Record<string, unknown>;
  const rec: Record<string, unknown> = pickAllowed(baseCopy, API_TOP_LEVEL);

  for (const [ns, keys] of Object.entries(API_NAMESPACES)) {
    const value = baseCopy[ns];
    if (!value || typeof value !== 'object') continue;
    const copied = copyObject(value as object);
    rec[ns] = OPAQUE_NAMESPACES.has(ns) ? copied : pickAllowed(copied, keys);
  }

  for (const [permission, paths] of Object.entries(WRITE_CAPABILITIES) as [PluginPermission, readonly string[][]][]) {
    if (perms.has(permission)) continue;
    for (const path of paths) denyPath(rec, path, permission);
  }
  const api = rec as unknown as CraftAPI;

  // 旧 22 项里直接暴露了 BlockRegistry：register 必须走权限与
  // CraftAPI.registerBlock 门面（否则不会触发 onBlockRegistered / Worker 配置刷新），
  // 同时保留 get / isSolid / all 等读能力（方法 bind 回原对象，私有字段才有效）。
  const canRegisterBlocks = perms.has('blocks:register');
  if (base.blocks) {
    const registerThroughFacade = base.registerBlock;
    const blocksView = rec.blocks as Record<string, unknown>;
    blocksView.register = canRegisterBlocks
      ? (input: Parameters<CraftAPI['registerBlock']>[0]) => registerThroughFacade(input)
      : () => deny('blocks:register');
  }

  // 事件视图：api:emit 必须同时约束 ctx.events.emit 与 api.events.scope(...).emit，
  // 否则插件可以绕开权限直接派发事件（例如触发 core:autosave 误标脏）。
  // M24：canEmit 只来自权限表，忽略调用方传入的 options——未授权插件
  // 不能借 scope(ns, { canEmit: true }) 自我提权。
  const canEmit = perms.has('api:emit');
  const baseEvents = base.events;
  api.events = {
    scope: (ns: string, options?: EventChannelOptions): EventChannel =>
      channel ? channel.fork(ns) : baseEvents.scope(ns, { ...options, canEmit }),
    stats: () => baseEvents.stats(),
    onAny: (fn: AnyEventHandler) => (channel ? channel.onAny(fn) : baseEvents.onAny(fn)),
    waitFor: (type, timeoutMs) => (channel ? channel.waitFor(type, timeoutMs) : baseEvents.waitFor(type, timeoutMs)),
  };
  if (channel) {
    api.on = (<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void) =>
      channel.on(type, fn)) as CraftAPI['on'];
    api.off = (<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void) =>
      base.off(type, fn)) as CraftAPI['off'];
  }
  // v2：插件管理面默认只读；写操作需 plugins:manage（避免插件互相劫持）。
  // rec.plugins 是白名单副本，补上 denyPath 未覆盖的三个写方法。
  if (!perms.has('plugins:manage') && rec.plugins) {
    const plugins = rec.plugins as Record<string, unknown>;
    for (const m of ['reload', 'enableAll', 'install']) {
      plugins[m] = () => deny('plugins:manage');
    }
  }
  return api;
}

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 注册期的 manifest 静态校验：错误在组装阶段暴露，不拖到 enable */
function validateManifest(manifest: PluginManifest, apiVersion: string): void {
  if (manifest.apiVersion !== undefined && !satisfies(apiVersion, manifest.apiVersion)) {
    throw new Error(`[plugins] ${manifest.id} 要求插件 API ${manifest.apiVersion}，当前引擎为 ${apiVersion}`);
  }
  if (manifest.priority !== undefined && !Number.isFinite(manifest.priority)) {
    throw new Error(`[plugins] ${manifest.id} priority 必须是有限数值`);
  }
  if (
    manifest.timeoutMs !== undefined &&
    (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 50 || manifest.timeoutMs > 120_000)
  ) {
    throw new Error(`[plugins] ${manifest.id} timeoutMs 必须是 50~120000 的整数`);
  }
  if (manifest.config !== undefined && !isPlainObject(manifest.config)) {
    throw new Error(`[plugins] ${manifest.id} config 必须是普通对象`);
  }
  if (manifest.capabilities !== undefined) {
    if (
      !Array.isArray(manifest.capabilities) ||
      manifest.capabilities.some((c) => typeof c !== 'string' || !CAPABILITY_PATTERN.test(c))
    ) {
      throw new Error(`[plugins] ${manifest.id} capabilities 必须是合法标识符数组`);
    }
  }
  for (const key of ['dependencies', 'optionalDependencies'] as const) {
    const list = manifest[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`[plugins] ${manifest.id} ${key} 必须是数组`);
    for (const spec of list) {
      if (typeof spec !== 'string' || parseDependency(spec) === null) {
        throw new Error(`[plugins] ${manifest.id} 非法依赖声明: ${String(spec)}`);
      }
    }
  }
}

class PluginTimeoutError extends Error {
  constructor(id: string, ms: number) {
    super(`[plugins] ${id} setup 超时（${ms}ms）`);
    this.name = 'PluginTimeoutError';
  }
}

/** setup 超时保护；迟到的 teardown 仍会执行，避免插件资源泄漏 */
function withSetupTimeout<T>(work: T | Promise<T>, ms: number, id: string): Promise<T> {
  const promise = Promise.resolve(work) as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void promise.then(
        (r) => {
          if (typeof r === 'function') {
            try {
              (r as () => void)();
            } catch {
              /* 迟到 teardown 失败不影响主流程 */
            }
          }
        },
        () => {
          /* setup 自身失败，无需额外清理 */
        },
      );
      reject(new PluginTimeoutError(id, ms));
    }, ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface PluginServiceOptions {
  /** 引擎插件 API 版本，默认 core/version.ts 的 PLUGIN_API_VERSION */
  apiVersion?: string;
  /** 插件私有存储 provider，默认按环境选择 localStorage / 内存 */
  storage?: PluginStorageProvider;
  /** setup 默认超时，默认 5000ms */
  defaultTimeoutMs?: number;
  /** v1.6.0：扩展点注册表；缺省时自建一个（测试 / 独立使用仍可用） */
  extensions?: ExtensionRegistry;
  /**
   * v1.6.0：WASM 载体的宿主桥接。缺省时 wasm 载体会因「未接线」被隔离为 failed，
   * 组装根必须注入真实实现；这样保证 Node 单测不依赖 WASM 运行时也能跑。
   */
  wasmHost?: Omit<CarrierHost, 'extensions'>;
  /** v1.5.0：实验性内容开关；关闭时拒绝 wasm:module / wasm:host 载体插件 */
  experimental?: boolean;
}

/**
 * 插件服务（v1.2.0 引入，v1.5.0 扩展为 v2）。
 *
 * 生命周期：注册 → manifest 校验 → 依赖（含 semver 约束）解析 → 权限裁剪 →
 * setup(注入上下文，带超时) → 启用 → 停用/卸载（自动清理）→ 热重载。
 * 任何插件初始化失败都会被隔离成 `failed` 状态并发出 plugin:error，不拖垮启动。
 */
export class PluginService implements Disposable {
  private records = new Map<string, InternalRecord>();
  /** 进行中的 enable 任务：同一个插件并发启用时复用同一次初始化 */
  private pending = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly apiVersion: string;
  private readonly storage: PluginStorageProvider;
  private readonly defaultTimeoutMs: number;
  private readonly extensions: ExtensionRegistry;
  private readonly wasmHost?: Omit<CarrierHost, 'extensions'>;
  /** 实验性内容：WASM 载体总开关（运行期可切换） */
  private experimental: boolean;

  constructor(
    private readonly events: EventService,
    private readonly services: ServiceContainer,
    /** 延迟取值：CraftAPI 在组装根稍后才注入容器 */
    private readonly api: () => CraftAPI,
    options: PluginServiceOptions = {},
  ) {
    this.apiVersion = options.apiVersion ?? PLUGIN_API_VERSION;
    this.storage = options.storage ?? defaultPluginStorageProvider();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    // 组装根显式注入并与 TOKENS.Extensions 共享同一实例；单测缺省时自建私有实例
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.wasmHost = options.wasmHost;
    this.experimental = options.experimental ?? true;
  }

  /** 供组装根 / 测试取得本服务使用的扩展注册表（与容器令牌同实例） */
  getExtensions(): ExtensionRegistry {
    return this.extensions;
  }

  /** 实验性内容开关：关闭后新启用的 WASM 载体插件会被隔离为 failed；已启用的不受影响 */
  setExperimental(v: boolean): void {
    this.experimental = v;
  }
  getExperimental(): boolean {
    return this.experimental;
  }

  private snapshot(r: InternalRecord): PluginRecord {
    return {
      manifest: {
        ...r.def.manifest,
        permissions: r.def.manifest.permissions ? [...r.def.manifest.permissions] : undefined,
        dependencies: r.def.manifest.dependencies ? [...r.def.manifest.dependencies] : undefined,
        optionalDependencies: r.def.manifest.optionalDependencies
          ? [...r.def.manifest.optionalDependencies]
          : undefined,
        capabilities: r.def.manifest.capabilities ? [...r.def.manifest.capabilities] : undefined,
      },
      state: r.state,
      error: r.error,
      warnings: r.warnings.length > 0 ? [...r.warnings] : undefined,
      durationMs: r.durationMs,
      carrier: r.carrier,
    };
  }

  register(def: PluginDefinition): PluginRecord {
    if (this.disposed) throw new Error('[plugins] 服务已销毁');
    const id = def.manifest?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,63}$/i.test(id)) {
      throw new Error(`[plugins] 非法插件 id: ${String(id)}`);
    }
    if (this.records.has(id)) throw new Error(`[plugins] 插件重复注册: ${id}`);
    if (typeof def.setup !== 'function' && !def.carrier) {
      throw new Error(`[plugins] ${id} 缺少 setup(ctx) 或 carrier（JS / WASM 载体二选一）`);
    }
    if (def.carrier) {
      const k = def.carrier.kind;
      if (k !== 'wasm:module' && k !== 'wasm:host') {
        throw new Error(`[plugins] ${id} 未知载体类型: ${String(k)}`);
      }
      if (!this.wasmHost) {
        throw new Error(`[plugins] ${id} 使用 WASM 载体，但宿主桥接未接线（组装根需注入 wasmHost）`);
      }
    }
    validateManifest(def.manifest, this.apiVersion);
    if ((def.manifest.dependencies ?? []).some((s: string) => parseDependency(s)?.id === id)) {
      throw new Error(`[plugins] 插件 ${id} 不能依赖自己`);
    }
    const perms = def.manifest.permissions ?? [];
    if (!Array.isArray(perms)) throw new Error(`[plugins] ${id} 的 permissions 必须是数组`);
    const unknown = perms.filter((p: string) => !(PLUGIN_PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length > 0) throw new Error(`[plugins] ${id} 声明了未知权限：${unknown.join(', ')}`);
    const rec: InternalRecord = {
      def,
      state: 'registered',
      teardown: [],
      epoch: 0,
      warnings: [],
      registry: new Map<string, unknown>(),
    };
    this.records.set(id, rec);
    this.events.emit('plugin:registered', { id });
    return this.snapshot(rec);
  }

  /** v1.5.0：从可信源码加载插件定义并注册（等价于 eval，仅用于已审计源码） */
  install(source: string): PluginRecord {
    return this.register(loadPluginDefinition(source));
  }

  async enable(id: string): Promise<void> {
    await this.enableInternal(id, new Set());
  }

  /** v1.5.0：按 priority 降序启用全部已注册插件（顺序启用，依赖会自行先启用） */
  async enableAll(): Promise<void> {
    const ids = [...this.records.values()]
      .sort((a, b) => (b.def.manifest.priority ?? 0) - (a.def.manifest.priority ?? 0))
      .map((r) => r.def.manifest.id);
    for (const id of ids) await this.enable(id);
  }

  /**
   * 代次（epoch）+ pending 任务表解决两个生命周期问题：
   * 1. 并发 enable 不再被误判为循环依赖（复用同一个 Promise）；
   * 2. setup 尚未完成时 disable，回调返回后只清理、不回写 enabled。
   */
  private async enableInternal(id: string, stack: Set<string>): Promise<void> {
    if (this.disposed) throw new Error('[plugins] 服务已销毁');
    const rec = this.records.get(id);
    if (!rec) throw new Error(`[plugins] 插件未注册: ${id}`);
    if (rec.state === 'enabled') return;
    // 只沿当前递归链判断循环；跨调用并发启用是合法的
    if (stack.has(id)) throw new Error(`[plugins] 循环依赖: ${id}`);

    const running = this.pending.get(id);
    if (running) {
      await running;
      if (this.disposed || (rec.state as PluginState) === 'enabled') return;
      // 上一次初始化被取消或失败：允许当前调用重新初始化
    }

    const task = this.runEnable(rec, stack);
    this.pending.set(id, task);
    try {
      await task;
    } finally {
      if (this.pending.get(id) === task) this.pending.delete(id);
    }
  }

  private async runEnable(rec: InternalRecord, stack: Set<string>): Promise<void> {
    const id = rec.def.manifest.id;
    const epoch = ++rec.epoch;
    const channel = this.events.scope(id, { canEmit: (rec.def.manifest.permissions ?? []).includes('api:emit') });
    rec.channel = channel;
    rec.warnings = [];
    rec.registry.clear();
    const startedAt = Date.now();
    try {
      const chain = new Set(stack);
      chain.add(id);
      for (const spec of rec.def.manifest.dependencies ?? []) {
        const parsed = parseDependency(spec);
        if (!parsed) throw new Error(`非法依赖声明: ${spec}`);
        const depRec = this.records.get(parsed.id);
        if (!depRec) throw new Error(`依赖未注册: ${parsed.id}`);
        if (parsed.range !== '*') {
          const depVersion = depRec.def.manifest.version ?? UNSPECIFIED_PLUGIN_VERSION;
          if (!satisfies(depVersion, parsed.range)) {
            throw new Error(`依赖 ${parsed.id} 版本 ${depVersion} 不满足约束 ${parsed.range}`);
          }
        }
        await this.enableInternal(parsed.id, chain);
        // enable 内部会隔离失败为 failed 状态，这里必须显式复查
        const after = this.records.get(parsed.id);
        if (!after || after.state !== 'enabled') {
          throw new Error(`依赖 ${parsed.id} 未成功启用（${after?.state ?? 'missing'} ${after?.error ?? ''}）`);
        }
        if (rec.epoch !== epoch || this.disposed) throw new Error('初始化期间被停用');
      }
      for (const spec of rec.def.manifest.optionalDependencies ?? []) {
        const parsed = parseDependency(spec);
        if (!parsed) continue;
        if (!this.records.has(parsed.id)) {
          rec.warnings.push(`可选依赖未注册: ${parsed.id}`);
          continue;
        }
        try {
          await this.enableInternal(parsed.id, chain);
        } catch (e) {
          rec.warnings.push(`可选依赖 ${parsed.id} 启用异常：${e instanceof Error ? e.message : String(e)}`);
        }
        const after = this.records.get(parsed.id);
        if (!after || after.state !== 'enabled') {
          rec.warnings.push(`可选依赖 ${parsed.id} 未成功启用（${after?.state ?? 'missing'}）`);
        }
        if (rec.epoch !== epoch || this.disposed) throw new Error('初始化期间被停用');
      }

      const base = this.api();
      const scoped = scopeAPI(base, rec.def.manifest.permissions, channel);
      const storage = createPluginStorage(this.storage, id);
      const saved = storage.get<unknown>('config', {});
      const config = Object.freeze({
        ...(rec.def.manifest.config ?? {}),
        ...(isPlainObject(saved) ? saved : {}),
      });
      const ctx: PluginContext = {
        id,
        events: channel,
        services: this.services,
        api: scoped,
        manifest: Object.freeze({ ...rec.def.manifest }),
        apiVersion: this.apiVersion,
        config,
        storage,
        log: (...args: unknown[]) => console.log(`[plugin:${id}]`, ...args),
        onDispose: (fn) => rec.teardown.push(fn),
        provide: <T>(name: string, value: T): T => {
          rec.registry.set(name, value);
          return value;
        },
        require: <T>(name: string): T => {
          if (!rec.registry.has(name)) throw new Error(`[plugin:${id}] 插件私有服务未注册: ${name}`);
          return rec.registry.get(name) as T;
        },
        tryRequire: <T>(name: string): T | undefined => rec.registry.get(name) as T | undefined,
        extensions: this.extensions,
      };
      const timeoutMs = rec.def.manifest.timeoutMs ?? this.defaultTimeoutMs;

      // v1.6.0：载体分派。JS 走 setup；WASM 走适配器（统一返回 teardown + carrier 信息）。
      // 两条路径共用上面的 ctx / 权限裁剪 / 依赖解析，因此行为一致。
      let result: void | (() => void) | undefined;
      const def = rec.def;
      if (def.carrier) {
        const bridge: CarrierHost = {
          extensions: this.extensions,
          registerModule: (mid: string, bytes: WasmBytes) => this.wasmHost!.registerModule(mid, bytes),
          unregisterModule: (mid: string) => this.wasmHost!.unregisterModule(mid),
          callKernel: (name: string, args: number[]) => this.wasmHost!.callKernel(name, args),
        };
        if (def.carrier.kind.startsWith('wasm:') && !this.experimental) {
          throw new Error(`[plugins] ${id} 使用实验性 WASM 载体，请在设置页开启「实验性内容」`);
        }
        const activation =
          def.carrier.kind === 'wasm:module'
            ? activateModuleCarrier(def.carrier, ctx, bridge)
            : activateHostCarrier(def.carrier as import('./carriers/types').WasmHostCarrier, ctx, bridge);
        rec.teardown.push(activation.teardown);
        rec.carrier = activation.info;
      } else {
        const setupResult = await withSetupTimeout(def.setup!(ctx), timeoutMs, id);
        result = setupResult as void | (() => void);
      }
      if (rec.epoch !== epoch || this.disposed) {
        // 初始化期间被 disable / unload：清理，但不要覆盖 disabled 状态
        if (typeof result === 'function') rec.teardown.push(result);
        this.runTeardown(rec);
        channel.dispose();
        if (rec.channel === channel) rec.channel = undefined;
        return;
      }
      if (typeof result === 'function') rec.teardown.push(result);
      // 扩展点归属清理：任何载体停用都撤销本插件注册的全部扩展点
      rec.teardown.push(() => {
        this.extensions.unregisterOwner(id);
      });
      rec.state = 'enabled';
      rec.error = undefined;
      rec.durationMs = Date.now() - startedAt;
      this.events.emit('plugin:enabled', { id });
    } catch (e) {
      if (rec.epoch !== epoch || this.disposed) {
        // 取消路径：不标 failed，也不污染 plugin:error
        this.runTeardown(rec);
        channel.dispose();
        if (rec.channel === channel) rec.channel = undefined;
        return;
      }
      rec.state = 'failed';
      rec.error = e instanceof Error ? e.message : String(e);
      // 初始化中途失败也要清理已注册的订阅与钩子
      this.runTeardown(rec);
      rec.registry.clear();
      channel.dispose();
      if (rec.channel === channel) rec.channel = undefined;
      this.events.emit('plugin:error', { id, error: rec.error });
    }
  }

  private runTeardown(rec: InternalRecord): void {
    for (const fn of rec.teardown.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error(`[plugins] ${rec.def.manifest.id} teardown 失败`, e);
      }
    }
  }

  /** 已启用、且把 id 声明为必需依赖的插件 */
  private enabledDependents(id: string): string[] {
    const out: string[] = [];
    for (const r of this.records.values()) {
      if (r.def.manifest.id === id || r.state !== 'enabled') continue;
      for (const spec of r.def.manifest.dependencies ?? []) {
        if (parseDependency(spec)?.id === id) {
          out.push(r.def.manifest.id);
          break;
        }
      }
    }
    return out;
  }

  /**
   * 停用 / 卸载共用的内部实现。operation 只用于错误信息，让调用方看到与自身操作一致的提示
   * （unload 抛错时不应说“无法停用”），行为、事件与代次处理两者完全相同。
   * force=true 时跳过反向依赖保护（dispose / reload / 显式强制使用）。
   */
  private stopWithGuard(id: string, force: boolean, operation: string): void {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'disabled') return;
    const dependents = this.enabledDependents(id);
    if (!force) {
      if (dependents.length > 0) {
        throw new Error(
          `[plugins] 无法${operation} ${id}：${dependents.join(', ')} 仍依赖它（先停用依赖方，或传 force=true 级联）`,
        );
      }
    } else {
      // 显式级联：依赖方先 teardown，再停用目标本身（保留 v1.4.9 的级联语义）
      for (const dep of dependents) this.stopWithGuard(dep, true, operation);
    }
    // 使进行中的 setup 失效：它返回后只做清理，不会再写回 enabled
    rec.epoch++;
    this.runTeardown(rec);
    rec.registry.clear();
    rec.channel?.dispose();
    rec.channel = undefined;
    rec.state = 'disabled';
    this.events.emit('plugin:disabled', { id });
  }

  /** force=true 时跳过反向依赖保护（dispose / 显式强制停用使用） */
  disable(id: string, force = false): void {
    this.stopWithGuard(id, force, '停用');
  }

  /**
   * 卸载：停用后从注册表移除，可再次注册同 id。
   * 与 disable 一样受反向依赖保护——若仍有启用中的插件依赖它，会抛错且**不会**移除记录；
   * 确实需要强制卸载时传 force=true（会连带依赖方失去依赖，调用方自行负责一致性）。
   */
  unload(id: string, force = false): void {
    this.stopWithGuard(id, force, '卸载');
    this.records.delete(id);
  }

  /** v1.5.0：热重载 = 强制卸载 → 重新注册 → 重新启用 */
  async reload(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`[plugins] 插件未注册: ${id}`);
    const def = rec.def;
    this.unload(id, true);
    this.register(def);
    await this.enable(id);
    this.events.emit('plugin:reloaded', { id });
  }

  list(): PluginRecord[] {
    return [...this.records.values()].map((r) => this.snapshot(r));
  }

  get(id: string): PluginRecord | undefined {
    const r = this.records.get(id);
    return r ? this.snapshot(r) : undefined;
  }

  /** v1.5.0：能力发现 */
  findByCapability(capability: string): string[] {
    return [...this.records.values()]
      .filter((r) => r.def.manifest.capabilities?.includes(capability))
      .map((r) => r.def.manifest.id);
  }

  stats(): PluginStats {
    const list = [...this.records.values()];
    const capabilities = new Set<string>();
    let totalEnableMs = 0;
    let warnings = 0;
    for (const r of list) {
      for (const c of r.def.manifest.capabilities ?? []) capabilities.add(c);
      totalEnableMs += r.durationMs ?? 0;
      warnings += r.warnings.length;
    }
    return {
      total: list.length,
      registered: list.filter((r) => r.state === 'registered').length,
      enabled: list.filter((r) => r.state === 'enabled').length,
      disabled: list.filter((r) => r.state === 'disabled').length,
      failed: list.filter((r) => r.state === 'failed').length,
      capabilities: [...capabilities].sort(),
      totalEnableMs,
      warnings,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 强制路径：跳过反向依赖保护，确保全部插件落到 disabled 终态
    for (const id of [...this.records.keys()]) this.disable(id, true);
    // 保留注册表以便 service:ready / 调试面板在销毁后仍能查看最终状态
  }
}
