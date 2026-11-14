import type { EventService } from '../events/EventService';
import type { EventChannel } from '../events/EventChannel';
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

interface InternalRecord {
  def: PluginDefinition;
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
  // 同时保留 get / isSolid / all 等读能力（方法必须 bind 回原对象，私有字段才有效）。
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
  if (!perms.has('save:write')) {
    const save = Object.create(base.save) as CraftAPI['save'];
    save.import = (() => deny('save:write')) as CraftAPI['save']['import'];
    save.setProvider = (() => deny('save:write')) as CraftAPI['save']['setProvider'];
    api.save = save;
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

  private snapshot(r: InternalRecord): PluginRecord {
    return { manifest: r.def.manifest, state: r.state, error: r.error };
  }

  register(def: PluginDefinition): PluginRecord {
    if (this.disposed) throw new Error('[plugins] 服务已销毁');
    const id = def.manifest?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,63}$/i.test(id)) {
      throw new Error(`[plugins] 非法插件 id: ${String(id)}`);
    }
    if (this.records.has(id)) throw new Error(`[plugins] 插件重复注册: ${id}`);
    const rec: InternalRecord = { def, state: 'registered', teardown: [], epoch: 0 };
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
    const id = rec.def.manifest.id;
    const epoch = ++rec.epoch;
    const channel = this.events.scope(id);
    rec.channel = channel;
    try {
      const chain = new Set(stack);
      chain.add(id);
      for (const dep of rec.def.manifest.dependencies ?? []) {
        if (!this.records.has(dep)) throw new Error(`依赖未注册: ${dep}`);
        await this.enableInternal(dep, chain);
        // enable 内部会隔离失败为 failed 状态，这里必须显式复查，
        // 否则「依赖初始化失败 / 循环依赖」会被误当作成功继续 setup。
        const depRec = this.records.get(dep);
        if (!depRec || depRec.state !== 'enabled') {
          throw new Error(`依赖 ${dep} 未成功启用（${depRec?.state ?? 'missing'} ${depRec?.error ?? ''}）`);
        }
        if (rec.epoch !== epoch || this.disposed) throw new Error('初始化期间被停用');
      }
      const base = this.api();
      const scoped = scopeAPI(base, rec.def.manifest.permissions);
      const ctx: PluginContext = {
        id,
        events: channel,
        services: this.services,
        api: scoped,
        log: (...args: unknown[]) => console.log(`[plugin:${id}]`, ...args),
        onDispose: (fn) => rec.teardown.push(fn),
      };
      const result = await rec.def.setup(ctx);
      if (rec.epoch !== epoch || this.disposed) {
        // 初始化期间被 disable / unload：清理，但不要覆盖 disabled 状态
        if (typeof result === 'function') rec.teardown.push(result);
        this.runTeardown(rec);
        channel.dispose();
        if (rec.channel === channel) rec.channel = undefined;
        return;
      }
      if (typeof result === 'function') rec.teardown.push(result);
      rec.state = 'enabled';
      rec.error = undefined;
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

  disable(id: string): void {
    const rec = this.records.get(id);
    // 从未启用的插件也要落到 disabled 终态（dispose 时统一收口）
    if (!rec || rec.state === 'disabled') return;
    // 使进行中的 setup 失效：它返回后只做清理，不会再写回 enabled
    rec.epoch++;
    this.runTeardown(rec);
    rec.channel?.dispose();
    rec.channel = undefined;
    rec.state = 'disabled';
    this.events.emit('plugin:disabled', { id });
  }

  /** 卸载：停用后从注册表移除，可再次注册同 id */
  unload(id: string): void {
    this.disable(id);
    this.records.delete(id);
  }

  list(): PluginRecord[] {
    return [...this.records.values()].map((r) => this.snapshot(r));
  }

  get(id: string): PluginRecord | undefined {
    const r = this.records.get(id);
    return r ? this.snapshot(r) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.records.keys()]) this.disable(id);
    // 保留注册表以便 service:ready / 调试面板在销毁后仍能查看最终状态
  }
}
