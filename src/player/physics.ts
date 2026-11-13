import * as THREE from 'three';
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
    const minX = Math.floor(body.pos.x - half);
    const maxX = Math.floor(body.pos.x + half);
    const minY = Math.floor(body.pos.y);
    const maxY = Math.floor(body.pos.y + body.height);
    const minZ = Math.floor(body.pos.z - half);
    const maxZ = Math.floor(body.pos.z + half);
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!world.isSolidAt(x, y, z)) continue;
          if (axis === 'x') {
            body.pos.x = delta > 0 ? x - half - EPS : x + 1 + half + EPS;
            body.vel.x = 0;
            res.hitX = true;
          } else if (axis === 'z') {
            body.pos.z = delta > 0 ? z - half - EPS : z + 1 + half + EPS;
            body.vel.z = 0;
            res.hitZ = true;
          } else {
            if (delta > 0) {
              body.pos.y = y - body.height - EPS;
              res.hitHead = true;
            } else {
              body.pos.y = y + 1 + EPS;
              body.onGround = true;
              if (!wasGround && body.vel.y < -8) res.landed = true;
            }
            body.vel.y = 0;
          }
          return;
        }
      }
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