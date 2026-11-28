import { makeNoiseFunctions, makePermutation, type NoiseBackend, type NoiseFunctions } from './noiseMath';

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
    return b ? b.fbm2(x, y, octaves, lacunarity, gain) : this.js.fbm2(x, y, octaves, lacunarity, gain);
  }

  /**
   * 脊线噪声：把 1-|n| 平方后叠加，输出 0~1。
   * 高值形成连续的山脊 / 河道轮廓，比普通 fBm 更像真实地貌。
   */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    const b = this.backend;
    return b ? b.ridged2(x, y, octaves, lacunarity, gain) : this.js.ridged2(x, y, octaves, lacunarity, gain);
  }

  /** 3D 分形叠加（洞穴 / 矿脉等体积特征） */
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    const b = this.backend;
    return b ? b.fbm3(x, y, z, octaves, lacunarity, gain) : this.js.fbm3(x, y, z, octaves, lacunarity, gain);
  }
}

export type { NoiseBackend, NoiseFunctions } from './noiseMath';
