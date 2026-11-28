/**
 * 载体适配器（v1.6.0）—— 把 WASM 载体统一成 PluginService 认识的标准生命周期。
 *
 * 关键复用：PluginService 完全不知道载体是什么，它只调用 `def.setup(ctx)` 并期待
 * 返回 teardown。本模块把 wasm:module / wasm:host 都包装成一个 setup，于是依赖解析、
 * 权限裁剪、代次保护、超时、命名空间存储全部自动生效，零重复实现。
 *
 * 纯逻辑（WebAssembly + TextEncoder 均为标准 API，无 DOM），进入快照供 Node 回归。
 */

import { decodeBase64, fnv1a } from '../../../wasm/protocol';
import type { PluginContext } from '../PluginContext';
import {
  assertWhitelistedImports,
  denyImport,
  EVENT_TO_POINT,
  HOST_MODULE,
  HOST_PLUGIN_ABI,
  POINT_KINDS,
  payloadNumbers,
  planGrants,
  readUtf8,
  writeUtf8,
} from './hostABI';
import type {
  CarrierActivation,
  CarrierHost,
  CarrierInfo,
  WasmBytes,
  WasmHostCarrier,
  WasmModuleCarrier,
} from './types';

const toBytes = (input: WasmBytes): Uint8Array<ArrayBuffer> => {
  if (typeof input === 'string') {
    const decoded = decodeBase64(input);
    return new Uint8Array(decoded.buffer as ArrayBuffer, decoded.byteOffset, decoded.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
};

/** wasm:module：零 import 纯计算模块，注册为插件私有 WASM 模块 */
export function activateModuleCarrier(
  carrier: WasmModuleCarrier,
  ctx: PluginContext,
  host: CarrierHost,
): CarrierActivation {
  const bytes = toBytes(carrier.bytes);
  const id = carrier.moduleId ?? ctx.id;
  const info = host.registerModule(id, bytes);
  return {
    info: { kind: 'wasm:module', bytes: info.bytes, checksum: info.checksum },
    teardown: () => {
      host.unregisterModule(id);
    },
  };
}

interface HostExports {
  memory: WebAssembly.Memory;
  mc_plugin_abi(): number;
  mc_hook?(kind: number, a: number, b: number, c: number, d: number): void;
  mc_scratch_ptr?(): number;
  mc_scratch_size?(): number;
  _start?(): void;
  _dispose?(): void;
}

/**
 * wasm:host：受控宿主导入插件。
 *
 * 流程：编译 → import 白名单校验 → 按声明与权限生成 importObject（缺权 / 未声明用抛错桩）
 * → 实例化 → ABI/导出校验 → 注册扩展点钩子 → _start() → 返回 teardown。
 *
 * 任何一步失败都抛错，PluginService 会把插件隔离为 failed（不拖垮启动）。
 */
export function activateHostCarrier(
  carrier: WasmHostCarrier,
  ctx: PluginContext,
  host: CarrierHost,
): CarrierActivation {
  const bytes = toBytes(carrier.bytes);
  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`[wasm-host] 编译失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const imports = WebAssembly.Module.imports(mod);
  assertWhitelistedImports(imports);

  const grants = planGrants(carrier.hostImports, ctx.manifest.permissions ?? []);
  const grantedNames = grants.filter((g) => g.granted).map((g) => g.name);

  // 插件状态与清理钩子（闭包内持有，实例销毁后一并释放）
  const offs: (() => void)[] = [];
  const subscriptions: (() => void)[] = [];
  const scope = ctx.api;
  let instance: WebAssembly.Instance | null = null;
  let ex: HostExports | null = null;
  let disposed = false;

  // 确定性 PRNG：以插件 id 的 FNV 校验和播种，避免 Math.random 破坏可复现性
  let rngState = (parseInt(fnv1a(new TextEncoder().encode(ctx.id)), 16) || 1) >>> 0;
  const rand = (): number => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const env: Record<string, (...args: number[]) => number | void> = {};
  for (const grant of grants) {
    env[grant.name] = grant.granted
      ? stubFor(grant.name)
      : (denyImport(grant.name, grant) as (...args: number[]) => number | void);
  }

  function requireEx(): HostExports {
    if (!ex || !instance) throw new Error('[wasm-host] 实例尚未就绪');
    return ex;
  }

  function stubFor(name: string): (...args: number[]) => number | void {
    switch (name) {
      case 'mc_log':
        return (ptr, len) => {
          ctx.log(readUtf8(requireEx().memory, ptr, len));
        };
      case 'mc_now':
        return () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
      case 'mc_rand':
        return rand;
      case 'mc_world_seed':
        return () => scope.world.seed();
      case 'mc_world_get':
        return (x, y, z) => scope.world.getBlock(x, y, z);
      case 'mc_world_height':
        return (x, z) => scope.world.surfaceHeight(x, z);
      case 'mc_world_set':
        return (x, y, z, id) => {
          scope.world.setBlock(x, y, z, id);
        };
      case 'mc_wasm_call':
        return (ptr, len, a = 0, b = 0, c = 0) => {
          const fn = readUtf8(requireEx().memory, ptr, len);
          return scope.wasm.call(fn, a, b, c);
        };
      case 'mc_ext_register': {
        const registered = new Set<string>();
        return (ptr, len) => {
          const point = readUtf8(requireEx().memory, ptr, len);
          const kind = POINT_KINDS[point];
          if (kind === undefined) throw new Error(`[wasm-host] 未知扩展点: ${point}`);
          if (registered.has(point)) return kind; // 幂等
          registered.add(point);
          const sourceEvent = Object.keys(EVENT_TO_POINT).find((ev) => EVENT_TO_POINT[ev] === point);
          if (sourceEvent && !(ctx.manifest.permissions ?? []).includes('events:subscribe')) {
            throw new Error('[wasm-host] 订阅游戏事件需声明 events:subscribe 权限');
          }
          const fire = (payload: unknown): void => {
            if (disposed) return;
            const hook = requireEx().mc_hook;
            if (typeof hook !== 'function') return;
            const [a, b, c, d] = payloadNumbers(point, payload);
            hook(kind, a, b, c, d);
          };
          // 扩展点直接注册；游戏事件则桥接到 ctx.events（命名空间通道，卸载自动撤销）
          if (sourceEvent) {
            const off = ctx.events.on(sourceEvent as never, fire as never);
            subscriptions.push(off);
          } else {
            const off = host.extensions.register(point, ctx.id, fire);
            offs.push(off);
          }
          return kind;
        };
      }
      case 'mc_storage_get': {
        return (keyPtr, keyLen, outPtr, outCap) => {
          const key = readUtf8(requireEx().memory, keyPtr, keyLen);
          const value = ctx.storage.get<unknown>(key);
          const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
          return writeUtf8(requireEx().memory, outPtr, outCap, text);
        };
      }
      case 'mc_storage_set': {
        return (keyPtr, keyLen, valPtr, valLen) => {
          const key = readUtf8(requireEx().memory, keyPtr, keyLen);
          const text = readUtf8(requireEx().memory, valPtr, valLen);
          ctx.storage.set(key, text);
        };
      }
      default:
        throw new Error(`[wasm-host] 未实现的宿主导入 ${name}`);
    }
  }

  try {
    instance = new WebAssembly.Instance(mod, { [HOST_MODULE]: env });
    const raw = instance.exports as unknown as HostExports;
    if (!(raw.memory instanceof WebAssembly.Memory)) {
      throw new Error('[wasm-host] 缺少 memory 导出');
    }
    if (typeof raw.mc_plugin_abi !== 'function') {
      throw new Error('[wasm-host] 缺少 mc_plugin_abi 导出');
    }
    if (carrier.abi !== undefined && carrier.abi !== HOST_PLUGIN_ABI) {
      throw new Error(`[wasm-host] 声明 ABI ${carrier.abi}，期望 ${HOST_PLUGIN_ABI}`);
    }
    const actualAbi = raw.mc_plugin_abi();
    if (actualAbi !== HOST_PLUGIN_ABI) {
      throw new Error(`[wasm-host] 内核 ABI ${actualAbi}，期望 ${HOST_PLUGIN_ABI}`);
    }
    ex = raw;
    if (typeof raw._start === 'function') raw._start();
  } catch (e) {
    // 激活失败：撤销已建立的订阅，避免半成品残留
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    for (const off of subscriptions.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }

  const info: CarrierInfo = {
    kind: 'wasm:host',
    bytes: bytes.length,
    abi: HOST_PLUGIN_ABI,
    checksum: fnv1a(bytes),
    hostImports: grantedNames,
  };

  return {
    info,
    teardown: () => {
      if (disposed) return;
      disposed = true;
      for (const off of subscriptions.splice(0).reverse()) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const off of offs.splice(0).reverse()) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      host.extensions.unregisterOwner(ctx.id);
      try {
        ex?._dispose?.();
      } catch (e) {
        console.error(`[wasm-host] ${ctx.id} _dispose 失败`, e);
      }
      instance = null;
      ex = null;
    },
  };
}

export type { CarrierActivation, CarrierHost, PluginCarrier } from './types';
