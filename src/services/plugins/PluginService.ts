import type { EventService } from '../events/EventService';
import type { EventChannel } from '../events/EventChannel';
import type { Disposable, ServiceContainer } from '../ServiceContainer';
import type { CraftAPI } from '../../api/CraftAPI';
import { PLUGIN_API_VERSION, UNSPECIFIED_PLUGIN_VERSION } from '../../core/version';
import { parseDependency, satisfies } from './semver';
import { loadPluginDefinition } from './loader';
import {
  createPluginStorage, defaultPluginStorageProvider,
  type PluginStorageProvider,
} from './storage';
import type {
  PluginContext, PluginDefinition, PluginManifest, PluginPermission,
  PluginRecord, PluginState, PluginStats,
} from './PluginContext';
import { ExtensionRegistry } from './extensions';
import type { CarrierHost, CarrierInfo, WasmBytes } from './carriers/types';
import { activateModuleCarrier, activateHostCarrier } from './carriers';

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

/** 按权限裁剪公开 API：未授权的写能力换成抛错桩，读能力全部保留 */
export function scopeAPI(base: CraftAPI, permissions: PluginPermission[] = []): CraftAPI {
  const perms = new Set(permissions);
  const api = Object.create(base) as CraftAPI;

  const canRegisterBlocks = perms.has('blocks:register');
  if (!canRegisterBlocks) {
    api.registerBlock = (() => deny('blocks:register')) as CraftAPI['registerBlock'];
    api.registerTile = (() => deny('blocks:register')) as CraftAPI['registerTile'];
    api.registerEntity = (() => deny('blocks:register')) as CraftAPI['registerEntity'];
    api.setGenerator = (() => deny('blocks:register')) as CraftAPI['setGenerator'];
  }
  // 旧 22 项里直接暴露了 BlockRegistry。代理保证 register 永远走权限与
  // CraftAPI.registerBlock 门面（否则不会触发 onBlockRegistered / Worker 配置刷新），
  // 同时保留 get / isSolid / all 等读能力。
  if (base.blocks) {
    const registerThroughFacade = base.registerBlock;
    api.blocks = new Proxy(base.blocks, {
      get(target, prop) {
        if (prop === 'register') {
          if (!canRegisterBlocks) return () => deny('blocks:register');
          return (input: Parameters<CraftAPI['registerBlock']>[0]) => registerThroughFacade(input);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  if (!perms.has('api:emit')) {
    api.emit = (() => deny('api:emit')) as unknown as CraftAPI['emit'];
  }
  if (!perms.has('world:write')) {
    const world = Object.create(base.world) as CraftAPI['world'];
    world.setBlock = (() => deny('world:write')) as CraftAPI['world']['setBlock'];
    world.decorate = (() => deny('world:write')) as CraftAPI['world']['decorate'];
    api.world = world;
    if (base.tnt) {
      api.tnt = { ignite: (() => deny('world:write')) as CraftAPI['tnt']['ignite'] };
    }
    if (base.entities) {
      const entities = Object.create(base.entities) as CraftAPI['entities'];
      entities.spawn = (() => deny('world:write')) as CraftAPI['entities']['spawn'];
      api.entities = entities;
    }
  }
  if (!perms.has('player:write')) {
    const player = Object.create(base.player) as CraftAPI['player'];
    player.teleport = (() => deny('player:write')) as CraftAPI['player']['teleport'];
    player.setFly = (() => deny('player:write')) as CraftAPI['player']['setFly'];
    player.break = (() => deny('player:write')) as CraftAPI['player']['break'];
    player.place = (() => deny('player:write')) as CraftAPI['player']['place'];
    api.player = player;
    if (base.survival) {
      const survival = Object.create(base.survival) as CraftAPI['survival'];
      survival.setMode = (() => deny('player:write')) as CraftAPI['survival']['setMode'];
      survival.respawn = (() => deny('player:write')) as CraftAPI['survival']['respawn'];
      survival.give = (() => deny('player:write')) as CraftAPI['survival']['give'];
      survival.damage = (() => deny('player:write')) as CraftAPI['survival']['damage'];
      survival.heal = (() => deny('player:write')) as CraftAPI['survival']['heal'];
      api.survival = survival;
    }
  }
  // 生态扩展点同样按权限裁剪，读能力（stats / listRules）全部保留
  if (!perms.has('botany:register') && base.botany) {
    const botany = Object.create(base.botany) as CraftAPI['botany'];
    botany.registerPlant = (() => deny('botany:register')) as CraftAPI['botany']['registerPlant'];
    botany.unregisterPlant = (() => deny('botany:register')) as CraftAPI['botany']['unregisterPlant'];
    botany.registerRule = (() => deny('botany:register')) as CraftAPI['botany']['registerRule'];
    botany.unregisterRules = (() => deny('botany:register')) as CraftAPI['botany']['unregisterRules'];
    api.botany = botany;
  }
  if (!perms.has('save:write')) {
    const save = Object.create(base.save) as CraftAPI['save'];
    save.import = (() => deny('save:write')) as CraftAPI['save']['import'];
    save.setProvider = (() => deny('save:write')) as CraftAPI['save']['setProvider'];
    api.save = save;
  }
  // v1.5.0：插件管理属于高权限，默认只读（修复「任何插件都能卸载别的插件」）
  if (!perms.has('plugins:manage') && base.plugins) {
    const plugins = Object.create(base.plugins) as CraftAPI['plugins'];
    plugins.list = () => base.plugins.list();
    plugins.register = (() => deny('plugins:manage')) as CraftAPI['plugins']['register'];
    plugins.enable = (() => deny('plugins:manage')) as CraftAPI['plugins']['enable'];
    plugins.disable = (() => deny('plugins:manage')) as CraftAPI['plugins']['disable'];
    plugins.unload = (() => deny('plugins:manage')) as CraftAPI['plugins']['unload'];
    plugins.reload = (() => deny('plugins:manage')) as CraftAPI['plugins']['reload'];
    plugins.enableAll = (() => deny('plugins:manage')) as CraftAPI['plugins']['enableAll'];
    plugins.install = (() => deny('plugins:manage')) as CraftAPI['plugins']['install'];
    api.plugins = plugins;
  }
  // v1.5.0：WASM 写能力需 wasm:use；status / stats / benchmark / listModules 只读保留
  if (!perms.has('wasm:use') && base.wasm) {
    const wasm = Object.create(base.wasm) as CraftAPI['wasm'];
    wasm.call = (() => deny('wasm:use')) as CraftAPI['wasm']['call'];
    wasm.callModule = (() => deny('wasm:use')) as CraftAPI['wasm']['callModule'];
    wasm.registerModule = (() => deny('wasm:use')) as CraftAPI['wasm']['registerModule'];
    wasm.unregisterModule = (() => deny('wasm:use')) as CraftAPI['wasm']['unregisterModule'];
    wasm.setEnabled = (() => deny('wasm:use')) as CraftAPI['wasm']['setEnabled'];
    api.wasm = wasm;
  }
  return api;
}

const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 注册期的 manifest 静态校验：错误在组装阶段暴露，不拖到 enable */
function validateManifest(manifest: PluginManifest, apiVersion: string): void {
  if (manifest.apiVersion !== undefined && !satisfies(apiVersion, manifest.apiVersion)) {
    throw new Error(
      `[plugins] ${manifest.id} 要求插件 API ${manifest.apiVersion}，当前引擎为 ${apiVersion}`,
    );
  }
  if (manifest.priority !== undefined && !Number.isFinite(manifest.priority)) {
    throw new Error(`[plugins] ${manifest.id} priority 必须是有限数值`);
  }
  if (manifest.timeoutMs !== undefined &&
      (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 50 || manifest.timeoutMs > 120_000)) {
    throw new Error(`[plugins] ${manifest.id} timeoutMs 必须是 50~120000 的整数`);
  }
  if (manifest.config !== undefined && !isPlainObject(manifest.config)) {
    throw new Error(`[plugins] ${manifest.id} config 必须是普通对象`);
  }
  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities) ||
        manifest.capabilities.some((c) => typeof c !== 'string' || !CAPABILITY_PATTERN.test(c))) {
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
      void promise.then((r) => {
        if (typeof r === 'function') {
          try { (r as () => void)(); } catch { /* 迟到 teardown 失败不影响主流程 */ }
        }
      }, () => { /* setup 自身失败，无需额外清理 */ });
      reject(new PluginTimeoutError(id, ms));
    }, ms);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
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
  }

  /** 供组装根 / 测试取得本服务使用的扩展注册表（与容器令牌同实例） */
  getExtensions(): ExtensionRegistry { return this.extensions; }

  private snapshot(r: InternalRecord): PluginRecord {
    return {
      manifest: r.def.manifest,
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
    const rec: InternalRecord = {
      def, state: 'registered', teardown: [], epoch: 0,
      warnings: [], registry: new Map<string, unknown>(),
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
    const channel = this.events.scope(id);
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
      const scoped = scopeAPI(base, rec.def.manifest.permissions);
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
        provide: <T>(name: string, value: T): T => { rec.registry.set(name, value); return value; },
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
      let result: void | (() => void) = undefined;
      const def = rec.def;
      if (def.carrier) {
        const bridge: CarrierHost = {
          extensions: this.extensions,
          registerModule: (mid: string, bytes: WasmBytes) => this.wasmHost!.registerModule(mid, bytes),
          unregisterModule: (mid: string) => this.wasmHost!.unregisterModule(mid),
          callKernel: (name: string, args: number[]) => this.wasmHost!.callKernel(name, args),
        };
        const activation = def.carrier.kind === 'wasm:module'
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
      rec.teardown.push(() => { this.extensions.unregisterOwner(id); });
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
        if (parseDependency(spec)?.id === id) { out.push(r.def.manifest.id); break; }
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
    if (!force) {
      const dependents = this.enabledDependents(id);
      if (dependents.length > 0) {
        throw new Error(
          `[plugins] 无法${operation} ${id}：${dependents.join(', ')} 仍依赖它（先停用依赖方，或传 force=true 级联）`,
        );
      }
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
