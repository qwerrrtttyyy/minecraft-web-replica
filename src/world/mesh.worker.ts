import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import { meshChunk } from './mesher';
import { SnapshotMeshSource } from './snapshotSource';
import { blockIdSource, DefaultGenerator } from './generator';
import {
  packMesh,
  type MeshConfig, type WorkerRequest, type WorkerResponse,
} from './meshTypes';

/**
 * 网格化 Worker：只依赖纯数据，不 import three / World / TextureAtlas。
 * 打包为 ?worker&inline（Blob Worker），才能在 vite-plugin-singlefile 产出的
 * 单文件 HTML + file:// 协议下创建。
 */

let config: MeshConfig | null = null;
/** config 下发前到达的 mesh 请求先排队：运行期重建 Worker 池时不再报「配置未就绪」 */
const queued: Extract<WorkerRequest, { type: 'mesh' }>[] = [];

// ---- 地形生成（只算 data；光照初始化由主线程 initChunk 完成）----
let generator: DefaultGenerator | null = null;
/** genConfig 初始化失败标记：后续 gen 请求直接报错退回，不再无限排队 */
let genFailed = false;
/** genConfig 下发 / 初始化完成前到达的 gen 请求先排队，语义与 mesh 队列一致 */
const queuedGen: Extract<WorkerRequest, { type: 'gen' }>[] = [];

const post = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) => {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void })
    .postMessage(msg, transfer);
};

const runMesh = (msg: Extract<WorkerRequest, { type: 'mesh' }>) => {
  try {
    const src = new SnapshotMeshSource(config as MeshConfig, msg.snapshot);
    const out = meshChunk(src);
    const { mesh, transfer } = packMesh(out);
    post({
      type: 'result',
      channel: 'mesh',
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
      configRevision: msg.configRevision,
      mesh,
      stats: out.stats,
    }, transfer);
  } catch (err) {
    post({
      type: 'error',
      channel: 'mesh',
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
      configRevision: msg.configRevision,
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    });
  }
};

/** 跑一次地形生成：整块 data 转移回主线程，不在 Worker 内保留区块状态 */
const runGen = (msg: Extract<WorkerRequest, { type: 'gen' }>) => {
  try {
    const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    generator!.generateChunk(msg.cx, msg.cz, data);
    post({
      type: 'genResult',
      channel: 'gen',
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
      data,
    }, [data.buffer]);
  } catch (err) {
    post({
      type: 'error',
      channel: 'gen',
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
      configRevision: 0,
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    });
  }
};

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'config') {
    config = msg.config;
    // 回执让主线程能确认每个 Worker 都拿到了当前 revision（运行时诊断用）
    post({ type: 'config-ack', wid: msg.wid, revision: msg.config.revision });
    while (queued.length) runMesh(queued.shift() as Extract<WorkerRequest, { type: 'mesh' }>);
    return;
  }
  if (msg.type === 'genConfig') {
    try {
      // Worker 内没有 BlockRegistry / WASM 后端：JS 噪声参考与主线程逐位等价
      generator = new DefaultGenerator(
        msg.config.seed,
        blockIdSource(msg.config.ids),
        msg.config.options,
      );
    } catch (err) {
      generator = null;
      genFailed = true;
      // 初始化失败：已排队的请求逐个报错退回；即使队列为空也要回一条，
      // 否则主线程永远收不到失败信号，后续请求会一直堆在队列里
      const reason = `genConfig 初始化失败: ${err instanceof Error ? err.message : String(err)}`;
      for (const q of queuedGen) {
        post({ type: 'error', channel: 'gen', wid: q.wid, cx: q.cx, cz: q.cz, generation: q.generation, configRevision: 0, message: reason });
      }
      queuedGen.length = 0;
      post({ type: 'error', channel: 'gen', wid: msg.wid, cx: 0, cz: 0, generation: 0, configRevision: 0, message: reason });
      return;
    }
    while (queuedGen.length) runGen(queuedGen.shift() as Extract<WorkerRequest, { type: 'gen' }>);
    return;
  }
  if (msg.type === 'mesh') {
    if (!config) { queued.push(msg); return; }
    runMesh(msg);
    return;
  }
  if (msg.type === 'gen') {
    if (genFailed) {
      post({
        type: 'error', channel: 'gen', wid: msg.wid, cx: msg.cx, cz: msg.cz,
        generation: msg.generation, configRevision: 0,
        message: 'genConfig 初始化失败，生成器不可用',
      });
      return;
    }
    if (!generator) { queuedGen.push(msg); return; }
    runGen(msg);
  }
};
