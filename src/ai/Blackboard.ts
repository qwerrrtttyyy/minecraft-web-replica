import { bool, num, vec3, type Vec3Like } from './types';

/** 实体级黑板：行为树节点间共享的键值状态，读档后重置。 */
export class Blackboard {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.map.has(key)) {
      return this.map.get(key) as T;
    }
    return defaultValue;
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  del(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 类型化数字读取：非法/缺失值回退到 fallback。 */
  getNumber(key: string, fallback = 0): number {
    return num(this.get(key), fallback);
  }

  /** 类型化布尔读取：非法/缺失值回退到 fallback。 */
  getBoolean(key: string, fallback = false): boolean {
    return bool(this.get(key), fallback);
  }

  /** 类型化三维向量读取：非法/缺失值回退到 fallback。 */
  getVec3(key: string, fallback: Vec3Like = { x: 0, y: 0, z: 0 }): Vec3Like {
    return vec3(this.get(key), fallback);
  }
}
