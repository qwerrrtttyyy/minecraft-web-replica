/**
 * 兼容垫片（v1.2.0）。
 *
 * 事件总线的实现已独立为 `src/services/events/` 中的 EventService 服务，
 * 本文件只做再导出，供尚未迁移的旧代码与纯逻辑测试快照（test/logic/core/events.js）使用。
 * 新代码请直接 `import { EventService } from '../services/events'`。
 *
 * @deprecated 使用 services/events 替代
 */
export { EventService, EventService as EventBus, EventChannel } from '../services/events';
export type { GameEvents, EventStats, EventErrorInfo, AnyEventHandler } from '../services/events';
