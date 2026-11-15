import type { EventService, AnyEventHandler } from '../events/EventService';
import type { EventChannel, EventChannelOptions } from '../events/EventChannel';
import type { GameEvents } from '../events/GameEvents';
import type { Disposable, ServiceContainer } from '../ServiceContainer';
import type { CraftAPI } from '../../api/CraftAPI';
import type {
  PluginContext,
  PluginDefinition,
  PluginManifest,
  PluginPermission,
  PluginRecord,
  PluginState,
} from './PluginContext';
import { PLUGIN_PERMISSIONS } from './PluginContext';

interface InternalRecord {
  def: PluginDefinition;
  /** manifest 的防御性副本：插件无法通过 list() / get() 改写自己的权限 */
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
  channel?: EventChannel;
  teardown: (() => void)[];
  /** 每次 enable / disable 自增：异步 setup 返回时据此判断是否已被取消 */
  epoch: number;
}

const deny = (p: PluginPermission): never => {
  throw new Error(`[plugins] 缺少权限 ${p}（在 manifest.permissions 中声明后重试）`);
};

/**
 * 权限 → 需要拦截的写入口（路径相对 CraftAPI 根）。
 *
 * 集中成表而不是散落一地的 if：新增能力时只改这张表，避免「加了写入口忘了加拦截」。
 * 读能力不在此表中，一律经原型链保留。
 */
const WRITE_CAPABILITIES: Record<PluginPermission, readonly string[][]> = {
  'world:write': [['world', 'setBlock'], ['tnt', 'ignite'], ['entities', 'spawn']],
  'player:write': [
    ['player', 'teleport'],
    ['player', 'setFly'],
    ['player', 'break'],
    ['player', 'place'],
    ['player', 'setCamera'],
    ['survival', 'setMode'],
    ['survival', 'respawn'],
    ['survival', 'give'],
    ['survival', 'damage'],
    ['survival', 'heal'],
  ],
  'save:write': [['save', 'import'], ['save', 'setProvider']],
  'blocks:register': [['registerBlock'], ['registerTile'], ['registerEntity'], ['setGenerator']],
  'botany:register': [
    ['botany', 'registerPlant'],
    ['botany', 'unregisterPlant'],
    ['botany', 'registerRule'],
    ['botany', 'unregisterRules'],
  ],
  'time:write': [['time', 'set'], ['time', 'setDayLength']],
  'settings:write': [
    ['settings', 'renderDistance'],
    ['settings', 'sensitivity'],
    ['settings', 'fov'],
    ['settings', 'sound'],
  ],
  'plugins:manage': [
    ['plugins', 'register'],
    ['plugins', 'enable'],
    ['plugins', 'disable'],
    ['plugins', 'unload'],
  ],
  'api:emit': [['emit']],
};

/** 沿路径逐层建立 shadow（Object.create 继承原对象），把末端换成抛错桩 */
const denyPath = (root: CraftAPI, path: readonly string[], permission: PluginPermission): void => {
  let obj: Record<string, unknown> = root as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const shadow = Object.create(obj[key] ?? {}) as Record<string, unknown>;
    obj[key] = shadow;
    obj = shadow;
  }
  obj[path[path.length - 1]] = () => deny(permission);
};

/**
 * 按权限裁剪公开 API：未授权的写能力换成抛错桩，读能力全部保留。
 *
 * `channel` 是插件的命名空间通道（PluginService 启用时注入）：
 * - `api.on / off` 路由进通道，停用时自动撤销，杜绝「api.on 订阅泄漏」；
 * - `api.events.scope(ns)` 返回通道的子通道，同样随插件销毁；
 * - `api.events.waitFor / onAny` 也归属通道，避免绕过通道作用域。
 */
