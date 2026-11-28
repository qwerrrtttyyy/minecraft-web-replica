import type { Vec3Like } from '../core/types';

/**
 * 纯逻辑 AABB 脱困（不依赖 three / World，可直接跑 Node 回归）。
 *
 * 玩家 / 实体被方块挤住时（旧存档载入到新地形、爆炸推挤、异常传送到实体内、放置包围），
 * `moveBody` 的逐轴钳制只能阻止继续穿入，无法把已经嵌在实体里的身体推出来。
 * 这里用「最小贯穿量」搜索：枚举 6 个单轴推出 + 双轴/三轴组合，按位移长度升序，
 * 取第一个能让 AABB 完全脱离所有实体方块的位置；若无一次到位的候选，取最小位移
 * 迭代推进（有界），直到脱离或达到迭代上限。
 *
 * 判定谓词由调用方提供（只认「真实实心方块」，未生成区块视为空气），避免物理层
 * 「未加载区块当作实心」的护栏把玩家往错误方向推。
 */

export type SolidPredicate = (x: number, y: number, z: number) => boolean;

const EPS = 1e-3;

export interface PenetrationResult extends Vec3Like {
  moved: boolean;
  dx: number;
  dy: number;
  dz: number;
  /** 迭代轮数（诊断用） */
  iterations: number;
  /** 最终位置是否确实已脱离所有实心方块 */
  resolved: boolean;
}

/** 收集与 AABB 相交的实心方块坐标（扁平数组 [x,y,z, x,y,z, ...]） */
export function overlappingBlocks(pos: Vec3Like, width: number, height: number, isSolid: SolidPredicate): number[] {
  const half = width / 2;
  const minX = Math.floor(pos.x - half);
  const maxX = Math.floor(pos.x + half - EPS);
  const minY = Math.floor(pos.y);
  const maxY = Math.floor(pos.y + height - EPS);
  const minZ = Math.floor(pos.z - half);
  const maxZ = Math.floor(pos.z + half - EPS);
  const out: number[] = [];
  for (let by = minY; by <= maxY; by++) {
    for (let bz = minZ; bz <= maxZ; bz++) {
      for (let bx = minX; bx <= maxX; bx++) {
        if (isSolid(bx, by, bz)) out.push(bx, by, bz);
      }
    }
  }
  return out;
}

export function isStuck(pos: Vec3Like, width: number, height: number, isSolid: SolidPredicate): boolean {
  return overlappingBlocks(pos, width, height, isSolid).length > 0;
}

interface Candidate {
  dx: number;
  dy: number;
  dz: number;
  d2: number;
}

/** 由相交方块集合生成 26 个轴向推出候选（每轴取 0 / + / -） */
function candidates(blocks: number[], pos: Vec3Like, width: number, height: number): Candidate[] {
  const half = width / 2;
  let maxXPlus = -Infinity,
    minXMinus = Infinity;
  let maxYPlus = -Infinity,
    minYMinus = Infinity;
  let maxZPlus = -Infinity,
    minZMinus = Infinity;
  for (let i = 0; i < blocks.length; i += 3) {
    const bx = blocks[i],
      by = blocks[i + 1],
      bz = blocks[i + 2];
    if (bx + 1 > maxXPlus) maxXPlus = bx + 1;
    if (bx < minXMinus) minXMinus = bx;
    if (by + 1 > maxYPlus) maxYPlus = by + 1;
    if (by < minYMinus) minYMinus = by;
    if (bz + 1 > maxZPlus) maxZPlus = bz + 1;
    if (bz < minZMinus) minZMinus = bz;
  }
  // +X：身体 minX >= 所有方块右边界；-X：身体 maxX <= 所有方块左边界
  const xs = [0, maxXPlus + half + EPS - pos.x, minXMinus - half - EPS - pos.x];
  const ys = [0, maxYPlus + EPS - pos.y, minYMinus - height - EPS - pos.y];
  const zs = [0, maxZPlus + half + EPS - pos.z, minZMinus - half - EPS - pos.z];
  const out: Candidate[] = [];
  for (const dx of xs)
    for (const dy of ys)
      for (const dz of zs) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        out.push({ dx, dy, dz, d2: dx * dx + dy * dy + dz * dz });
      }
  out.sort((a, b) => a.d2 - b.d2);
  return out;
}

/**
 * 求出一个完全脱离实心方块的最近位置。不修改传入的 pos。
 * 有界：最多 maxIterations 轮、总位移不超过 maxDisplacement，避免病态地形下死循环。
 */
export function resolvePenetration(
  pos: Vec3Like,
  width: number,
  height: number,
  isSolid: SolidPredicate,
  maxIterations = 10,
  maxDisplacement = 128,
): PenetrationResult {
  const start = { x: pos.x, y: pos.y, z: pos.z };
  let x = pos.x,
    y = pos.y,
    z = pos.z;
  let iterations = 0;
  let travelled = 0;
  let blocks = overlappingBlocks(start, width, height, isSolid);

  while (blocks.length > 0 && iterations < maxIterations && travelled < maxDisplacement) {
    const cs = candidates(blocks, { x, y, z }, width, height);
    let chosen: Candidate | null = null;
    for (const c of cs) {
      const probe = { x: x + c.dx, y: y + c.dy, z: z + c.dz };
      if (overlappingBlocks(probe, width, height, isSolid).length === 0) {
        chosen = c;
        break;
      }
    }
    const step = chosen ?? cs[0];
    if (!step) break;
    x += step.dx;
    y += step.dy;
    z += step.dz;
    travelled += Math.sqrt(step.d2);
    iterations++;
    blocks = overlappingBlocks({ x, y, z }, width, height, isSolid);
  }

  return {
    x,
    y,
    z,
    dx: x - start.x,
    dy: y - start.y,
    dz: z - start.z,
    moved: iterations > 0,
    iterations,
    resolved: blocks.length === 0,
  };
}
