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

const post = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) => {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void })
    .postMessage(msg, transfer);
};

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'config') {
    config = msg.config;
    return;
  }
  if (msg.type === 'mesh') {
    if (!config) {
      post({ type: 'error', wid: msg.wid, cx: msg.cx, cz: msg.cz, generation: msg.generation, message: 'mesh config 尚未就绪' });
      return;
    }
    try {
      const src = new SnapshotMeshSource(config, msg.snapshot);
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
  }
};
