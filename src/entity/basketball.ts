import type { EntityManager, EntityType } from './entity';

/**
 * 篮球物理常量与纯逻辑。
 *
 * 刻意不依赖 three.js / DOM / World：既能被实体层复用，也能被测试快照
 * 直接 require 做纯逻辑回归。所有手感参数集中在此，实景试玩后一处微调即可。
 */
export const BALL = {
  /** 球半径：与实体宽高 0.5 对应，渲染时球心 = 脚底 + RADIUS */
  RADIUS: 0.25,
  /** 弹性系数（Q5）：反弹保留的竖直速度比例 */
  RESTITUTION: 0.7,
  /** 静止阈值：入射速度绝对值低于它则不再反弹，杜绝永久微抖 */
  REST_MIN_SPEED: 1.6,
  /** 水平滚动摩擦（指数衰减系数，与帧率无关） */
  FRICTION: 2.4,
  /** 重力加速度，与现有实体保持一致 */
  GRAVITY: 24,
  /** 终端下落速度 */
  TERMINAL: 40,
  /** 撞墙轻微反弹比例 */
  WALL_RESTITUTION: 0.35,
  /** 走近拾取：水平半径（主理人拍板的默认手感值） */
  PICKUP_RADIUS: 1.7,
  /** 走近拾取：球需近静止（总速度上限） */
  PICKUP_MAX_SPEED: 1.2,
  /** spawn 后延迟拾取，防「刚投出即被捡回」，单位秒 */
  PICKUP_COOLDOWN: 1.1,
  /** 投掷水平初速（R13 手感，主理人拍板） */
  THROW_SPEED: 14,
  /** 投掷上抛分量 */
  THROW_LIFT: 3,
  /** 拍打水平冲量 */
  PAT_SPEED: 9,
  /** 拍打上抛分量 */
  PAT_LIFT: 5.5,
  /** 拍打节流，单位秒 */
  PAT_COOLDOWN: 0.28,
} as const;

/**
 * 撞地反弹：impactVy 必须是 moveBody 之前的 vel.y（负值）。
 * moveBody 会把撞地轴的 vel.y 归零，读之后的值永远算不出反弹。
 * 能量低于阈值直接返回 0 —— 这是「不永久抖动」的关键。
 */
export function bounceVy(impactVy: number): number {
  if (impactVy > -BALL.REST_MIN_SPEED) return 0;
  return -impactVy * BALL.RESTITUTION;
}

/** 与帧率无关的滚动摩擦：连续两帧半步等价于一帧整步 */
export function rollFriction(v: number, dt: number): number {
  return v * Math.exp(-BALL.FRICTION * dt);
}

/** 走近拾取判定：冷却结束 + 近静止 + 水平/竖直距离都在范围内 */
export function canPickup(distXZ: number, distY: number, speed: number, cooldown: number): boolean {
  return cooldown <= 0 && speed <= BALL.PICKUP_MAX_SPEED &&
    distXZ <= BALL.PICKUP_RADIUS && distY >= -0.6 && distY <= 2.2;
}

/**
 * 注册篮球实体类型。
 * build 由调用方（models.ts）传入，本模块便无需运行时依赖 three.js，
 * 测试快照 require 本文件时不会连带加载渲染层。
 */
export function registerBasketball(
  entities: Pick<EntityManager, 'registerType'>,
  build: EntityType['build'],
): void {
  entities.registerType({
    id: 'basketball',
    label: '篮球',
    width: 0.5,
    height: 0.5,
    speed: 0,
    physics: 'bounce',
    health: Infinity,
    build,
  });
}
