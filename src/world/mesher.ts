import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import { FACES, AO_LEVELS, type FaceDef } from './faces';
import {
  AIR_MESH_DEF, ZERO_UV,
  type GeoArrays, type ChunkMeshData, type MeshBlockDef,
  type MeshSource, type MeshStats, type UVRect,
} from './meshTypes';

/**
 * 区块网格生成（主线程 / Worker 共用同一份实现）。
 *
 * - 隐藏面剔除 + 逐顶点 AO + 面定向明暗，四个渲染通道。
 * - greedy=true 时，普通不透明立方体的面走 mask 贪心合并：
 *   **只有四角 AO 完全相等**的面才允许合并，因为合并后 GPU 会在整个大 quad
 *   上做双线性插值；若原四角亮度不同，渐变会被拉长，画面就变了。
 *   该条件同时保证 flip 对角线恒为 false，合并后的 quad 与逐面输出严格等价。
 * - cross 植物、液体、玻璃、自发光、AO 不均的面一律走原逐面路径。
 * - 合并面的局部 UV 为 0..w / 0..h，由 tiledAtlas.ts 注入的 shader
 *   做 fract 平铺，避免图集采样越界或纹理被拉伸。
 *
 * 热路径约定：逐面 / 逐顶点的临时数组全部改为模块级 scratch，
 * meshChunk 同步且不可重入，因此复用安全；输出数值与顺序保持不变。
 */

const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;
/** UV 末端内缩，避免 fract(整数) 恰好落到 tile 左边缘产生一像素接缝 */
const UV_EPS = 1e-4;
const cu = (v: number) => (v > 0 ? v - UV_EPS : 0);

const newGeo = (): GeoArrays => ({ positions: [], uvs: [], colors: [], lights: [], tiles: [], indices: [] });

export type { MeshStats };
export type MeshOutput = ChunkMeshData & { stats: MeshStats };

interface FaceGeom {
  face: FaceDef;
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  dAxis: 0 | 1 | 2;
  uDir: number;
  vDir: number;
  dimU: number;
  dimV: number;
  dimD: number;
  origin: [number, number, number];
}

const axisDim = (a: number) => (a === 1 ? H : CS);

/**
 * 从 FACES 的 corners 反推面内切线方向。
 * corners[0] 是原点，corners[1]-corners[0] = u 方向单位向量，
 * corners[3]-corners[0] = v 方向单位向量，三者恰好构成单位正方形。
 * 因此扫描索引可以直接按 u/v 方向推进，合并矩形的顶点仍由同一组 corners 缩放得到。
 */
const FACE_GEOMS: FaceGeom[] = FACES.map((face) => {
  const c0 = face.corners[0];
  const c1 = face.corners[1];
  const c3 = face.corners[3];
  const uAxis = (c1[0] !== c0[0] ? 0 : c1[1] !== c0[1] ? 1 : 2) as 0 | 1 | 2;
  const vAxis = (c3[0] !== c0[0] ? 0 : c3[1] !== c0[1] ? 1 : 2) as 0 | 1 | 2;
  const dAxis = face.axis;
  return {
    face, uAxis, vAxis, dAxis,
    uDir: c1[uAxis] - c0[uAxis],
    vDir: c3[vAxis] - c0[vAxis],
    dimU: axisDim(uAxis),
    dimV: axisDim(vAxis),
    dimD: axisDim(dAxis),
    origin: [c0[0], c0[1], c0[2]] as [number, number, number],
  };
});

const isPlainCube = (def: MeshBlockDef) =>
  def.shape === 'cube' && !def.liquid && !def.transparentPass && def.lightEmission === 0;

function faceVisible(def: MeshBlockDef, neighbor: MeshBlockDef): boolean {
  if (neighbor.id === 0) return true;
  if (def.cullSame && neighbor.id === def.id) return false;
  if (def.liquid) return !neighbor.liquid && !neighbor.opaque;
  if (neighbor.opaque) return false;
  if (def.name === 'glass' && neighbor.name === 'glass') return false;
  return true;
}

// ---- 复用的顶点 / AO scratch（meshChunk 同步执行，不会重入）----
const qx = new Float64Array(4);
const qy = new Float64Array(4);
const qz = new Float64Array(4);
const qu = new Float64Array(4);
const qv = new Float64Array(4);
const qb = new Float64Array(4);
const aoFace = new Int32Array(4);
const aoCheck = new Int32Array(4);
/** 交叉面片的 UV 与亮度（常量，避免每株植物重建数组） */
const CROSS_U = new Float64Array([0, cu(1), cu(1), 0]);
const CROSS_V = new Float64Array([0, 0, cu(1), cu(1)]);
const CROSS_B = new Float64Array([0.95, 0.95, 1, 1]);

