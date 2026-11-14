/**
 * Worker 池构造（纯逻辑，不依赖 three / DOM，便于注入 mock 做回归）。
 *
 * 契约：池中任一 Worker 构造失败时，不保留「部分可用」的残缺池——
 * 已建实例全部 terminate，返回 partial=true，由调用方统一回退主线程同步网格化。
 * 修复「构造 catch 只打日志、实际仍以 worker 模式带残池运行」的问题。
 */
export interface Terminable {
  terminate(): void;
}

export interface WorkerPoolResult<W extends Terminable> {
  /** 构造成功的实例；partial=true 时恒为空数组 */
  workers: W[];
  /** 构造期出现失败（含一个都没建成 / want<=0） */
  partial: boolean;
}

/**
 * 按 want 逐个构造；任一失败即整体回滚。
 * 运行期失败（onerror）由调用方挂接，不在本函数职责内。
 */
export function createWorkerPool<W extends Terminable>(
  Ctor: new () => W,
  want: number,
): WorkerPoolResult<W> {
  const workers: W[] = [];
  for (let i = 0; i < want; i++) {
    try {
      workers.push(new Ctor());
    } catch {
      for (const w of workers) {
        try { w.terminate(); } catch { /* 已销毁 */ }
      }
      return { workers: [], partial: true };
    }
  }
  return { workers, partial: workers.length === 0 };
}
