import { mulberry32 } from '../core/types';
import { Blackboard } from './Blackboard';
import { TickContext } from './Node';

/** 把 (worldSeed, entityId, label) 混成一个 32 位种子，供 mulberry32 使用。 */
function hashSeed(worldSeed: number, entityId: number, label: string): number {
  let h = (worldSeed >>> 0) ^ (entityId >>> 0);
  for (let i = 0; i < label.length; i++) {
    h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** 构造一个最小的 TickContext（测试与 AIService 复用）。所有随机性经 rng，确定性可复现。 */
export function makeTickContext(opts: {
  worldSeed: number;
  entityId: number;
}): TickContext {
  const { worldSeed, entityId } = opts;
  const blackboard = new Blackboard();
  const rngCache = new Map<string, () => number>();
  const rng = (label = 'default'): number => {
    let r = rngCache.get(label);
    if (!r) {
      r = mulberry32(hashSeed(worldSeed, entityId, label));
      rngCache.set(label, r);
    }
    return r();
  };
  return {
    entity: { id: entityId, pos: { x: 0, y: 0, z: 0 }, type: { id: '' } },
    world: {
      getBlock: () => 0,
      isSolidAt: () => false,
      surfaceHeight: () => 0,
    },
    playerPos: { x: 0, y: 0, z: 0 },
    daylight: 1,
    playerDead: false,
    rng,
    events: { emit: () => undefined },
    api: undefined,
    blackboard,
    dt: 0,
  } as TickContext;
}