/**
 * 逐顶点 AO，与 v1.2.0 完全一致的采样规则。
 * 结果写入 out（4 个亮度档位），不再返回新数组。
 */
function computeAOInto(
  src: MeshSource,
  bx: number, by: number, bz: number,
  face: FaceDef, def: MeshBlockDef,
  out: Int32Array,
): Int32Array {
  const useAO = !def.transparentPass && !def.liquid;
  const t1 = face.axis === 0 ? 1 : 0;
  const t2 = face.axis === 2 ? 1 : 2;
  const [nx, ny, nz] = face.normal;
  const cx = bx + nx;
  const cy = by + ny;
  const cz = bz + nz;
  for (let i = 0; i < 4; i++) {
    const c = face.corners[i];
    if (!useAO) { out[i] = 3; continue; }
    const o1 = c[t1] === 0 ? -1 : 1;
    const o2 = c[t2] === 0 ? -1 : 1;
    // p1：切向 t1；p2：切向 t2；pc：两个切向都偏移
    let x1 = cx, y1 = cy, z1 = cz;
    if (t1 === 0) x1 += o1; else y1 += o1;
    let x2 = cx, y2 = cy, z2 = cz;
    if (t2 === 1) y2 += o2; else z2 += o2;
    let xc = cx, yc = cy, zc = cz;
    if (t1 === 0) xc += o1; else yc += o1;
    if (t2 === 1) yc += o2; else zc += o2;
    const s1 = src.isOpaque(src.getId(x1, y1, z1)) ? 1 : 0;
    const s2 = src.isOpaque(src.getId(x2, y2, z2)) ? 1 : 0;
    const cc = src.isOpaque(src.getId(xc, yc, zc)) ? 1 : 0;
    out[i] = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
  }
  return out;
}

