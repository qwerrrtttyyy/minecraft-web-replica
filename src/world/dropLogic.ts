/**
 * 可见掉落物的纯判定逻辑（无 three / DOM，可编译进快照测试）。
 *
 * 全部随机性来自 dropHash(seed, source, index)，不引入 Math.random；
 * 散开 / 拾取 / 合并 / 消失 / 入水都只回答「能不能 / 多少」，渲染与生命周期
 * 交给 entity/droppedItem.ts。
 */
import { DROPS } from '../core/tuning';
import { dropHash } from './drops';

export interface DropPoint {
  x: number;
  y: number;
  z: number;
}

export interface DropProbe extends DropPoint {
  age: number;
}

export interface MergeProbe extends DropPoint {
  name: string;
  count: number;
}

export interface WaterVelocity {
  vx: number;
  vy: number;
  vz: number;
}

export interface ScatterOffset extends WaterVelocity {
  dx: number;
  dz: number;
}

/** 把 uint32 哈希归一到 [0,1) */
const unit = (h: number) => h / 4294967296;

/**
 * 确定性散开：同 seed + source + index 永远得到同一组偏移与弹出初速。
 * dx/dz 是单位圆内偏移（乘 DROPS.scatter 得坐标偏移），vx/vz 同向作为水平初速，
 * vy 是向上的弹出系数（0.7~1，乘 DROPS.popSpeed）。
 */
export function scatterOffset(seed: number, source: string, index: number): ScatterOffset {
  const h1 = dropHash(seed, source, index * 3);
  const h2 = dropHash(seed, source, index * 3 + 1);
  const h3 = dropHash(seed, source, index * 3 + 2);
  const angle = unit(h1) * Math.PI * 2;
  const radius = Math.sqrt(unit(h2)); // sqrt 让偏移在圆盘内均匀分布
  const dx = Math.cos(angle) * radius;
  const dz = Math.sin(angle) * radius;
  return {
    dx, dz,
    vx: dx,
    vy: 0.7 + unit(h3) * 0.3,
    vz: dz,
  };
}

/** 拾取判定：三维距离不超过 pickupRadius，且 age 已过 pickupDelay */
export function canPickup(drop: DropProbe, playerPos: DropPoint): boolean {
  if (drop.age < DROPS.pickupDelay) return false;
  const dx = drop.x - playerPos.x;
  const dy = drop.y - playerPos.y;
  const dz = drop.z - playerPos.z;
  return dx * dx + dy * dy + dz * dz <= DROPS.pickupRadius * DROPS.pickupRadius;
}

/**
 * 合并键只由材料标识决定，与数量无关。
 * 材料标识一律是方块名 / item:xxx 的统一串，因此同类才能堆叠。
 */
export function mergeKey(name: string, _count: number): string {
  return name;
}

/** 同材料且三维距离不超过 mergeRadius 才合并 */
export function dropsMerge(a: MergeProbe, b: MergeProbe): boolean {
  if (mergeKey(a.name, a.count) !== mergeKey(b.name, b.count)) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz <= DROPS.mergeRadius * DROPS.mergeRadius;
}

/** 超时或掉出世界（y<0）即消失 */
export function shouldDespawn(drop: { age: number; y: number }): boolean {
  return drop.age >= DROPS.lifetime || drop.y < 0;
}

/**
 * 水中运动：入水时垂直速度锁定为 -waterSink（终端下沉），水平速度按 exp(-8*dt)
 * 指数衰减；出水则交回重力 vy -= 24*dt，不在此 clamp —— 落地由 moveBody 处理。
 */
export function advanceWater(vel: WaterVelocity, dt: number, inWater: boolean): WaterVelocity {
  if (inWater) {
    const damp = Math.exp(-8 * dt);
    return { vx: vel.vx * damp, vy: -DROPS.waterSink, vz: vel.vz * damp };
  }
  return { vx: vel.vx, vy: vel.vy - 24 * dt, vz: vel.vz };
}
