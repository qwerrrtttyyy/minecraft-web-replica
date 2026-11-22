import type { Node } from './Node';

/**
 * AI 层开放类型基座（纯类型 + 纯守卫，零运行时依赖）。
 *
 * 设计约束：
 * 1. 数据驱动优先 —— nodeType 自由注册，绝不写成穷举联合；
 * 2. unknown 优先于 any —— 所有来自 JSON / 插件的动态值先收窄再使用；
 * 3. 双形态兼容 —— 节点构造同时接受「对象 config」与「历史位置参数」；
 * 4. 守卫集中 —— num/str/vec3 等统一带 fallback，避免各节点各写一套 cast。
 */

/** 节点 config 统一入口：JSON 对象、历史位置参数、插件自定义对象都能装进来。 */
export type NodeConfig = unknown;

/** 三维坐标的最小结构（兼容 THREE.Vector3 与普通 JSON 对象）。 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 判断是否为普通记录对象（排除 null 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 有限数字守卫；非法值回退到 fallback。 */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 字符串守卫；非法值回退到 fallback。 */
export function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 可选数字守卫：合法返回数值，缺失或非法返回 undefined（保留「未配置」语义）。 */
export function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 布尔守卫；非法值回退到 fallback。 */
export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 三维向量守卫：逐分量 num(x/y/z, 0)，非记录对象整体回退。 */
export function vec3(value: unknown, fallback: Vec3Like): Vec3Like {
  if (!isRecord(value)) return fallback;
  return {
    x: num(value.x, 0),
    y: num(value.y, 0),
    z: num(value.z, 0),
  };
}

/** 从 config 读取原始字段；记录对象且键存在时返回值，否则返回 fallback。 */
export function cfgUnknown(config: NodeConfig, key: string, fallback: unknown): unknown {
  return isRecord(config) && key in config ? config[key] : fallback;
}

/** cfgUnknown 的数字版本。 */
export function cfgNum(config: NodeConfig, key: string, fallback: number): number {
  return num(cfgUnknown(config, key, fallback), fallback);
}

/** cfgUnknown 的字符串版本。 */
export function cfgStr(config: NodeConfig, key: string, fallback: string): string {
  return str(cfgUnknown(config, key, fallback), fallback);
}

/** cfgUnknown 的布尔版本。 */
export function cfgBool(config: NodeConfig, key: string, fallback: boolean): boolean {
  return bool(cfgUnknown(config, key, fallback), fallback);
}

/** cfgUnknown 的可选数字版本（未配置时保持 undefined）。 */
export function cfgOptNum(config: NodeConfig, key: string): number | undefined {
  return optNum(cfgUnknown(config, key, undefined));
}

/** cfgUnknown 的三维向量版本。 */
export function cfgVec3(config: NodeConfig, key: string, fallback: Vec3Like): Vec3Like {
  return vec3(cfgUnknown(config, key, fallback), fallback);
}

/** cfgUnknown 的数字数组版本；逐元素守卫，非法元素按 0 处理。 */
export function cfgNumArray(config: NodeConfig, key: string, fallback: readonly number[]): number[] {
  const raw = cfgUnknown(config, key, fallback);
  if (!Array.isArray(raw)) return [...fallback];
  return raw.map((item) => num(item, 0));
}

/**
 * 受限 API 视图：只列节点实际用到的副作用入口，全部可选。
 * 权限裁剪后方法可能不存在，节点一律用可选链调用，自然降级为无副作用。
 */
export interface AIApiView {
  spawnEntity?(typeId: string, offset: Vec3Like, chance: number): unknown;
  breakBlock?(x: number, y: number, z: number): unknown;
  placeBlock?(x: number, y: number, z: number, blockId: number): unknown;
  playSound?(sound: string, volume: number): unknown;
}

const API_METHOD_NAMES = ['spawnEntity', 'breakBlock', 'placeBlock', 'playSound'] as const;

/**
 * API 视图守卫：任意记录对象都可作为视图；若声明了副作用方法，则必须是函数。
 * 这样既保留 CraftAPI 的开放扩展位，又避免把错误类型的方法带进 tick。
 */
export function isAIApiView(value: unknown): value is AIApiView {
  if (!isRecord(value)) return false;
  return API_METHOD_NAMES.every((name) => {
    const method = value[name];
    return method === undefined || typeof method === 'function';
  });
}

/**
 * 事件出口：与 GameEvents 的安全子集对齐，payload 用 unknown。
 * 这里用非泛型签名而非 `<K extends string>`：真实 EventService 的 emit 受
 * `K extends keyof GameEvents` 约束，非泛型目标才能被结构兼容地传入，
 * 同时仍允许节点以任意字符串事件名 + unknown payload 派发。
 */
export interface GameEventSink {
  emit(type: string, payload: unknown): void;
}

/**
 * 行为树 JSON 的递归开放结构。
 * - 内置控制/装饰器节点靠 type 分派；
 * - condition/action 靠 nodeType 交由 NodeRegistry 工厂，特有字段走索引签名；
 * - children 声明为 readonly 数组，兼容 behaviors.ts 的 `as const` 元组与 JSON 数组；
 * - 不写穷举联合，插件自定义 nodeType 天然可注入。
 */
export interface BehaviorNodeJSON {
  type: string;
  name?: string;
  nodeType?: string;
  children?: readonly BehaviorNodeJSON[];
  child?: BehaviorNodeJSON;
  [key: string]: unknown;
}

/** 行为树配置根节点。 */
export interface BehaviorTreeJSON {
  root: BehaviorNodeJSON;
}

/**
 * 节点构造签名。
 * 首参用 never 是为了让任意「带具体 config 类型」的插件构造签名都能注册进来
 * （never 可赋给任何参数类型）；实际调用在 NodeRegistry.create 内以 unknown 传入，
 * 由各节点自身的 isRecord / cfg* 守卫收窄，运行时行为与重构前一致。
 */
export type NodeCtor = new (config: never) => Node;