const tileFor = (def: MeshBlockDef, face: FaceDef) =>
  face.axis === 1 ? (face.sign > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;

export function meshChunk(src: MeshSource): MeshOutput {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const out: MeshOutput = {
    opaque: null, emissive: null, transparent: null, water: null,
    stats: { quads: 0, vertices: 0, merged: 0, ms: 0 },
  };

  const passFor = (def: MeshBlockDef): GeoArrays => {
    if (def.lightEmission > 0) {
      out.emissive ??= newGeo();
      return out.emissive;
    }
    if (def.liquid) {
      out.water ??= newGeo();
      return out.water;
    }
    if (def.transparentPass) {
      out.transparent ??= newGeo();
      return out.transparent;
    }
    out.opaque ??= newGeo();
    return out.opaque;
  };

  /** 把 scratch 里的四个顶点写入通道，flip 控制对角线方向 */
  const pushQuad = (g: GeoArrays, tile: UVRect, flip: boolean, sky: number, block: number) => {
    const base = g.positions.length / 3;
    const u0 = tile[0];
    const v0 = tile[1];
    const du = tile[2];
    const dv = tile[3];
    const P = g.positions;
    const U = g.uvs;
    const T = g.tiles;
    const C = g.colors;
    const L = g.lights;
    for (let i = 0; i < 4; i++) {
      P.push(qx[i], qy[i], qz[i]);
      U.push(qu[i], qv[i]);
      T.push(u0, v0, du, dv);
      const b = qb[i];
      C.push(b, b, b);
      L.push(sky, block);
    }
    const I = g.indices;
    if (flip) I.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    out.stats.quads++;
    out.stats.vertices += 4;
  };

  /** 单个面的原始输出（v1.2.0 行为，UV 改为局部坐标 + tileRect） */
  const emitFace = (
    bx: number, by: number, bz: number,
    def: MeshBlockDef, face: FaceDef, precomputed?: Int32Array,
  ) => {
    const g = passFor(def);
    const tile = src.uv(tileFor(def, face));
    // Greedy 路径已经算过 AO 的不均面直接复用，避免同一面算两遍
    const ao = precomputed ?? computeAOInto(src, bx, by, bz, face, def, aoFace);
    const lowerWaterTop = def.liquid && !src.def(src.getId(bx, by + 1, bz)).liquid;
    const shade = face.shade;
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i];
      qx[i] = bx + c[0];
      let cy = c[1];
      if (lowerWaterTop && cy === 1) cy -= 0.12;
      qy[i] = by + cy;
      qz[i] = bz + c[2];
      qu[i] = cu(c[3]);
      qv[i] = cu(c[4]);
      qb[i] = shade * AO_LEVELS[ao[i]];
    }
    const flip = ao[0] + ao[2] < ao[1] + ao[3];
    // 采样面外侧空气格的光照（跨区块与未加载边界都能安全取值）
    const lightSky = src.getSkyLight(bx + face.normal[0], by + face.normal[1], bz + face.normal[2]) / 15;
    const lightBlock = src.getBlockLight(bx + face.normal[0], by + face.normal[1], bz + face.normal[2]) / 15;
    pushQuad(g, tile, flip, lightSky, lightBlock);
  };

  /** 交叉面片（草丛 / 花）：两片，每片正反各一次 */
  const emitCross = (bx: number, by: number, bz: number, def: MeshBlockDef) => {
    const g = passFor(def);
    const tile = src.uv(def.tiles.side);
    const lightSky = src.getSkyLight(bx, by, bz) / 15;
    const lightBlock = src.getBlockLight(bx, by, bz) / 15;
    const x0 = bx + 0.15, x1 = bx + 0.85;
    const z0 = bz + 0.15, z1 = bz + 0.85;
    const y0 = by, y1 = by + 1;

    // 面 A（正面）
    qx[0] = x0; qy[0] = y0; qz[0] = z0;
    qx[1] = x1; qy[1] = y0; qz[1] = z1;
    qx[2] = x1; qy[2] = y1; qz[2] = z1;
    qx[3] = x0; qy[3] = y1; qz[3] = z0;
    qu.set(CROSS_U); qv.set(CROSS_V); qb.set(CROSS_B);
    pushQuad(g, tile, false, lightSky, lightBlock);
    // 面 A（反面：顶点反序 + UV 反序，亮度保持原顺序）
    qx[0] = x0; qy[0] = y1; qz[0] = z0;
    qx[1] = x1; qy[1] = y1; qz[1] = z1;
    qx[2] = x1; qy[2] = y0; qz[2] = z1;
    qx[3] = x0; qy[3] = y0; qz[3] = z0;
    qu[0] = 0; qu[1] = cu(1); qu[2] = cu(1); qu[3] = 0;
    qv[0] = cu(1); qv[1] = cu(1); qv[2] = 0; qv[3] = 0;
    pushQuad(g, tile, false, lightSky, lightBlock);

    // 面 B（正面）
    qx[0] = x1; qy[0] = y0; qz[0] = z0;
    qx[1] = x0; qy[1] = y0; qz[1] = z1;
    qx[2] = x0; qy[2] = y1; qz[2] = z1;
    qx[3] = x1; qy[3] = y1; qz[3] = z0;
    qu.set(CROSS_U); qv.set(CROSS_V); qb.set(CROSS_B);
    pushQuad(g, tile, false, lightSky, lightBlock);
    // 面 B（反面）
    qx[0] = x1; qy[0] = y1; qz[0] = z0;
    qx[1] = x0; qy[1] = y1; qz[1] = z1;
    qx[2] = x0; qy[2] = y0; qz[2] = z1;
    qx[3] = x1; qy[3] = y0; qz[3] = z0;
    qu[0] = 0; qu[1] = cu(1); qu[2] = cu(1); qu[3] = 0;
    qv[0] = cu(1); qv[1] = cu(1); qv[2] = 0; qv[3] = 0;
    pushQuad(g, tile, false, lightSky, lightBlock);
  };

  /** 逐方块逐面输出（greedy 关闭时的完整路径，或特殊方块的兜底路径） */
  const emitBlock = (bx: number, by: number, bz: number) => {
    const id = src.getId(bx, by, bz);
    if (id === 0) return;
    const def = src.def(id);
    if (def.shape === 'cross') { emitCross(bx, by, bz, def); return; }
    for (let fi = 0; fi < FACES.length; fi++) {
      const face = FACES[fi];
      const [nx, ny, nz] = face.normal;
      const nid = src.getId(bx + nx, by + ny, bz + nz);
      if (!faceVisible(def, src.def(nid))) continue;
      emitFace(bx, by, bz, def, face);
    }
  };

  if (!src.greedy) {
    for (let y = 0; y < H; y++)
      for (let lz = 0; lz < CS; lz++)
        for (let lx = 0; lx < CS; lx++) emitBlock(lx, y, lz);
    out.stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
    return out;
  }

  // ---- Greedy 路径 ----

  // A) 特殊方块：完全走原逐面路径，避免水面降顶 / 交叉面片 / 透明排序被合并打乱
  for (let y = 0; y < H; y++)
    for (let lz = 0; lz < CS; lz++)
      for (let lx = 0; lx < CS; lx++) {
        const id = src.getId(lx, y, lz);
        if (id === 0) continue;
        if (isPlainCube(src.def(id))) continue;
        emitBlock(lx, y, lz);
      }

  // B) 普通立方体：按 (face, layer) 建 mask 并贪心合并
  //    key = (blockId | ao<<8) + 1，0 表示该格无可见/可合并面。
  //    同一 face 下 tile 与 shade 完全由 (blockId, face) 决定，无需进 key。
  let mask = new Int32Array(1);
  // 扫描期复用的坐标/向量缓冲：单区块约 12 万次格子访问，避免每次分配数组
  const bb: [number, number, number] = [0, 0, 0];
  const base: [number, number, number] = [0, 0, 0];
  const duV: [number, number, number] = [0, 0, 0];
  const dvV: [number, number, number] = [0, 0, 0];
  for (const fg of FACE_GEOMS) {
    const { face, uAxis, vAxis, dAxis, uDir, vDir, dimU, dimV, dimD, origin } = fg;
    const [nx, ny, nz] = face.normal;
    const stride = dimU * dimV;
    if (mask.length < stride) mask = new Int32Array(stride);

    const blockAt = (U: number, V: number, L: number): [number, number, number] => {
      bb[uAxis] = uDir > 0 ? U : dimU - 1 - U;
      bb[vAxis] = vDir > 0 ? V : dimV - 1 - V;
      bb[dAxis] = L;
      return bb;
    };

    for (let L = 0; L < dimD; L++) {
      mask.fill(0, 0, stride);
      for (let V = 0; V < dimV; V++) {
        for (let U = 0; U < dimU; U++) {
          const b = blockAt(U, V, L);
          const id = src.getId(b[0], b[1], b[2]);
          if (id === 0) continue;
          const def = src.def(id);
          if (!isPlainCube(def)) continue;
          const nid = src.getId(b[0] + nx, b[1] + ny, b[2] + nz);
          if (!faceVisible(def, src.def(nid))) continue;
          const ao = computeAOInto(src, b[0], b[1], b[2], face, def, aoCheck);
          // AO 四角不全等 → 保持逐面输出，避免合并后亮度渐变被拉伸
          if (ao[0] !== ao[1] || ao[0] !== ao[2] || ao[0] !== ao[3]) {
            emitFace(b[0], b[1], b[2], def, face, ao);
            continue;
          }
          // 光照不一致的面不合并：合并后 GPU 会在整个 quad 上插值同一份光，
          // 把「火把照亮的三格」拉成整面亮，必须把 sky/block 一起写进 key。
          const sky = src.getSkyLight(b[0] + nx, b[1] + ny, b[2] + nz) & 15;
          const blk = src.getBlockLight(b[0] + nx, b[1] + ny, b[2] + nz) & 15;
          mask[V * dimU + U] = (id | (ao[0] << 8) | (sky << 10) | (blk << 14)) + 1;
        }
      }

      // 贪心：先横向扩 w，再纵向扩 h（要求整行 key 一致）
      for (let V = 0; V < dimV; V++) {
        for (let U = 0; U < dimU;) {
          const key = mask[V * dimU + U];
          if (key === 0) { U++; continue; }
          let w = 1;
          while (U + w < dimU && mask[V * dimU + U + w] === key) w++;
          let h = 1;
          grow: while (V + h < dimV) {
            for (let i = 0; i < w; i++) if (mask[(V + h) * dimU + U + i] !== key) break grow;
            h++;
          }
          for (let j = 0; j < h; j++)
            for (let i = 0; i < w; i++) mask[(V + j) * dimU + U + i] = 0;

          const k = key - 1;
          const id = k & 255;
          const ao = (k >> 8) & 3;
          const lightSky = ((k >> 10) & 15) / 15;
          const lightBlock = ((k >> 14) & 15) / 15;
          const def = src.def(id);
          const tile = src.uv(tileFor(def, face));
          const g = passFor(def);
          const b0 = blockAt(U, V, L);
          base[0] = b0[0] + origin[0];
          base[1] = b0[1] + origin[1];
          base[2] = b0[2] + origin[2];
          duV[0] = duV[1] = duV[2] = 0; duV[uAxis] = uDir;
          dvV[0] = dvV[1] = dvV[2] = 0; dvV[vAxis] = vDir;
          const bright = face.shade * AO_LEVELS[ao];
          for (let i = 0; i < 4; i++) {
            const c = face.corners[i];
            const ww = c[3] * w;
            const hh = c[4] * h;
            qx[i] = base[0] + duV[0] * ww + dvV[0] * hh;
            qy[i] = base[1] + duV[1] * ww + dvV[1] * hh;
            qz[i] = base[2] + duV[2] * ww + dvV[2] * hh;
            qu[i] = cu(ww);
            qv[i] = cu(hh);
            qb[i] = bright;
          }
          pushQuad(g, tile, false, lightSky, lightBlock);
          out.stats.merged += w * h - 1;
          U += w;
        }
      }
    }
  }
  out.stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
  return out;
}

export { AIR_MESH_DEF, ZERO_UV };
