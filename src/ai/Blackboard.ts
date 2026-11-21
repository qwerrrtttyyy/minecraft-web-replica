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
}
