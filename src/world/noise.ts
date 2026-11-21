import {
  makeNoiseFunctions, makePermutation, NOISE_BATCH_CAPACITY,
  type NoiseBackend, type NoiseBatchKind, type NoiseBatchOptions, type NoiseFunctions,
} from './noiseMath';

/**
 * 可播种的 2D / 3D 值噪声 + 分形叠加（fBm）。
 * 无第三方依赖，地形、洞穴、云、纹理共用。
 *
 * v1.5.0：数学实现抽到 noiseMath.ts 作为唯一 JS 参考；此处只保留「后端选择」——
 * 默认走 JS（行为与 v1.4.3 逐位一致），WasmRuntime 在通过等价性自检后可安装
 * WASM 后端工厂，之后创建的 Noise 实例自动切换到 WebAssembly 计算。
 * 后端运行期抛错会由后端自身回退到同一份 JS 参考，绝不会让地形生成崩溃。
 */

/** 由 WasmRuntime 安装：每个 Noise 实例创建一份独立后端（各自持有独立 WASM linear memory） */
export type NoiseBackendFactory = (perm: Uint8Array) => NoiseBackend | null;

let backendFactory: NoiseBackendFactory | null = null;

/**
 * 批量采样总开关。默认开启；`?wasmBatch=0` 会在启动时关掉，
 * 回到逐点调用形态，用于在真实场景里做 A/B 对照。
 */
let batchEnabled = true;

export function setNoiseBatchEnabled(v: boolean): void {
  batchEnabled = v;
}

export function isNoiseBatchEnabled(): boolean {
  return batchEnabled;
}

export function installNoiseBackend(factory: NoiseBackendFactory | null): void {
  backendFactory = factory;
}

export function getNoiseBackendFactory(): NoiseBackendFactory | null {
  return backendFactory;
}

export class Noise {
  private perm: Uint8Array;
  private js: NoiseFunctions;
  private backend: NoiseBackend | null;

  constructor(seed: number) {
    this.perm = makePermutation(seed);
    this.js = makeNoiseFunctions(this.perm);
    let backend: NoiseBackend | null = null;
    if (backendFactory) {
      try {
        backend = backendFactory(this.perm);
      } catch (e) {
        // 单个实例创建失败不能拖垮世界生成；后续调用全部走 JS 参考
        console.warn('[noise] WASM 后端创建失败，已回退 JS', e);
      }
    }
    this.backend = backend;
  }

  /** 2D 值噪声，返回 [-1, 1] */
  noise2(x: number, y: number): number {
    const b = this.backend;
    return b ? b.noise2(x, y) : this.js.noise2(x, y);
  }

  /** 3D 值噪声，返回 [-1, 1] */
  noise3(x: number, y: number, z: number): number {
    const b = this.backend;
    return b ? b.noise3(x, y, z) : this.js.noise3(x, y, z);
  }

  /** 分形叠加 */
  fbm2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    const b = this.backend;
    return b
      ? b.fbm2(x, y, octaves, lacunarity, gain)
      : this.js.fbm2(x, y, octaves, lacunarity, gain);
  }

  /**
   * 脊线噪声：把 1-|n| 平方后叠加，输出 0~1。
   * 高值形成连续的山脊 / 河道轮廓，比普通 fBm 更像真实地貌。
   */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    const b = this.backend;
    return b
      ? b.ridged2(x, y, octaves, lacunarity, gain)
      : this.js.ridged2(x, y, octaves, lacunarity, gain);
  }

  /** 3D 分形叠加（洞穴 / 矿脉等体积特征） */
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    const b = this.backend;
    return b
      ? b.fbm3(x, y, z, octaves, lacunarity, gain)
      : this.js.fbm3(x, y, z, octaves, lacunarity, gain);
  }

  /**
   * 批量求值：coords 每 3 个 f64 一个点，结果写入 out[0..count)。
   * WASM 后端一次跨界算完整批；无后端或后端异常时走同一份 JS 参考，输出逐位一致。
   */
  batch(
    kind: NoiseBatchKind, coords: Float64Array, count: number, out: Float64Array,
    opts?: NoiseBatchOptions,
  ): number {
    // 参数错误在公共入口就拦下：内核的 bad-arguments 不该被当成运行期故障，
    // 更不该因此把 WASM 后端永久降级
    if (!Number.isInteger(count) || count < 0 || count > NOISE_BATCH_CAPACITY) {
      throw new RangeError(`批量点数 ${count} 超出 [0, ${NOISE_BATCH_CAPACITY}]`);
    }
    if (coords.length < count * 3 || out.length < count) {
      throw new RangeError(`batch 缓冲区不足：count=${count} coords=${coords.length} out=${out.length}`);
    }
    if (!batchEnabled) return this.batchPointwise(kind, coords, count, out, opts);
    const b = this.backend;
    if (b) {
      try {
        return b.batch(kind, coords, count, out, opts);
      } catch (e) {
        // 后端自身已有 guard；这里只兜住实例创建后被外部销毁等边界情况
        console.warn('[noise] WASM 批量调用失败，已回退 JS', e);
      }
    }
    return this.js.batch(kind, coords, count, out, opts);
  }

  /** `?wasmBatch=0` 对照路径：逐点走同一套公开方法，模拟批量接口引入前的调用形态 */
  private batchPointwise(
    kind: NoiseBatchKind, coords: Float64Array, count: number, out: Float64Array,
    opts?: NoiseBatchOptions,
  ): number {
    const o = opts?.octaves ?? 1;
    const l = opts?.lacunarity ?? 2;
    const g = opts?.gain ?? 0.5;
    for (let i = 0; i < count; i++) {
      const x = coords[i * 3];
      const y = coords[i * 3 + 1];
      const z = coords[i * 3 + 2];
      switch (kind) {
        case 'noise2': out[i] = this.noise2(x, y); break;
        case 'noise3': out[i] = this.noise3(x, y, z); break;
        case 'fbm2': out[i] = this.fbm2(x, y, o, l, g); break;
        case 'fbm3': out[i] = this.fbm3(x, y, z, o, l, g); break;
        case 'ridged2': out[i] = this.ridged2(x, y, o, l, g); break;
      }
    }
    return count;
  }
}

export type { NoiseBackend, NoiseBatchKind, NoiseBatchOptions, NoiseFunctions } from './noiseMath';
export { NOISE_BATCH_CAPACITY } from './noiseMath';
