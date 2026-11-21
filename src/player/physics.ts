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

  const collide = (axis: 'x' | 'y' | 'z', delta: number) => {
    if (delta === 0) return;
    body.pos[axis] += delta;
    // 上界用 ceil-1：AABB 的最大边恰好落在整数格边界时，该格只是相切、并不重叠，
    // 不能算进碰撞（否则向下运动会把身体抬到上方方块的顶面）。
    const minX = Math.floor(body.pos.x - half);
    const maxX = Math.ceil(body.pos.x + half) - 1;
    const minY = Math.floor(body.pos.y);
    const maxY = Math.ceil(body.pos.y + body.height) - 1;
    const minZ = Math.floor(body.pos.z - half);
    const maxZ = Math.ceil(body.pos.z + half) - 1;
    const forward = delta > 0;
    // 收集同轴所有重叠方块，取移动方向上最近的阻挡面后再钳制。
    // 旧实现「第一个命中即 return」在高速斜向移动、AABB 同轴覆盖多个方块时可能钳制到
    // 较远的那个（遍历顺序而非最近距离），造成穿透或抖动；dt 已钳制到 0.05 故实际罕见，
    // 这里按最近距离选择以彻底消除该隐患。
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
    if (nearest === null) return;
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

  collide('x', body.vel.x * dt);
  collide('z', body.vel.z * dt);
  collide('y', body.vel.y * dt);
  return res;
}

/** 检查某 AABB 是否与实体方块相交（放置方块时防止卡在实体里） */
export function boxIntersectsBlock(
  pos: THREE.Vector3, width: number, height: number,
  bx: number, by: number, bz: number,
): boolean {
  const half = width / 2;
  return (
    pos.x + half > bx && pos.x - half < bx + 1 &&
    pos.y + height > by && pos.y < by + 1 &&
    pos.z + half > bz && pos.z - half < bz + 1
  );
}