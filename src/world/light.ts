import { CHUNK_SIZE, WORLD_HEIGHT, chunkKey, type BlockId } from '../core/types';
import { AIR } from './blocks';
import type { Chunk, World } from './world';

const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;
const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const HORIZ: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 体素光照：天空光 + 方块光，均为 0~15。
 *
 * - 天空光：先按列初始化（露天列保持 15，水和树叶按列衰减），
 *   再只把「影子边界」放进 BFS 队列做水平扩散；
 * - 方块光：从 lightEmission > 0 的方块出发，每格衰减 1（水衰减 2）；
 * - 只处理已生成/已初始化的区块，跨区块通过边界种子传播；
 * - 方块变化时走「移除 + 重新扩散」，不会全量重算区块。
 */
export class LightEngine {
  private skyQ: number[] = [];
  private blockQ: number[] = [];
  /** 光照发生变化的区块，最后统一并入 world.dirty */
  private touched = new Set<string>();
  private cacheCx = NaN;
  private cacheCz = NaN;
  private cacheChunk: Chunk | undefined;
  /**
   * 方块 id → BFS 衰减（1 普通 / 2 液体 / 16 遮光）。
   * 注册表只在启动期写入，缓存一次即可；未知 id（插件后注册）首次访问时再查。
   */
  private costCache = new Uint8Array(256).fill(255);

  constructor(private world: World) {}

