/**
 * 区块驻留（"chunk survival"）策略：纯数据决策，不依赖 World / three / DOM。
 *
 * 规则（三层）：
 * 1. `keepRadius` 内（切比雪夫距离）的区块永远保留 —— 它们是当前视距所需；
 * 2. 超出 `hardRadius` 的区块无条件卸载 —— 给内存和场景规模兜底；
 * 3. 两层之间是可回收缓冲区：总驻留超过 `maxResident` 时，按 `lastTouch`
 *    从旧到新淘汰，且必须已驻留满 `minResidencySec`。
 *
 * 排序用 (lastTouch, key) 双键，key 用字典序而非 localeCompare，保证跨环境确定性。
 */
export interface RetentionChunk {
  cx: number;
  cz: number;
  /** 逻辑时间（秒）：创建时刻 */
  createdAt: number;
  /** 逻辑时间（秒）：最近一次有意义访问 */
  lastTouch: number;
}

export interface RetentionOptions {
  centerX: number;
  centerZ: number;
  keepRadius: number;
  hardRadius: number;
  /** 总驻留上限；视距内区块优先保留，不因上限被淘汰 */
  maxResident: number;
  minResidencySec: number;
  now: number;
}

const compareKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 返回需要卸载的区块 key（已按淘汰顺序排列：强制卸载在前，LRU 次之） */
export function selectEvictions(
  chunks: Iterable<readonly [string, RetentionChunk]>,
  opts: RetentionOptions,
): string[] {
  const forced: string[] = [];
  const buffer: { key: string; touch: number; createdAt: number }[] = [];
  let kept = 0;

  for (const [key, c] of chunks) {
    const d = Math.max(Math.abs(c.cx - opts.centerX), Math.abs(c.cz - opts.centerZ));
    if (d <= opts.keepRadius) {
      kept++;
      continue;
    }
    if (d > opts.hardRadius) {
      forced.push(key);
      continue;
    }
    buffer.push({ key, touch: c.lastTouch, createdAt: c.createdAt });
  }

  // 上限只约束视距之外的缓冲区：视距本身超限时不淘汰视距内区块（否则会出现空洞）
  const budget = Math.max(0, opts.maxResident - kept);
  if (buffer.length <= budget) return forced;

  buffer.sort((a, b) => (a.touch - b.touch) || compareKey(a.key, b.key));
  let need = buffer.length - budget;
  for (const c of buffer) {
    if (need === 0) break;
    if (opts.now - c.createdAt < opts.minResidencySec) continue;
    forced.push(c.key);
    need--;
  }
  return forced;
}
