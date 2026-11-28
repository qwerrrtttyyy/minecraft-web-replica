/**
 * 高性能服务体系（v1.6）：帧预算调度器 + 性能监控服务。
 *
 * - `PerfService`：逐系统每帧耗时采样（p50/p95/max），F3 与运行时诊断的数据源。
 * - `FrameScheduler`：分阶段 / 优先级 / 软帧预算的系统调度，弱机先保关键路径。
 *
 * 两者均为纯逻辑（只依赖 `performance.now`），不 import three / DOM，可在 Node 侧回归。
 */
export { PerfService } from './PerfService';
export type { SystemPerf, PerfStats, PerfReport } from './PerfService';
export { FrameScheduler, SYSTEM_PHASES } from './FrameScheduler';
export type {
  SystemSpec, SystemPhase, SystemTier, SchedulerStats, SchedulerSlotStats,
} from './FrameScheduler';