export function scopeAPI(
  base: CraftAPI,
  permissions: PluginPermission[] = [],
  channel?: EventChannel,
): CraftAPI {
  const perms = new Set(permissions);
  const api = Object.create(base) as CraftAPI;

  for (const [permission, paths] of Object.entries(WRITE_CAPABILITIES) as [
    PluginPermission,
    readonly string[][],
  ][]) {
    if (perms.has(permission)) continue;
    for (const path of paths) denyPath(api, path, permission);
  }

  // 旧 22 项里直接暴露了 BlockRegistry。代理保证 register 永远走权限与
  // CraftAPI.registerBlock 门面（否则不会触发 onBlockRegistered / Worker 配置刷新），
  // 同时保留 get / isSolid / all 等读能力（方法必须 bind 回原对象，私有字段才有效）。
  const canRegisterBlocks = perms.has('blocks:register');
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

  // 事件视图：api:emit 必须同时约束 ctx.events.emit 与 api.events.scope(...).emit，
  // 否则插件可以绕开权限直接派发事件（例如触发 core:autosave 误标脏）。
  const canEmit = perms.has('api:emit');
  const baseEvents = base.events;
  api.events = {
    scope: (ns: string, options?: EventChannelOptions): EventChannel =>
      channel
        ? channel.fork(ns)
        : baseEvents.scope(ns, { canEmit: options?.canEmit ?? canEmit }),
    stats: () => baseEvents.stats(),
    onAny: (fn: AnyEventHandler) => (channel ? channel.onAny(fn) : baseEvents.onAny(fn)),
    waitFor: (type, timeoutMs) =>
      channel ? channel.waitFor(type, timeoutMs) : baseEvents.waitFor(type, timeoutMs),
  };
  if (channel) {
    api.on = (<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void) =>
      channel.on(type, fn)) as CraftAPI['on'];
    api.off = (<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void) =>
      base.off(type, fn)) as CraftAPI['off'];
  }
  return api;
}

/**
 * 插件服务（v1.2.0 新增）。
 *
 * 旧架构里「扩展」只是 window.CraftAPI 上一堆自由函数：没有身份、没有生命周期、
 * 没有依赖、没有权限、卸载后订阅无法回收。这里把插件变成一等公民：
 * 注册 → 依赖解析 → 权限裁剪 → setup(注入上下文) → 启用 → 停用/卸载（自动清理）。
 * 任何插件初始化失败都会被隔离成 `failed` 状态并发出 plugin:error，不会拖垮启动流程。
 */