  /** 区块生成（含编辑差分）后初始化光照 */
  initChunk(chunk: Chunk) {
    const x0 = chunk.cx * CS;
    const z0 = chunk.cz * CS;

    // 1) 天空光列
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        let level = 15;
        for (let y = H - 1; y >= 0; y--) {
          const idx = chunk.idx(lx, y, lz);
          const cost = this.columnCost(chunk.data[idx]);
          if (cost >= 16) break;
          level -= cost;
          if (level <= 0) break;
          chunk.sky[idx] = level;
        }
      }
    }
    chunk.lit = true;

    // 2) 天空光种子：只把影子边界放进队列
    //    边界格若外侧没有更暗的已点亮邻居，推入也只会被立即丢弃，这里直接过滤。
    for (let y = 0; y < H; y++) {
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const idx = chunk.idx(lx, y, lz);
          const level = chunk.sky[idx];
          if (level <= 1) continue;
          const left = lx > 0 ? chunk.sky[idx - 1] : 16;
          const right = lx < CS - 1 ? chunk.sky[idx + 1] : 16;
          const back = lz > 0 ? chunk.sky[idx - CS] : 16;
          const front = lz < CS - 1 ? chunk.sky[idx + CS] : 16;
          const below = y > 0 ? chunk.sky[idx - CS * CS] : 16;
          let seed = left < level - 1 || right < level - 1 || back < level - 1 ||
            front < level - 1 || below < level - 1;
          // 边界格：只有能照亮外侧已点亮的邻居时才需要作为种子（角格两侧都查）
          if (!seed && lx === 0) seed = this.borderSkyImproves(x0 - 1, y, z0 + lz, level);
          if (!seed && lx === CS - 1) seed = this.borderSkyImproves(x0 + CS, y, z0 + lz, level);
          if (!seed && lz === 0) seed = this.borderSkyImproves(x0 + lx, y, z0 - 1, level);
          if (!seed && lz === CS - 1) seed = this.borderSkyImproves(x0 + lx, y, z0 + CS, level);
          if (seed) this.skyQ.push(x0 + lx, y, z0 + lz, level);
        }
      }
    }

    // 3) 方块光种子
    for (let y = 0; y < H; y++) {
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const idx = chunk.idx(lx, y, lz);
          const id = chunk.data[idx];
          if (id === AIR) continue;
          const emission = this.world.registry.get(id).lightEmission;
          if (emission > 0) {
            chunk.block[idx] = emission;
            this.blockQ.push(x0 + lx, y, z0 + lz, emission);
          }
        }
      }
    }

    // 4) 邻区块边界种子：让已有光扩散进新区块
    //    只推「确实能提升本块边界格」的源，避免每次初始化都空转 4×80×16 个种子。
    for (const [dx, dz] of HORIZ) {
      const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n || !n.lit) continue;
      for (let i = 0; i < CS; i++) {
        const lx = dx !== 0 ? (dx > 0 ? 0 : CS - 1) : i;
        const lz = dz !== 0 ? (dz > 0 ? 0 : CS - 1) : i;
        // 邻块光源进入本块只可能是这一格
        const tx = dx !== 0 ? (dx > 0 ? CS - 1 : 0) : i;
        const tz = dz !== 0 ? (dz > 0 ? CS - 1 : 0) : i;
        const wx = n.cx * CS + lx;
        const wz = n.cz * CS + lz;
        for (let y = 0; y < H; y++) {
          const idx = n.idx(lx, y, lz);
          const tIdx = chunk.idx(tx, y, tz);
          const sl = n.sky[idx];
          if (sl > 1) {
            const cost = this.opacity(chunk.data[tIdx]);
            if (cost < 16 && sl - cost > chunk.sky[tIdx]) this.skyQ.push(wx, y, wz, sl);
          }
          const bl = n.block[idx];
          if (bl > 1) {
            const cost = this.opacity(chunk.data[tIdx]);
            if (cost < 16 && bl - cost > chunk.block[tIdx]) this.blockQ.push(wx, y, wz, bl);
          }
        }
      }
    }

    this.runSky();
    this.runBlock();
    this.flush();
  }

  /** 方块变化后的增量光照更新 */
  updateBlock(x: number, y: number, z: number, oldId: BlockId, newId: BlockId) {
    const oldDef = this.world.registry.get(oldId);
    const newDef = this.world.registry.get(newId);
    const oldCost = this.opacity(oldId);
    const newCost = this.opacity(newId);

    // 方块光：移除旧光源，或遮挡变强时清掉本格残留光
    if (oldDef.lightEmission > 0 || newCost > oldCost) this.removeLight(false, x, y, z);
    if (newDef.lightEmission > 0) {
      const chunk = this.chunkAt(x >> 4, z >> 4);
      if (chunk && chunk.lit) {
        const idx = chunk.idx(x & 15, y, z & 15);
        chunk.block[idx] = newDef.lightEmission;
        this.touched.add(chunkKey(chunk.cx, chunk.cz));
        this.blockQ.push(x, y, z, newDef.lightEmission);
      }
    }

    // 天空光：判据必须是「竖向衰减」而不是遮光性——空气与树叶/水的 opacity 同为 1，
    // 但列衰减 0 vs 1，若只比 opacity，树叶落进光井时亮度不会下降。
    const oldCol = this.columnCost(oldId);
    const newCol = this.columnCost(newId);
    if (newCol > oldCol) {
      // 变暗：逐格回收「依赖这一格」的旧光。只清本列会漏掉水平扩散出去的格子
      // （封住天窗房间依旧亮堂），只回收起点又会漏掉光井里等亮度的整列梯度。
      this.removeSkyColumn(x, z, y);
      if (newCost < 16) this.refillSkyColumn(x, z, y);
    } else if (newCol < oldCol) {
      this.refillSkyColumn(x, z, y);
    }

    // 非遮挡方块：允许六邻居的光流进来
    if (newCost < 16) this.seedNeighbors(x, y, z);

    this.runSky();
    this.runBlock();
    this.flush();
  }

  // ---------- 内部 ----------

  private chunkAt(cx: number, cz: number): Chunk | undefined {
    if (cx === this.cacheCx && cz === this.cacheCz) return this.cacheChunk;
    this.cacheCx = cx;
    this.cacheCz = cz;
    this.cacheChunk = this.world.getChunk(cx, cz);
    return this.cacheChunk;
  }

  /** BFS 传播时的衰减；不透明方块返回 16（不可进入） */
  private opacity(id: BlockId): number {
    if (id === AIR) return 1;
    if (id >= 0 && id < 256) {
      const cached = this.costCache[id];
      if (cached !== 255) return cached;
    }
    const def = this.world.registry.get(id);
    const cost = def.opaque ? 16 : def.liquid ? 2 : 1;
    if (id >= 0 && id < 256) this.costCache[id] = cost;
    return cost;
  }

  /** 天空光直射列的衰减：空气不衰减，水和树叶衰减 */
  private columnCost(id: BlockId): number {
    return id === AIR ? 0 : this.opacity(id);
  }

  private isEmitter(id: BlockId, level: number): boolean {
    if (id === AIR) return false;
    return this.world.registry.get(id).lightEmission >= level;
  }

  /**
   * 边界种子过滤：外侧格已点亮、可进入且会被 `level` 提升时，才把本格推入队列。
   * 未点亮的区块不参与 BFS（等它初始化时从本块反向播种）。
   */
  private borderSkyImproves(wx: number, y: number, wz: number, level: number): boolean {
    const nc = this.chunkAt(wx >> 4, wz >> 4);
    if (!nc || !nc.lit) return false;
    const idx = nc.idx(wx & 15, y, wz & 15);
    const cost = this.opacity(nc.data[idx]);
    if (cost >= 16) return false;
    return level - cost > nc.sky[idx];
  }

  private runSky() {
    const q = this.skyQ;
    let head = 0;
    while (head < q.length) {
      const x = q[head++];
      const y = q[head++];
      const z = q[head++];
      const level = q[head++];
      if (level <= 1) continue;
      // 队列里可能记录的是回收之前的旧亮度（先播种、后被 removeLight 调低），
      // 这类陈旧种子会把已经暗下去的格子重新点亮，必须在出队时校验当前值。
      const sc = this.chunkAt(x >> 4, z >> 4);
      if (!sc || !sc.lit) continue;
      if (sc.sky[sc.idx(x & 15, y, z & 15)] < level) continue;
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (ny < 0 || ny >= H) continue;
        const nc = this.chunkAt(nx >> 4, nz >> 4);
        if (!nc || !nc.lit) continue;
        const nidx = nc.idx(nx & 15, ny, nz & 15);
        const cost = this.opacity(nc.data[nidx]);
        if (cost >= 16) continue;
        const next = level - cost;
        if (next <= 0 || next <= nc.sky[nidx]) continue;
        nc.sky[nidx] = next;
        this.touched.add(chunkKey(nc.cx, nc.cz));
        q.push(nx, ny, nz, next);
      }
    }
    q.length = 0;
  }

  private runBlock() {
    const q = this.blockQ;
    let head = 0;
    while (head < q.length) {
      const x = q[head++];
      const y = q[head++];
      const z = q[head++];
      const level = q[head++];
      if (level <= 1) continue;
      // 同 runSky：出队时校验本格当前亮度，丢弃回收前留下的陈旧种子
      const sc = this.chunkAt(x >> 4, z >> 4);
      if (!sc || !sc.lit) continue;
      if (sc.block[sc.idx(x & 15, y, z & 15)] < level) continue;
      for (const [dx, dy, dz] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (ny < 0 || ny >= H) continue;
        const nc = this.chunkAt(nx >> 4, nz >> 4);
        if (!nc || !nc.lit) continue;
        const nidx = nc.idx(nx & 15, ny, nz & 15);
        const cost = this.opacity(nc.data[nidx]);
        if (cost >= 16) continue;
        const next = level - cost;
        if (next <= 0 || next <= nc.block[nidx]) continue;
        nc.block[nidx] = next;
        this.touched.add(chunkKey(nc.cx, nc.cz));
        q.push(nx, ny, nz, next);
      }
    }
    q.length = 0;
  }

  /** 标准「移除 + 边界重扩散」 */
  private removeLight(sky: boolean, x: number, y: number, z: number) {
    const chunk = this.chunkAt(x >> 4, z >> 4);
    if (!chunk || !chunk.lit) return;
    const index = chunk.idx(x & 15, y, z & 15);
    const arr = sky ? chunk.sky : chunk.block;
    const level = arr[index];
    if (level === 0) return;
    arr[index] = 0;
    this.touched.add(chunkKey(chunk.cx, chunk.cz));

    const addQ = sky ? this.skyQ : this.blockQ;
    const q = [x, y, z, level];
    let head = 0;
    while (head < q.length) {
      const px = q[head++];
      const py = q[head++];
      const pz = q[head++];
      const pl = q[head++];
      for (const [dx, dy, dz] of DIRS) {
        const nx = px + dx;
        const ny = py + dy;
        const nz = pz + dz;
        if (ny < 0 || ny >= H) continue;
        const nc = this.chunkAt(nx >> 4, nz >> 4);
        if (!nc || !nc.lit) continue;
        const nidx = nc.idx(nx & 15, ny, nz & 15);
        const nArr = sky ? nc.sky : nc.block;
        const nl = nArr[nidx];
        if (nl === 0) continue;
        if (nl < pl && !this.isEmitter(nc.data[nidx], nl)) {
          nArr[nidx] = 0;
          this.touched.add(chunkKey(nc.cx, nc.cz));
          q.push(nx, ny, nz, nl);
        } else {
          // 独立光源或更亮的边界：稍后从这里重新扩散
          addQ.push(nx, ny, nz, nl);
        }
      }
    }
  }

  /**
   * 遮挡变强时沿列逐格回收天空光。
   * 光井里相邻两格常常「等亮度」（都是 15），removeLight 的严格小于判据无法沿列推进，
   * 因此这里沿列逐格调用 removeLight，既收掉列内梯度，也让每格各自回收水平依赖。
   */
  private removeSkyColumn(x: number, z: number, fromY: number) {
    const chunk = this.chunkAt(x >> 4, z >> 4);
    if (!chunk || !chunk.lit) return;
    const lx = x & 15;
    const lz = z & 15;
    for (let y = fromY; y >= 0; y--) {
      if (chunk.sky[chunk.idx(lx, y, lz)] === 0) break;
      this.removeLight(true, x, y, z);
    }
  }

  /** 移除遮挡后：按列重新填入天空光，并作为水平扩散种子 */
  private refillSkyColumn(x: number, z: number, fromY: number) {
    const chunk = this.chunkAt(x >> 4, z >> 4);
    if (!chunk || !chunk.lit) return;
    const lx = x & 15;
    const lz = z & 15;
    let level = fromY + 1 >= H ? 15 : chunk.sky[chunk.idx(lx, fromY + 1, lz)];
    if (level === 0) return;
    for (let y = fromY; y >= 0; y--) {
      const idx = chunk.idx(lx, y, lz);
      const cost = this.columnCost(chunk.data[idx]);
      if (cost >= 16) break;
      level -= cost;
      if (level <= 0) break;
      if (chunk.sky[idx] < level) {
        chunk.sky[idx] = level;
        this.touched.add(chunkKey(chunk.cx, chunk.cz));
        this.skyQ.push(x, y, z, level);
      }
    }
  }

  private seedNeighbors(x: number, y: number, z: number) {
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny < 0 || ny >= H) continue;
      const nc = this.chunkAt(nx >> 4, nz >> 4);
      if (!nc || !nc.lit) continue;
      const idx = nc.idx(nx & 15, ny, nz & 15);
      const sl = nc.sky[idx];
      if (sl > 1) this.skyQ.push(nx, ny, nz, sl);
      const bl = nc.block[idx];
      if (bl > 1) this.blockQ.push(nx, ny, nz, bl);
    }
  }

  private flush() {
    if (this.touched.size === 0) return;
    for (const key of this.touched) this.world.dirty.add(key);
    this.touched.clear();
  }
}
