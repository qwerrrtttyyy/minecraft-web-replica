/**
 * 插件载体契约（v1.6.0）。
 *
 * 载体（carrier）回答「插件的实现体是什么」：
 *  - `js`：默认，实现体是 `setup(ctx)` 函数（v1.2.0~v1.5.0 的唯一形态，零改动兼容）。
 *  - `wasm:module`：纯计算 WASM 模块（零 import），作为插件私有数值模块注册到 WASM 运行时，
 *    只能被被动调用，适合数学 / 编解码 / 哈希等确定性计算。
 *  - `wasm:host`：完整宿主导入插件（受控白名单 import），可主动读世界、订阅游戏事件、
 *    注册扩展点、读写插件存储，与 JS 插件在扩展能力上对等。
 *
 * 三种载体统一由 PluginService 管理：manifest 校验 / semver 依赖 / 权限裁剪 / 生命周期 /
 * 代次保护 / 命名空间存储全部复用，载体只负责提供「激活函数 + 清理函数」。
 */
import type { PluginContext } from '../PluginContext';
import type { ExtensionRegistry } from '../extensions';

/** 载体内省信息，写进 PluginRecord 供诊断与能力发现 */
export interface CarrierInfo {
  kind: PluginCarrierKind;
  /** wasm 载体的字节数 / ABI / 校验和 */
  bytes?: number;
  abi?: number;
  checksum?: string;
  /** wasm:host 声明并实际注入的宿主能力名 */
  hostImports?: string[];
}

export type PluginCarrierKind = 'js' | 'wasm:module' | 'wasm:host';

/** 统一二进制输入：base64 字符串 / Uint8Array / ArrayBuffer */
export type WasmBytes = string | Uint8Array | ArrayBuffer;

/** 纯计算模块载体：零 import，注册为插件私有 WASM 模块 */
export interface WasmModuleCarrier {
  kind: 'wasm:module';
  bytes: WasmBytes;
  /** 注册进 WASM 运行时的模块 id；默认取插件 id */
  moduleId?: string;
}

/** 宿主导入载体：受控白名单 import + 统一导出钩子 */
export interface WasmHostCarrier {
  kind: 'wasm:host';
  bytes: WasmBytes;
  /**
   * 声明期望使用的宿主能力名（hostABI 白名单子集）。
   * 声明但权限不足的能力由「抛错桩」占位（加载不失败，调用才报错）；
   * 未声明的 import 名字同样以抛错桩占位，便于插件降级加载。
   */
  hostImports?: string[];
  /** 模块 ABI 版本，当前 1；不匹配拒绝激活 */
  abi?: number;
}

export type PluginCarrier = WasmModuleCarrier | WasmHostCarrier;

/** 载体激活结果：交给 PluginService 作为 teardown 的一部分 */
export interface CarrierActivation {
  /** 停用钩子（顺序与注册相反） */
  teardown: () => void;
  /** 内省信息 */
  info: CarrierInfo;
}

/** 传给载体适配器的宿主依赖（组装根注入，测试可替身） */
export interface CarrierHost {
  extensions: ExtensionRegistry;
  /** 由 PluginService 提供：把 wasm 模块注册到运行时 */
  registerModule(id: string, bytes: WasmBytes): { bytes: number; checksum: string };
  unregisterModule(id: string): boolean;
  /** 调用运行时内置内核导出（受插件权限裁剪由 scopeAPI 保证，这里传已裁剪的函数） */
  callKernel(name: string, args: number[]): number;
}

/** 载体适配器签名 */
export type CarrierAdapter = (
  carrier: PluginCarrier,
  ctx: PluginContext,
  host: CarrierHost,
) => CarrierActivation;
