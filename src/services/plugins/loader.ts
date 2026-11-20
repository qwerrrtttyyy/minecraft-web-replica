/**
 * 从源码安装插件（v1.5.0）。
 *
 * ⚠️ 安全边界：new Function 等价于 eval，插件源码能访问全局对象。本加载器**只接受
 * 调用方显式传入的字符串**，不会自动 fetch 远程地址，也不提供 require / import。
 * 仅用于加载你自己信任的插件源码（浏览器控制台、本地片段、已审计的清单）。
 * 恶意 / 未知来源的源码请改用手动 CraftAPI.plugins.register。
 *
 * 源码约定为 UMD 风格：写入 module.exports（或 module.exports.default）一个
 * PluginDefinition；加载器只做静态校验，真正的权限 / 依赖 / API 版本校验由
 * PluginService.register 统一执行。
 */
import type { PluginDefinition, PluginPermission } from './PluginContext';

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

export interface PluginSourceOptions {
  /** 源码体积上限，默认 64KB */
  maxBytes?: number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;
const VALID_PERMISSIONS: ReadonlySet<string> = new Set<PluginPermission>([
  'world:write', 'player:write', 'save:write', 'api:emit',
  'blocks:register', 'botany:register', 'wasm:use', 'plugins:manage',
]);

export function loadPluginDefinition(
  source: string,
  options: PluginSourceOptions = {},
): PluginDefinition {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (typeof source !== 'string' || source.length === 0) {
    throw new PluginLoadError('插件源码为空');
  }
  if (source.length > maxBytes) {
    throw new PluginLoadError(`插件源码 ${source.length} 字节超过上限 ${maxBytes}`);
  }
  let module: { exports: Record<string, unknown> };
  try {
    const fn = new Function('module', 'exports', `"use strict";\n${source}`) as
      unknown as (m: unknown, e: unknown) => void;
    module = { exports: {} };
    fn(module, module.exports);
  } catch (e) {
    throw new PluginLoadError(`插件源码执行失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const candidate: unknown = module.exports.default ?? module.exports;
  if (!candidate || typeof candidate !== 'object') {
    throw new PluginLoadError('源码未导出 PluginDefinition（应写入 module.exports）');
  }
  const def = candidate as PluginDefinition;
  const manifest = def.manifest;
  if (!manifest || typeof manifest !== 'object') throw new PluginLoadError('缺少 manifest');
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    throw new PluginLoadError(`非法插件 id: ${String(manifest.id)}`);
  }
  if (typeof def.setup !== 'function') throw new PluginLoadError('缺少 setup(ctx) 函数');
  const permissions = manifest.permissions;
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) throw new PluginLoadError('manifest.permissions 必须是数组');
    for (const p of permissions) {
      if (typeof p !== 'string' || !VALID_PERMISSIONS.has(p)) {
        throw new PluginLoadError(`未知权限: ${String(p)}`);
      }
    }
  }
  // 冻结 manifest，防止插件在 setup 内追加权限后绕过 scopeAPI
  Object.freeze(manifest);
  return def;
}
