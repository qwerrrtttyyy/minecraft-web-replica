import { meshChunk } from './mesher';
import { SnapshotMeshSource } from './snapshotSource';
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
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
      mesh,
      stats: out.stats,
    }, transfer);
  } catch (err) {
    post({
      type: 'error',
      wid: msg.wid,
      cx: msg.cx,
      cz: msg.cz,
      generation: msg.generation,
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
  if (msg.type === 'mesh') {
    if (!config) { queued.push(msg); return; }
    runMesh(msg);
  }
};