export class PluginService implements Disposable {
  private records = new Map<string, InternalRecord>();
  /** 进行中的 enable 任务：同一个插件并发启用时复用同一次初始化 */
  private pending = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly events: EventService,
    private readonly services: ServiceContainer,
    /** 延迟取值：CraftAPI 在组装根稍后才注入容器 */
    private readonly api: () => CraftAPI,
  ) {}

  /** 返回 manifest 的再副本：调用方改写它不会影响注册表，更无法自我提权 */
  private snapshot(r: InternalRecord): PluginRecord {
    return {
      manifest: {
        ...r.manifest,
        permissions: r.manifest.permissions ? [...r.manifest.permissions] : undefined,
        dependencies: r.manifest.dependencies ? [...r.manifest.dependencies] : undefined,
      },
      state: r.state,
      error: r.error,
    };
  }

  register(def: PluginDefinition): PluginRecord {
    if (this.disposed) throw new Error('[plugins] 服务已销毁');
    const id = def.manifest?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,63}$/i.test(id)) {
      throw new Error(`[plugins] 非法插件 id: ${String(id)}`);
    }
    if (typeof def.setup !== 'function') {
      throw new Error(`[plugins] 插件 ${id} 缺少 setup 函数`);
    }
    const rawPermissions = def.manifest.permissions;
    if (rawPermissions !== undefined && !Array.isArray(rawPermissions)) {
      throw new Error(`[plugins] 插件 ${id} 的 permissions 必须是数组`);
    }
    const permissions = (rawPermissions ?? []) as PluginPermission[];
    const unknown = permissions.filter((p) => !PLUGIN_PERMISSIONS.includes(p));
    if (unknown.length > 0) {
      throw new Error(`[plugins] 插件 ${id} 声明了未知权限：${unknown.join(', ')}`);
    }
    const rawDeps = def.manifest.dependencies;
    if (rawDeps !== undefined && !Array.isArray(rawDeps)) {
      throw new Error(`[plugins] 插件 ${id} 的 dependencies 必须是数组`);
    }
    const dependencies = rawDeps ?? [];
    if (dependencies.some((d) => typeof d !== 'string' || d.length === 0)) {
      throw new Error(`[plugins] 插件 ${id} 的 dependencies 必须是插件 id 数组`);
    }
    if (dependencies.includes(id)) {
      throw new Error(`[plugins] 插件 ${id} 不能依赖自己`);
    }
    if (this.records.has(id)) throw new Error(`[plugins] 插件重复注册: ${id}`);
    const manifest: PluginManifest = {
      ...def.manifest,
      permissions: [...permissions],
      dependencies: [...dependencies],
    };
    const rec: InternalRecord = { def, manifest, state: 'registered', teardown: [], epoch: 0 };
    this.records.set(id, rec);
    this.events.emit('plugin:registered', { id });
    return this.snapshot(rec);
  }

  /** 启用插件：先递归启用依赖，再注入上下文执行 setup */
  async enable(id: string): Promise<void> {
    await this.enableInternal(id, new Set());
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
      // await 期间状态可能已被另一个调用改写，重新读取而不是沿用窄化类型
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
    const id = rec.manifest.id;
    const epoch = ++rec.epoch;
    // 通道的 emit 能力由 api:emit 决定：未声明的插件无法派发事件
    const channel = this.events.scope(id, { canEmit: (rec.manifest.permissions ?? []).includes('api:emit') });
    rec.channel = channel;
    try {
      const chain = new Set(stack);
      chain.add(id);
      for (const dep of rec.manifest.dependencies ?? []) {
        if (!this.records.has(dep)) throw new Error(`依赖未注册: ${dep}`);
        await this.enableInternal(dep, chain);
        // enable 内部会隔离失败为 failed 状态，这里必须显式复查，
        // 否则「依赖初始化失败 / 循环依赖」会被误当作成功继续 setup。
        const depRec = this.records.get(dep);
        if (!depRec || depRec.state !== 'enabled') {
          throw new Error(`依赖未就绪: ${dep} (${depRec?.state ?? 'missing'})`);
        }
      }

      const teardown: (() => void)[] = [];
      const ctx: PluginContext = {
        id,
        events: channel,
        services: this.services,
        api: scopeAPI(this.api(), rec.manifest.permissions, channel),
        log: (...args) => console.log(`[plugin:${id}]`, ...args),
        onDispose: (fn) => { if (typeof fn === 'function') teardown.push(fn); },
      };

      const maybeTeardown = await rec.def.setup(ctx);
      if (typeof maybeTeardown === 'function') teardown.push(maybeTeardown);

      // setup 完成时检查代次：若期间被 disable/dispose，已产物必须回收且不能落为 enabled
      if (this.disposed || rec.epoch !== epoch || rec.state !== 'registered') {
        for (const fn of [...teardown].reverse()) { try { fn(); } catch { /* ignore */ } }
        channel.dispose();
        return;
      }

      rec.teardown = teardown;
      rec.state = 'enabled';
      rec.error = undefined;
      this.events.emit('plugin:enabled', { id });
    } catch (err) {
      // 失败后必须清理本次已创建的通道/副作用，避免半启用泄漏
      try { channel.dispose(); } catch { /* ignore */ }
      if (rec.epoch === epoch) {
        rec.teardown = [];
        rec.channel = undefined;
        rec.state = 'failed';
        rec.error = err instanceof Error ? err.message : String(err);
      }
      this.events.emit('plugin:error', { id, error: rec.error ?? String(err) });
      throw err;
    }
  }

  async disable(id: string): Promise<void> {
    if (this.disposed) throw new Error('[plugins] 服务已销毁');
    const rec = this.records.get(id);
    if (!rec) throw new Error(`[plugins] 插件未注册: ${id}`);
    if (rec.state !== 'enabled' && rec.state !== 'failed') return;
    // 先自增代次，让正在进行的 setup 在返回后感知到取消
    rec.epoch++;
    for (const fn of [...rec.teardown].reverse()) {
      try { fn(); } catch (err) { console.warn(`[plugins] ${id} teardown error:`, err); }
    }
    rec.teardown = [];
    try { rec.channel?.dispose(); } catch { /* ignore */ }
    rec.channel = undefined;
    rec.state = 'disabled';
    this.events.emit('plugin:disabled', { id });
  }

  async unload(id: string): Promise<void> {
    await this.disable(id);
    this.records.delete(id);
  }

  get(id: string): PluginRecord | undefined {
    const rec = this.records.get(id);
    return rec ? this.snapshot(rec) : undefined;
  }

  list(): PluginRecord[] {
    return [...this.records.values()].map((r) => this.snapshot(r));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = [...this.records.keys()].reverse();
    for (const id of ids) {
      try { await this.disable(id); } catch { /* ignore */ }
    }
    this.records.clear();
    this.pending.clear();
  }
}
