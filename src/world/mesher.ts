import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import type { BlockRegistry, BlockDefinition } from './blocks';
import { AIR } from './blocks';
import { FACES, AO_LEVELS } from './faces';
import type { World } from './world';
import type { TextureAtlas } from '../gfx/atlas';

/**
 * 区块网格生成：隐藏面剔除 + 逐顶点环境光遮蔽（AO）+ 面定向明暗。
 * 三个渲染通道：不透明（含镂空植物）/ 自发光 / 半透明（水、玻璃）。
 */

export interface GeoArrays {
  positions: number[];
  uvs: number[];
  colors: number[];
  /** 每顶点 2 个数：天空光 / 方块光（0~1） */
  lights: number[];
  indices: number[];
}

export interface ChunkMeshData {
  opaque: GeoArrays | null;
  emissive: GeoArrays | null;
  transparent: GeoArrays | null;
  water: GeoArrays | null;
}

const newGeo = (): GeoArrays => ({ positions: [], uvs: [], colors: [], lights: [], indices: [] });
const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;

export function meshChunk(world: World, atlas: TextureAtlas, cx: number, cz: number): ChunkMeshData {
  const reg = world.registry;
  const chunk = world.getChunk(cx, cz);
  const out: ChunkMeshData = { opaque: null, emissive: null, transparent: null, water: null };
  if (!chunk || !chunk.generated) return out;
  const data = chunk.data;
  const x0 = cx * CS;
  const z0 = cz * CS;

  const getId = (x: number, y: number, z: number): number => {
    if (y < 0 || y >= H) return y < 0 ? reg.byNameGet('bedrock')?.id ?? 3 : AIR;
    if (x >= 0 && x < CS && z >= 0 && z < CS) return data[(y * CS + z) * CS + x];
    return world.getBlock(x0 + x, y, z0 + z);
  };
  const opaqueAt = (x: number, y: number, z: number): boolean => reg.isOpaque(getId(x, y, z));

  const pushQuad = (
    g: GeoArrays,
    verts: number[][],
    normal: [number, number, number],
    uvRect: [number, number, number, number],
    uvCorners: number[][],
    brightness: number[],
    flip: boolean,
    light: readonly [number, number],
  ) => {
    const base = g.positions.length / 3;
    const [u0, v0, u1, v1] = uvRect;
    for (let i = 0; i < 4; i++) {
      g.positions.push(verts[i][0], verts[i][1], verts[i][2]);
      g.uvs.push(u0 + (u1 - u0) * uvCorners[i][0], v0 + (v1 - v0) * uvCorners[i][1]);
      const b = brightness[i];
      g.colors.push(b, b, b);
      g.lights.push(light[0], light[1]);
    }
    if (flip) g.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (let y = 0; y < H; y++) {
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const id = data[(y * CS + lz) * CS + lx];
        if (id === AIR) continue;
        const def = reg.get(id);
        const pass: GeoArrays = def.lightEmission > 0
          ? (out.emissive ??= newGeo())
          : def.liquid
            ? (out.water ??= newGeo())
            : def.transparentPass
              ? (out.transparent ??= newGeo())
              : (out.opaque ??= newGeo());

        if (def.shape === 'cross') {
          const uvR = atlas.uv(def.tiles.side);
          const quads = [
            [[lx + 0.15, y, lz + 0.15], [lx + 0.85, y, lz + 0.85], [lx + 0.85, y + 1, lz + 0.85], [lx + 0.15, y + 1, lz + 0.15]],
            [[lx + 0.85, y, lz + 0.15], [lx + 0.15, y, lz + 0.85], [lx + 0.15, y + 1, lz + 0.85], [lx + 0.85, y + 1, lz + 0.15]],
          ];
          const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
          const bright = [0.95, 0.95, 1, 1];
          const light: [number, number] = [
            world.getSkyLight(x0 + lx, y, z0 + lz) / 15,
            world.getBlockLight(x0 + lx, y, z0 + lz) / 15,
          ];
          for (const q of quads) {
            pushQuad(pass, q, [0, 1, 0], uvR, uvs, bright, false, light);
            pushQuad(pass, [q[3], q[2], q[1], q[0]], [0, 1, 0], uvR, [uvs[3], uvs[2], uvs[1], uvs[0]], bright, false, light);
          }
          continue;
        }

        const lowerWaterTop = def.liquid && !reg.get(getId(lx, y + 1, lz)).liquid;

        for (const face of FACES) {
          const [nx, ny, nz] = face.normal;
          const nid = getId(lx + nx, y + ny, lz + nz);
          if (!faceVisible(def, reg.get(nid))) continue;

          const tileName = face.axis === 1 ? (face.sign > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;
          const uvR = atlas.uv(tileName);

          // 逐顶点 AO
          const ao: number[] = [];
          const useAO = !def.transparentPass && !def.liquid;
          const t1 = face.axis === 0 ? 1 : 0;
          const t2 = face.axis === 2 ? 1 : 2;
          for (const c of face.corners) {
            if (!useAO) { ao.push(3); continue; }
            const o1 = c[t1] === 0 ? -1 : 1;
            const o2 = c[t2] === 0 ? -1 : 1;
            const bx = lx + nx, by = y + ny, bz = lz + nz;
            const p1 = [bx, by, bz]; p1[t1] += o1;
            const p2 = [bx, by, bz]; p2[t2] += o2;
            const pc = [bx, by, bz]; pc[t1] += o1; pc[t2] += o2;
            const s1 = opaqueAt(p1[0], p1[1], p1[2]) ? 1 : 0;
            const s2 = opaqueAt(p2[0], p2[1], p2[2]) ? 1 : 0;
            const cc = opaqueAt(pc[0], pc[1], pc[2]) ? 1 : 0;
            ao.push(s1 && s2 ? 0 : 3 - (s1 + s2 + cc));
          }

          const verts: number[][] = [];
          const uvC: number[][] = [];
          const bright: number[] = [];
          for (let i = 0; i < 4; i++) {
            const c = face.corners[i];
            let cy = c[1];
            if (lowerWaterTop && cy === 1) cy -= 0.12;
            verts.push([lx + c[0], y + cy, lz + c[2]]);
            uvC.push([c[3], c[4]]);
            bright.push(face.shade * AO_LEVELS[ao[i]]);
          }
          const flip = ao[0] + ao[2] < ao[1] + ao[3];
          // 采样面外侧空气格的光照（跨区块也能取到）
          const light: [number, number] = [
            world.getSkyLight(x0 + lx + nx, y + ny, z0 + lz + nz) / 15,
            world.getBlockLight(x0 + lx + nx, y + ny, z0 + lz + nz) / 15,
          ];
          pushQuad(pass, verts, face.normal, uvR, uvC, bright, flip, light);
        }
      }
    }
  }
  return out;
}

function faceVisible(def: BlockDefinition, neighbor: BlockDefinition): boolean {
  if (neighbor.id === AIR) return true;
  // 非遮光方块（如树叶）可在注册时声明剔除同材质内部面，避免树冠整块内壁出面
  if (def.cullSame && neighbor.id === def.id) return false;
  if (def.liquid) return !neighbor.liquid && !neighbor.opaque;
  if (neighbor.opaque) return false;
  if (def.name === 'glass' && neighbor.name === 'glass') return false;
  return true;
}