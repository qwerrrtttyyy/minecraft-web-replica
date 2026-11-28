import type * as THREE from 'three';
import type { World } from '../world/world';

/**
 * 共享 AABB 体素物理：玩家与所有实体共用。
 * 逐轴积分 + 碰撞钳制，稳定且无穿墙。
 */
export interface PhysicsBody {
  /** 脚底中心位置 */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** 碰撞盒宽度（x/z 相同） */
  width: number;
  height: number;
  onGround: boolean;
}

export interface MoveResult {
  hitX: boolean;
  hitZ: boolean;
  hitHead: boolean;
  landed: boolean;
}

const EPS = 1e-4;

export function moveBody(world: World, body: PhysicsBody, dt: number): MoveResult {
  const res: MoveResult = { hitX: false, hitZ: false, hitHead: false, landed: false };
  const wasGround = body.onGround;
  body.onGround = false;
  const half = body.width / 2;

  const aabbCells = () => ({
    minX: Math.floor(body.pos.x - half),
    // 上界用 ceil-1：AABB 最大边恰好落在整数格边界时只是相切、并不重叠，
    // 不能计入碰撞，否则向下运动会被错误抬升到上方方块顶面。
    maxX: Math.ceil(body.pos.x + half) - 1,
    minY: Math.floor(body.pos.y),
    maxY: Math.ceil(body.pos.y + body.height) - 1,
    minZ: Math.floor(body.pos.z - half),
    maxZ: Math.ceil(body.pos.z + half) - 1,
  });

  /** 沿某轴取移动方向上最近的阻挡面坐标；无重叠返回 null */
  const nearestBlocking = (axis: 'x' | 'y' | 'z', forward: boolean): number | null => {
    const { minX, maxX, minY, maxY, minZ, maxZ } = aabbCells();
    let nearest: number | null = null;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!world.isSolidAt(x, y, z)) continue;
          const c = axis === 'x' ? x : axis === 'z' ? z : y;
          if (nearest === null || (forward ? c < nearest : c > nearest)) nearest = c;
        }
      }
    }
    return nearest;
  };

  const clampAxis = (axis: 'x' | 'y' | 'z', forward: boolean, nearest: number) => {
    if (axis === 'x') {
      body.pos.x = forward ? nearest - half - EPS : nearest + 1 + half + EPS;
      body.vel.x = 0;
      res.hitX = true;
    } else if (axis === 'z') {
      body.pos.z = forward ? nearest - half - EPS : nearest + 1 + half + EPS;
      body.vel.z = 0;
      res.hitZ = true;
    } else {
      if (forward) {
        body.pos.y = nearest - body.height - EPS;
        res.hitHead = true;
      } else {
        body.pos.y = nearest + 1 + EPS;
        body.onGround = true;
        if (!wasGround && body.vel.y < -8) res.landed = true;
      }
      body.vel.y = 0;
    }
  };

  const collide = (axis: 'x' | 'y' | 'z', delta: number) => {
    if (delta !== 0) {
      // H08：子步扫掠——单步位移不超过半格，高速不再穿透 1 格薄地板 / 薄墙，
      // 也不再「一步跨进方块内部后钳到错误的面」
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.5));
      const step = delta / steps;
      for (let i = 0; i < steps; i++) {
        body.pos[axis] += step;
        const nearest = nearestBlocking(axis, step > 0);
        if (nearest !== null) {
          clampAxis(axis, step > 0, nearest);
          break; // 已贴合，本轴不再前进
        }
      }
      return;
    }
    // H08：去嵌入——delta===0（被嵌住的轴）也要解算：沿该轴取位移更小的
    // 退出面把身体推出去，不再因早退「永不解算」（表现为贴墙上爬 / 卡死）
    const { minX, maxX, minY, maxY, minZ, maxZ } = aabbCells();
    let best: { pos: number; dist: number } | null = null;
    const consider = (candidate: number) => {
      const dist = Math.abs(candidate - body.pos[axis]);
      if (best === null || dist < best.dist) best = { pos: candidate, dist };
    };
    let overlapping = false;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!world.isSolidAt(x, y, z)) continue;
          const c = axis === 'x' ? x : axis === 'z' ? z : y;
          if (axis === 'y') {
            consider(c - body.height - EPS); // 从方块顶面上方退出
            consider(c + 1 + EPS); // 从方块底面下方退出
          } else {
            consider(c - half - EPS); // 从方块 -面退出
            consider(c + 1 + half + EPS); // 从方块 +面退出
          }
          overlapping = true;
        }
      }
    }
    if (overlapping && best) {
      const target = (best as { pos: number }).pos;
      const forward = target < body.pos[axis];
      const nearest = nearestBlocking(axis, forward);
      if (nearest !== null) clampAxis(axis, forward, nearest);
      else body.pos[axis] = target;
    }
  };

  collide('x', body.vel.x * dt);
  collide('z', body.vel.z * dt);
  collide('y', body.vel.y * dt);
  return res;
}

/** 检查某 AABB 是否与实体方块相交（放置方块时防止卡在实体里） */
export function boxIntersectsBlock(
  pos: THREE.Vector3,
  width: number,
  height: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const half = width / 2;
  return (
    pos.x + half > bx &&
    pos.x - half < bx + 1 &&
    pos.y + height > by &&
    pos.y < by + 1 &&
    pos.z + half > bz &&
    pos.z - half < bz + 1
  );
}
