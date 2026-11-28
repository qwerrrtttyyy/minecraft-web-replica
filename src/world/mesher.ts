import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import { AO_LEVELS, FACES, type FaceDef } from './faces';
import {
  AIR_MESH_DEF,
  type ChunkMeshData,
  type MeshBlockDef,
  type MeshSource,
  type MeshStats,
  type MutableChunkMeshData,
  type MutableGeoArrays,
  type UVRect,
  ZERO_UV,
} from './meshTypes';

/**
 * 区块网格生成（主线程 / Worker 共用同一份实现）。
 *
 * - 隐藏面剔除 + 逐顶点 AO + 面定向明暗，三个渲染通道（不透明 / 半透明 / 水）。
 *   自发光方块复用不透明通道 + aTint=2；?emerge=0 可切回独立 emissive 通道（实验对照）。
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

const newGeo = (): MutableGeoArrays => ({
  positions: [],
  uvs: [],
  shade: [],
  lights: [],
  tile: [],
  tints: [],
  sways: [],
  indices: [],
});

export type { MeshStats };
export type MeshOutput = ChunkMeshData & { stats: MeshStats };

interface FaceGeom {
  face: FaceDef;
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  /** L 是深度轴：{uAxis, vAxis, dAxis} 恰好划分 {0,1,2}，dimD 由它取尺寸 */
  dAxis: 0 | 1 | 2;
  /** 预解构的法线分量：Greedy 每格都要用法向取邻居，避免循环内 destructuring */
  nx: number;
  ny: number;
  nz: number;
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
  const [nx, ny, nz] = face.normal;
  return {
    face,
    uAxis,
    vAxis,
    dAxis,
    nx,
    ny,
    nz,
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

/** 盒几何 bounds：x0,y0,z0,x1,y1,z1（方块局部坐标） */
type BoxBounds = [number, number, number, number, number, number];
const FULL_BOUNDS: BoxBounds = [0, 0, 0, 1, 1, 1];
/** 半高板（营火 / 灯笼）：底面贴地，顶面半格 */
const SLAB_BOUNDS: BoxBounds = [0, 0, 0, 1, 0.5, 1];
/** 细蜡烛：窄柱，半格高 */
const CANDLE_BOUNDS: BoxBounds = [0.3125, 0, 0.3125, 0.6875, 0.5, 0.6875];

function faceVisible(def: MeshBlockDef, neighbor: MeshBlockDef, knowable = true): boolean {
  // N4：邻居来源未知时，液体不能把「空气占位」当作真实空气而生成虚假水面。
  // 该判断优先级最高，且只对液体生效——非液体四条规则保持不变。
  if (def.liquid && !knowable) return false;
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
/** 每顶点风摆权重：底部 0 → 顶部 1，只对十字面植物生效 */
const qs = new Float64Array(4);
const aoFace = new Int32Array(4);
const aoCheck = new Int32Array(4);
/** 交叉面片的 UV 与亮度（常量，避免每株植物重建数组） */
const CROSS_U = new Float64Array([0, cu(1), cu(1), 0]);
const CROSS_V = new Float64Array([0, 0, cu(1), cu(1)]);
const CROSS_B = new Float64Array([0.95, 0.95, 1, 1]);

/**
 * 顶点开关（aTint）：0 普通；1 群系染色；2 自发光。
 * 自发光方块（萤石 / 南瓜灯 / 火把）默认复用不透明通道，shader 见到 2 就跳过
 * 光照与染色（保留面明暗），效果等价于原来的独立 emissive 材质。
 * 对照路径（mergeEmissive=false）下自发光走独立通道，此开关不再被读到。
 */
const FLAG_NONE = 0;
const FLAG_FOLIAGE = 1;
const FLAG_UNLIT = 2;

/** 顶点开关：自发光常亮，其次群系染色，其余普通 */
const flagsFor = (def: MeshBlockDef): number =>
  def.lightEmission > 0 ? FLAG_UNLIT : def.tint ? FLAG_FOLIAGE : FLAG_NONE;

// ---- 平滑光照 scratch（meshChunk 同步执行，不会重入）----
/** 空气侧 3×3 补丁的天空光 / 方块光（0~15） */
const patchSky = new Int32Array(9);
const patchBlock = new Int32Array(9);
/** 当前面的 4 个角点光照等级（0~15，与体素光照同粒度） */
const cornerSky = new Int32Array(4);
const cornerBlock = new Int32Array(4);
/** 输出到顶点的每角点光照（0~1）：已归一化 */
const quadSky = new Float32Array(4);
const quadBlock = new Float32Array(4);

/** 把同一个光照值填满 4 个顶点（合并面 / 交叉面片用） */
const fillUniform = (arr: Float32Array, v: number) => {
  arr[0] = v;
  arr[1] = v;
  arr[2] = v;
  arr[3] = v;
};

/**
 * 逐顶点 AO，与 v1.2.0 完全一致的采样规则。
 * 结果写入 out（4 个亮度档位），不再返回新数组。
 */
function computeAOInto(
  src: MeshSource,
  bx: number,
  by: number,
  bz: number,
  face: FaceDef,
  def: MeshBlockDef,
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
    if (!useAO) {
      out[i] = 3;
      continue;
    }
    const o1 = c[t1] === 0 ? -1 : 1;
    const o2 = c[t2] === 0 ? -1 : 1;
    // p1：切向 t1；p2：切向 t2；pc：两个切向都偏移
    let x1 = cx,
      y1 = cy,
      z1 = cz;
    if (t1 === 0) x1 += o1;
    else y1 += o1;
    let x2 = cx,
      y2 = cy,
      z2 = cz;
    if (t2 === 1) y2 += o2;
    else z2 += o2;
    let xc = cx,
      yc = cy,
      zc = cz;
    if (t1 === 0) xc += o1;
    else yc += o1;
    if (t2 === 1) yc += o2;
    else zc += o2;
    const s1 = src.isOpaque(src.getId(x1, y1, z1)) ? 1 : 0;
    const s2 = src.isOpaque(src.getId(x2, y2, z2)) ? 1 : 0;
    const cc = src.isOpaque(src.getId(xc, yc, zc)) ? 1 : 0;
    out[i] = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
  }
  return out;
}

/**
 * 逐角点光照（平滑光照）：角点亮度取「空气侧」相邻 4 格光照的均值。
 *
 * 面法向固定在邻居格 N，法向之外的两个切向各跨 2 格 → 每个角点由 4 格决定：
 *   角点沿切向的局部坐标 c[t] 为 0 → 取 {N-1, N}，为 1 → 取 {N, N+1}。
 * 4 个角点合起来正好覆盖 N 周围切向的 3×3 补丁，所以先取一次 3×3 补丁
 * （9 格），再让 4 个角点各取补丁里的 2×2 均值即可，比逐角点各取 4 格省一半采样。
 *
 * 结果写入 outSky / outBlock（4 个角的光照等级 0~15，取 4 格均值后四舍五入）。
 * 量化成整数而不是保留小数，是为了让「四角是否一致」是精确判定，
 * 同时让角点光照与体素光照保持同一粒度（0~15）。
 *
 * 一致性保证：同一张面上，相邻方块共享的角点取到的是同一组 4 格，
 * 因此角点光照在方块边界两侧连续，不会出现接缝。
 */
function computeCornerLightInto(
  src: MeshSource,
  bx: number,
  by: number,
  bz: number,
  face: FaceDef,
  outSky: Int32Array,
  outBlock: Int32Array,
): void {
  const ax = face.axis;
  const t1 = ax === 0 ? 1 : 0;
  const t2 = ax === 2 ? 1 : 2;
  const [nx, ny, nz] = face.normal;
  // 空气侧基准格：法向推进一格
  const gx = bx + nx;
  const gy = by + ny;
  const gz = bz + nz;
  // 切向 3×3 补丁：索引 (p1+1)*3 + (p2+1)，p1/p2 ∈ {-1,0,1} 表示沿 t1/t2 的偏移
  for (let p1 = -1; p1 <= 1; p1++) {
    for (let p2 = -1; p2 <= 1; p2++) {
      let x: number, y: number, z: number;
      if (ax === 0) {
        x = gx;
        y = gy + p1;
        z = gz + p2;
      } else if (ax === 1) {
        x = gx + p1;
        y = gy;
        z = gz + p2;
      } else {
        x = gx + p1;
        y = gy + p2;
        z = gz;
      }
      const i = (p1 + 1) * 3 + (p2 + 1);
      patchSky[i] = src.getSkyLight(x, y, z);
      patchBlock[i] = src.getBlockLight(x, y, z);
    }
  }
  // 4 个角点各取补丁的 2×2
  for (let i = 0; i < 4; i++) {
    const c = face.corners[i];
    const r0 = c[t1] === 0 ? 0 : 1;
    const c0 = c[t2] === 0 ? 0 : 1;
    const a = r0 * 3 + c0;
    const s = patchSky[a] + patchSky[a + 1] + patchSky[a + 3] + patchSky[a + 4];
    const b = patchBlock[a] + patchBlock[a + 1] + patchBlock[a + 3] + patchBlock[a + 4];
    // 四舍五入到整数光照等级：(s + 2) >> 2 等价于 Math.round(s / 4)，比浮点快
    outSky[i] = (s + 2) >> 2;
    outBlock[i] = (b + 2) >> 2;
  }
}

const tileFor = (def: MeshBlockDef, face: FaceDef) =>
  face.axis === 1 ? (face.sign > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;

export function meshChunk(src: MeshSource, yBase = 0, yCount = H): MeshOutput {
  // 竖向分段：section 只遍历自己那 16 层，几何顶点 y 归一到 0..yCount，
  // 由 mesh.position.y 抬到世界高度。这样改一格只需重算一个 section。
  const yEnd = yBase + yCount;
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  // 收集期用窄类型（分量可 .push）；返回时按 MeshOutput 暴露，契约不变。
  const mutable: MutableChunkMeshData = {
    opaque: null,
    emissive: null,
    transparent: null,
    water: null,
  };
  const out: MeshOutput = {
    opaque: null,
    emissive: null,
    transparent: null,
    water: null,
    stats: { quads: 0, vertices: 0, merged: 0, ms: 0 },
  };

  /**
   * 可选来源可信度查询提升到入口：每个可见面都要问一次，
   * 把可选链与属性读取从内层循环移到整块只做一次。缺省来源恒为可信。
   */
  // 注意：isKnown 是源对象上的方法（SnapshotMeshSource 会读 this.snapshot），
  // 必须在入口 bind 一次；直接取出裸函数再调用会丢掉 this。
  const isKnown = src.isKnown ? src.isKnown.bind(src) : () => true;

  /**
   * 通道分配。默认把自发光并进不透明通道：它不需要光照 / 染色，
   * 用 aTint=2 告诉 shader 跳过光照，省下一份材质、一次 draw call 与一次几何。
   * mergeEmissive=false（?emerge=0）保留 v1.5.1 的独立 emissive 通道，仅作实验对照。
   */
  const passFor = (def: MeshBlockDef): MutableGeoArrays => {
    if (def.lightEmission > 0 && !src.mergeEmissive) {
      mutable.emissive ??= newGeo();
      return mutable.emissive;
    }
    if (def.liquid) {
      mutable.water ??= newGeo();
      return mutable.water;
    }
    if (def.transparentPass) {
      mutable.transparent ??= newGeo();
      return mutable.transparent;
    }
    mutable.opaque ??= newGeo();
    return mutable.opaque;
  };

  /** 收集完成后把通道引用挂到对外契约上（类型放宽但运行时同一对象） */
  const publish = (): MeshOutput => {
    // 顶点统一在出口处归一到 section 局部坐标：各条路径（逐面 / 贪心 / 盒子）
    // 都按绝对 y 写顶点，这里一次性减去 yBase，避免每条路径各改一遍。
    if (yBase !== 0) {
      for (const g of [mutable.opaque, mutable.emissive, mutable.transparent, mutable.water]) {
        if (!g) continue;
        const pos = g.positions;
        for (let i = 1; i < pos.length; i += 3) pos[i] -= yBase;
      }
    }
    out.opaque = mutable.opaque;
    out.emissive = mutable.emissive;
    out.transparent = mutable.transparent;
    out.water = mutable.water;
    return out;
  };

  /** 把 scratch 里的四个顶点写入通道，flip 控制对角线方向；flags 为顶点开关（0/1/2） */
  const pushQuad = (
    g: MutableGeoArrays,
    tile: UVRect,
    flip: boolean,
    lightSky: Float32Array,
    lightBlock: Float32Array,
    flags: number,
  ) => {
    const base = g.positions.length / 3;
    // tile 尺寸全图集一致，走 shader uniform；顶点只带 tile 起点
    const u0 = tile[0];
    const v0 = tile[1];
    const P = g.positions;
    const U = g.uvs;
    const T = g.tile;
    const S = g.shade;
    const L = g.lights;
    const N = g.tints;
    const SW = g.sways;
    for (let i = 0; i < 4; i++) {
      P.push(qx[i], qy[i], qz[i]);
      U.push(qu[i], qv[i]);
      T.push(u0, v0);
      S.push(qb[i]);
      // 逐顶点光照：平滑光照下 4 个角点亮度各不相同
      L.push(lightSky[i], lightBlock[i]);
      N.push(flags);
      SW.push(qs[i]);
    }
    const I = g.indices;
    if (flip) I.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    out.stats.quads++;
    out.stats.vertices += 4;
  };

  /**
   * 单个面的原始输出。
   * precomputedAO / precomputedSky / precomputedBlock 非空时直接复用
   * （Greedy 路径已经算过，避免同一面算两遍）。
   */
  const emitFace = (
    bx: number,
    by: number,
    bz: number,
    def: MeshBlockDef,
    face: FaceDef,
    precomputedAO?: Int32Array,
    precomputedSky?: Int32Array,
    precomputedBlock?: Int32Array,
    bounds?: BoxBounds,
  ) => {
    const g = passFor(def);
    const tile = src.uv(tileFor(def, face));
    // Greedy 路径已经算过 AO 的不均面直接复用，避免同一面算两遍
    const ao = precomputedAO ?? computeAOInto(src, bx, by, bz, face, def, aoFace);
    // 角点光照：逐角点取空气侧 4 格均值（平滑光照）
    const lvSky = precomputedSky ?? cornerSky;
    const lvBlock = precomputedBlock ?? cornerBlock;
    if (!precomputedSky) computeCornerLightInto(src, bx, by, bz, face, cornerSky, cornerBlock);
    const lowerWaterTop = def.liquid && !src.def(src.getId(bx, by + 1, bz)).liquid;
    const shade = face.shade;
    // bounds 缺省为整立方体；slab / candle 用同一组 corners 缩放到子盒
    const b = bounds ?? FULL_BOUNDS;
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i];
      qx[i] = bx + b[0] + (b[3] - b[0]) * c[0];
      let yy = b[1] + (b[4] - b[1]) * c[1];
      if (lowerWaterTop && c[1] === 1) yy -= 0.12;
      qy[i] = by + yy;
      qz[i] = bz + b[2] + (b[5] - b[2]) * c[2];
      qu[i] = cu(c[3]);
      qv[i] = cu(c[4]);
      qb[i] = shade * AO_LEVELS[ao[i]];
      // 角点光照等级（0~15）归一化到 0~1
      quadSky[i] = lvSky[i] / 15;
      quadBlock[i] = lvBlock[i] / 15;
      qs[i] = 0;
    }
    const flip = ao[0] + ao[2] < ao[1] + ao[3];
    pushQuad(g, tile, flip, quadSky, quadBlock, flagsFor(def));
  };

  /**
   * 任意盒几何（slab / candle / 普通立方体兜底）：遍历六个面，
   * 用面法向的相邻块做剔除，再带 bounds 输出。
   * AO / 角点光照仍按面法向的相邻块采样，对子盒是合理近似。
   */
  const emitBox = (bx: number, by: number, bz: number, def: MeshBlockDef, bounds: BoxBounds) => {
    for (let fi = 0; fi < FACES.length; fi++) {
      const face = FACES[fi];
      const [nx, ny, nz] = face.normal;
      const nid = src.getId(bx + nx, by + ny, bz + nz);
      if (!faceVisible(def, src.def(nid), src.isKnown?.(bx + nx, by + ny, bz + nz) ?? true)) continue;
      emitFace(bx, by, bz, def, face, undefined, undefined, undefined, bounds);
    }
  };

  /** 交叉面片（草丛 / 花）：两片，每片正反各一次 */
  const emitCross = (bx: number, by: number, bz: number, def: MeshBlockDef) => {
    const g = passFor(def);
    const tile = src.uv(def.tiles.side);
    // 交叉面片按所在格的整体光照取值（角点平均对斜置面片没有几何意义）
    fillUniform(quadSky, src.getSkyLight(bx, by, bz) / 15);
    fillUniform(quadBlock, src.getBlockLight(bx, by, bz) / 15);
    const flags = flagsFor(def);
    // 植物高度：贴图仍是 16px，几何按群系高度压缩/拉伸，矮花不再顶满整格
    const height = Math.max(0.1, Math.min(1, def.crossHeight ?? 1));
    const x0 = bx + 0.15,
      x1 = bx + 0.85;
    const z0 = bz + 0.15,
      z1 = bz + 0.85;
    const y0 = by,
      y1 = by + height;

    // 面 A（正面）
    qx[0] = x0;
    qy[0] = y0;
    qz[0] = z0;
    qx[1] = x1;
    qy[1] = y0;
    qz[1] = z1;
    qx[2] = x1;
    qy[2] = y1;
    qz[2] = z1;
    qx[3] = x0;
    qy[3] = y1;
    qz[3] = z0;
    qu.set(CROSS_U);
    qv.set(CROSS_V);
    qb.set(CROSS_B);
    qs[0] = 0;
    qs[1] = 0;
    qs[2] = height;
    qs[3] = height;
    pushQuad(g, tile, false, quadSky, quadBlock, flags);
    // 面 A（反面：顶点反序 + UV 反序，亮度保持原顺序）
    qx[0] = x0;
    qy[0] = y1;
    qz[0] = z0;
    qx[1] = x1;
    qy[1] = y1;
    qz[1] = z1;
    qx[2] = x1;
    qy[2] = y0;
    qz[2] = z1;
    qx[3] = x0;
    qy[3] = y0;
    qz[3] = z0;
    qu[0] = 0;
    qu[1] = cu(1);
    qu[2] = cu(1);
    qu[3] = 0;
    qv[0] = cu(1);
    qv[1] = cu(1);
    qv[2] = 0;
    qv[3] = 0;
    qs[0] = height;
    qs[1] = height;
    qs[2] = 0;
    qs[3] = 0;
    pushQuad(g, tile, false, quadSky, quadBlock, flags);

    // 面 B（正面）
    qx[0] = x1;
    qy[0] = y0;
    qz[0] = z0;
    qx[1] = x0;
    qy[1] = y0;
    qz[1] = z1;
    qx[2] = x0;
    qy[2] = y1;
    qz[2] = z1;
    qx[3] = x1;
    qy[3] = y1;
    qz[3] = z0;
    qu.set(CROSS_U);
    qv.set(CROSS_V);
    qb.set(CROSS_B);
    qs[0] = 0;
    qs[1] = 0;
    qs[2] = height;
    qs[3] = height;
    pushQuad(g, tile, false, quadSky, quadBlock, flags);
    // 面 B（反面）
    qx[0] = x1;
    qy[0] = y1;
    qz[0] = z0;
    qx[1] = x0;
    qy[1] = y1;
    qz[1] = z1;
    qx[2] = x0;
    qy[2] = y0;
    qz[2] = z1;
    qx[3] = x1;
    qy[3] = y0;
    qz[3] = z0;
    qu[0] = 0;
    qu[1] = cu(1);
    qu[2] = cu(1);
    qu[3] = 0;
    qv[0] = cu(1);
    qv[1] = cu(1);
    qv[2] = 0;
    qv[3] = 0;
    qs[0] = height;
    qs[1] = height;
    qs[2] = 0;
    qs[3] = 0;
    pushQuad(g, tile, false, quadSky, quadBlock, flags);
  };

  /** 逐方块逐面输出（greedy 关闭时的完整路径，或特殊方块的兜底路径） */
  const emitBlock = (bx: number, by: number, bz: number) => {
    const id = src.getId(bx, by, bz);
    if (id === 0) return;
    const def = src.def(id);
    if (def.shape === 'cross') {
      emitCross(bx, by, bz, def);
      return;
    }
    if (def.shape === 'slab' || def.shape === 'candle') {
      const bounds = def.shape === 'slab' ? SLAB_BOUNDS : def.shape === 'candle' ? CANDLE_BOUNDS : FULL_BOUNDS;
      emitBox(bx, by, bz, def, bounds);
    } else {
      for (let fi = 0; fi < FACE_GEOMS.length; fi++) {
        const fg = FACE_GEOMS[fi];
        const face = fg.face;
        const nid = src.getId(bx + fg.nx, by + fg.ny, bz + fg.nz);
        if (!faceVisible(def, src.def(nid), isKnown(bx + fg.nx, by + fg.ny, bz + fg.nz))) continue;
        emitFace(bx, by, bz, def, face);
      }
    }
  };

  if (!src.greedy) {
    for (let y = yBase; y < yEnd; y++)
      for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) emitBlock(lx, y, lz);
    out.stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
    return publish();
  }

  // ---- Greedy 路径 ----

  // A) 特殊方块：完全走原逐面路径，避免水面降顶 / 交叉面片 / 透明排序被合并打乱
  for (let y = yBase; y < yEnd; y++)
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
  for (const fg of FACE_GEOMS) {
    const { face, uAxis, vAxis, uDir, vDir, origin, nx, ny, nz } = fg;
    // 竖向轴的尺寸取当前 section 的高度，其余两轴仍是 16
    const dimU = uAxis === 1 ? yCount : CS;
    const dimV = vAxis === 1 ? yCount : CS;
    const dimD = fg.dAxis === 1 ? yCount : CS;
    const stride = dimU * dimV;
    const lastU = dimU - 1;
    const lastV = dimV - 1;
    const [ox, oy, oz] = origin;
    // 面内切线向量只与面有关：原实现在每个合并 quad 上清零并写 duV/dvV 数组，
    // 这里提到 face 级常量标量，顶点循环直接读标量。
    const duX = uAxis === 0 ? uDir : 0,
      duY = uAxis === 1 ? uDir : 0,
      duZ = uAxis === 2 ? uDir : 0;
    const dvX = vAxis === 0 ? vDir : 0,
      dvY = vAxis === 1 ? vDir : 0,
      dvZ = vAxis === 2 ? vDir : 0;
    if (mask.length < stride) mask = new Int32Array(stride);

    for (let L = 0; L < dimD; L++) {
      mask.fill(0, 0, stride);
      for (let V = 0; V < dimV; V++) {
        const bv = vDir > 0 ? V : lastV - V;
        for (let U = 0; U < dimU; U++) {
          const bu = uDir > 0 ? U : lastU - U;
          // 原 blockAt() 每次写入并返回可变 bb 数组；这里按轴的分支在 face 级不变量上，
          // 坐标收敛为局部标量，后续 getId / AO / 光照全部只读 bx/by/bz。
          const bx = uAxis === 0 ? bu : vAxis === 0 ? bv : L;
          const by = (uAxis === 1 ? bu : vAxis === 1 ? bv : L) + yBase;
          const bz = uAxis === 2 ? bu : vAxis === 2 ? bv : L;
          const id = src.getId(bx, by, bz);
          if (id === 0) continue;
          const def = src.def(id);
          if (!isPlainCube(def)) continue;
          const nid = src.getId(bx + nx, by + ny, bz + nz);
          if (!faceVisible(def, src.def(nid), isKnown(bx + nx, by + ny, bz + nz) ?? true)) continue;
          const ao = computeAOInto(src, bx, by, bz, face, def, aoCheck);
          // 角点光照（平滑光照）：4 个角点各取空气侧 4 格均值
          computeCornerLightInto(src, bx, by, bz, face, cornerSky, cornerBlock);
          // AO 四角不全等 → 保持逐面输出，避免合并后亮度渐变被拉伸
          // 角点光照四角不全等同理：合并面只能带一份光，拉伸会把渐变抹平
          if (
            ao[0] !== ao[1] ||
            ao[0] !== ao[2] ||
            ao[0] !== ao[3] ||
            cornerSky[0] !== cornerSky[1] ||
            cornerSky[0] !== cornerSky[2] ||
            cornerSky[0] !== cornerSky[3] ||
            cornerBlock[0] !== cornerBlock[1] ||
            cornerBlock[0] !== cornerBlock[2] ||
            cornerBlock[0] !== cornerBlock[3]
          ) {
            emitFace(bx, by, bz, def, face, ao, cornerSky, cornerBlock);
            continue;
          }
          // 光照不一致的面不合并：合并后 GPU 会在整个 quad 上插值同一份光，
          // 把「火把照亮的三格」拉成整面亮，必须把 sky/block 一起写进 key。
          //
          // 平滑光照下这里写进 key 的是「四角一致的角点光照等级」。
          // 相邻方块共享角点时取到的是同一组 4 格 → 等级必然一致，
          // 因此合并面上的每个角点光都等于 key 里这一个值，
          // 合并结果与逐面输出严格等价。
          const sky = cornerSky[0];
          const blk = cornerBlock[0];
          mask[V * dimU + U] = (id | (ao[0] << 8) | (sky << 10) | (blk << 14)) + 1;
        }
      }

      // 贪心：先横向扩 w，再纵向扩 h（要求整行 key 一致）
      for (let V = 0; V < dimV; V++) {
        for (let U = 0; U < dimU; ) {
          const key = mask[V * dimU + U];
          if (key === 0) {
            U++;
            continue;
          }
          let w = 1;
          while (U + w < dimU && mask[V * dimU + U + w] === key) w++;
          let h = 1;
          grow: while (V + h < dimV) {
            for (let i = 0; i < w; i++) if (mask[(V + h) * dimU + U + i] !== key) break grow;
            h++;
          }
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mask[(V + j) * dimU + U + i] = 0;

          const k = key - 1;
          const id = k & 255;
          const ao = (k >> 8) & 3;
          // 合并面四角光照一致（入 mask 前已校验），所以 4 个顶点共用一份光
          fillUniform(quadSky, ((k >> 10) & 15) / 15);
          fillUniform(quadBlock, ((k >> 14) & 15) / 15);
          const def = src.def(id);
          const tile = src.uv(tileFor(def, face));
          const g = passFor(def);
          // 与扫描路径同一套轴映射；合并 quad 的原点直接落到标量上
          const bu = uDir > 0 ? U : lastU - U;
          const bv = vDir > 0 ? V : lastV - V;
          const bx = uAxis === 0 ? bu : vAxis === 0 ? bv : L;
          // 合并 quad 的顶点仍按绝对 y 写出，由 publish() 统一减去 yBase
          const by = (uAxis === 1 ? bu : vAxis === 1 ? bv : L) + yBase;
          const bz = uAxis === 2 ? bu : vAxis === 2 ? bv : L;
          const baseX = bx + ox,
            baseY = by + oy,
            baseZ = bz + oz;
          const bright = face.shade * AO_LEVELS[ao];
          const flags = flagsFor(def);
          for (let i = 0; i < 4; i++) {
            const c = face.corners[i];
            const ww = c[3] * w;
            const hh = c[4] * h;
            qx[i] = baseX + duX * ww + dvX * hh;
            qy[i] = baseY + duY * ww + dvY * hh;
            qz[i] = baseZ + duZ * ww + dvZ * hh;
            qu[i] = cu(ww);
            qv[i] = cu(hh);
            qb[i] = bright;
            qs[i] = 0;
          }
          pushQuad(g, tile, false, quadSky, quadBlock, flags);
          out.stats.merged += w * h - 1;
          U += w;
        }
      }
    }
  }
  out.stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
  return publish();
}

export { AIR_MESH_DEF, ZERO_UV };
