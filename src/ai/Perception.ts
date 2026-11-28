import { WORLD_HEIGHT } from '../core/types';
import { TickContext } from './Node';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WorldView {
  getBlock(x: number, y: number, z: number): number;
  isSolidAt(x: number, y: number, z: number): boolean;
  surfaceHeight(x: number, z: number): number;
}

/** 只读感知视图：封装世界与附近实体查询，供条件/动作节点使用，不修改世界。 */
export class Perception {
  constructor(
    private readonly world: WorldView,
    private readonly entities: ReadonlyArray<{ id: number; pos: Vec3 }> = [],
  ) {}

  distance(a: { pos: Vec3 }, b: { pos: Vec3 }): number {
    return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
  }

  getNearby(
    entity: { id: number; pos: Vec3 },
    radius: number,
    typeFilter?: (e: { id: number; pos: Vec3 }) => boolean,
  ): ReadonlyArray<{ id: number; pos: Vec3 }> {
    return this.entities.filter(
      (e) => e.id !== entity.id && this.distance(entity, e) <= radius && (!typeFilter || typeFilter(e)),
    );
  }

  /** 线段采样判定两点间是否有固体方块遮挡。 */
  canSee(entity: { pos: Vec3 }, target: { pos: Vec3 }, maxDist: number): boolean {
    const d = this.distance(entity, target);
    if (d > maxDist) return false;
    const steps = Math.ceil(d / 0.5);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = entity.pos.x + (target.pos.x - entity.pos.x) * t;
      const y = entity.pos.y + (target.pos.y - entity.pos.y) * t;
      const z = entity.pos.z + (target.pos.z - entity.pos.z) * t;
      if (this.world.isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z))) return false;
    }
    return true;
  }

  isInWater(entity: { pos: Vec3 }, liquidBlockIds: number[] = []): boolean {
    const { x, y, z } = entity.pos;
    return liquidBlockIds.includes(this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  /** 实体正上方直到天空顶无固体方块即视为在天空下。 */
  isUnderSky(entity: { pos: Vec3 }): boolean {
    const { x, y, z } = entity.pos;
    for (let yy = Math.floor(y) + 1; yy < WORLD_HEIGHT; yy++) {
      if (this.world.isSolidAt(Math.floor(x), yy, Math.floor(z))) return false;
    }
    return true;
  }

  /** 8×8×8 贪婪扩展（BFS，步数上限），判定能否到达目标格。 */
  canReach(entity: { pos: Vec3 }, targetX: number, targetY: number, targetZ: number, maxSteps = 64): boolean {
    const start = { x: Math.floor(entity.pos.x), y: Math.floor(entity.pos.y), z: Math.floor(entity.pos.z) };
    const goal = { x: Math.floor(targetX), y: Math.floor(targetY), z: Math.floor(targetZ) };
    const visited = new Set<string>();
    const queue: Array<{ x: number; y: number; z: number; steps: number }> = [{ ...start, steps: 0 }];
    visited.add(`${start.x},${start.y},${start.z}`);
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur.x === goal.x && cur.y === goal.y && cur.z === goal.z) return true;
      if (cur.steps >= maxSteps) continue;
      for (const [dx, dy, dz] of dirs) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nz = cur.z + dz;
        const key = `${nx},${ny},${nz}`;
        if (visited.has(key)) continue;
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (this.world.isSolidAt(nx, ny, nz)) continue;
        visited.add(key);
        queue.push({ x: nx, y: ny, z: nz, steps: cur.steps + 1 });
      }
    }
    return false;
  }
}
