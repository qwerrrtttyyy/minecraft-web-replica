import * as THREE from 'three';
import { CHUNK_SIZE, chunkKey, type System } from '../core/types';
import type { EventBus } from '../core/events';
import type { World } from './world';
import { meshChunk, type GeoArrays } from './mesher';
import type { TextureAtlas } from '../gfx/atlas';

interface ChunkMeshes {
  opaque?: THREE.Mesh;
  emissive?: THREE.Mesh;
  transparent?: THREE.Mesh;
  water?: THREE.Mesh;
}

const buildGeo = (a: GeoArrays): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.positions, 3));
  // 四个通道都是 MeshBasicMaterial，法线不被使用，不再上传可省约 25% 顶点内存
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(a.colors, 3));
  g.setAttribute('aLight', new THREE.Float32BufferAttribute(a.lights, 2));
  g.setIndex(a.indices);
  g.computeBoundingSphere();
  return g;
};

/** 把天空光/方块光注入 MeshBasicMaterial：天空光随昼夜变化，方块光恒定 */
interface ChunkShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

function injectLight(shader: ChunkShader, daylight: { value: number }) {
  shader.uniforms.uDaylight = daylight;
  shader.vertexShader = 'attribute vec2 aLight;\nvarying vec2 vLight;\n' + shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\n  vLight = aLight;',
  );
  shader.fragmentShader = 'varying vec2 vLight;\nuniform float uDaylight;\n' + shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
    float lit = max(vLight.x * uDaylight, vLight.y);
    diffuseColor.rgb *= 0.07 + 0.93 * lit;`,
  );
}

/**
 * 区块流式加载：按玩家位置生成 / 网格化 / 卸载，
 * 每帧限时处理，避免卡顿。渲染距离可实时调节。
 */
export class ChunkManager implements System {
  readonly name = 'chunks';
  renderDistance: number;
  readonly materials: { opaque: THREE.MeshBasicMaterial; emissive: THREE.MeshBasicMaterial; transparent: THREE.MeshBasicMaterial; water: THREE.MeshBasicMaterial };
  /** 昼夜强度（0~1），由 Sky 每帧写入 shader */
  readonly lightUniform = { value: 1 };
  private waterTime = { value: 0 };
  private meshes = new Map<string, ChunkMeshes>();
  private centerX = 0;
  private centerZ = 0;
  private genSpiral: [number, number][] = [];
  private spiralRadius = -1;

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private atlas: TextureAtlas,
    private events: EventBus,
    renderDistance: number,
  ) {
    this.renderDistance = renderDistance;
    this.materials = {
      opaque: new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 }),
      emissive: new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 }),
      transparent: new THREE.MeshBasicMaterial({
        map: atlas.texture, vertexColors: true, transparent: true, opacity: 0.8,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      water: new THREE.MeshBasicMaterial({
        map: atlas.texture, vertexColors: true, transparent: true, opacity: 0.78,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    };
    // 不透明 / 半透明通道：烘焙光照 + 昼夜天空光
    for (const mat of [this.materials.opaque, this.materials.transparent]) {
      mat.onBeforeCompile = (shader) => injectLight(shader, this.lightUniform);
    }
    // 水面：光照 + 世界坐标驱动的微波动画（跨区块连续）
    this.materials.water.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime;
      injectLight(shader, this.lightUniform);
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
        transformed.y += sin(wPos.x * 0.9 + uTime * 1.7) * 0.028 + cos(wPos.z * 1.1 + uTime * 1.3) * 0.028;`,
      );
    };
  }

  get meshCount() {
    return this.meshes.size;
  }

  setCenter(x: number, z: number) {
    this.centerX = Math.floor(x / CHUNK_SIZE);
    this.centerZ = Math.floor(z / CHUNK_SIZE);
  }

  /** 生成螺旋顺序（由近及远） */
  private spiral(radius: number): [number, number][] {
    if (this.spiralRadius === radius) return this.genSpiral;
    const list: [number, number][] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz <= radius * radius + 1) list.push([dx, dz]);
      }
    }
    list.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.genSpiral = list;
    this.spiralRadius = radius;
    return list;
  }

  update(dt: number) {
    this.waterTime.value += dt;
    const R = this.renderDistance;
    const cx = this.centerX;
    const cz = this.centerZ;

    // 1) 数据生成（整帧累计限时 4ms；t0 不能在循环内重置，否则预算只作用于单块）
    const genStart = performance.now();
    for (const [dx, dz] of this.spiral(R)) {
      const key = chunkKey(cx + dx, cz + dz);
      const chunk = this.world.getChunk(cx + dx, cz + dz);
      if (!chunk?.generated) {
        this.world.ensureChunk(cx + dx, cz + dz);
        // 新生成区块必须自己入队网格化，不能只依赖"邻居生成时顺带标脏"的副作用
        this.world.dirty.add(key);
        if (performance.now() - genStart > 4) break;
      } else if (!this.meshes.has(key)) {
        // 已生成但还没有网格（例如脏标记曾被清理），重新入队
        this.world.dirty.add(key);
      }
    }

    // 2) 网格化（整帧累计限时 6ms，近处优先）
    if (this.world.dirty.size > 0) {
      const list: [number, number][] = [];
      for (const key of this.world.dirty) {
        const [x, z] = key.split(',').map(Number);
        if (Math.abs(x - cx) > R + 1 || Math.abs(z - cz) > R + 1) {
          // 远处脏标记直接丢弃，避免长期累积；靠近时会由第 1 步重新入队
          this.world.dirty.delete(key);
          continue;
        }
        list.push([x, z]);
      }
      list.sort((a, b) =>
        (a[0] - cx) ** 2 + (a[1] - cz) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cz) ** 2));
      const meshStart = performance.now();
      for (const [x, z] of list) {
        const key = chunkKey(x, z);
        // 未生成的区块保留脏标记等下一帧，避免先删标记后跳过导致边界面永久错
        if (!this.world.getChunk(x, z)?.generated) continue;
        this.world.dirty.delete(key);
        this.remesh(x, z);
        if (performance.now() - meshStart > 6) break;
      }
    }

    // 3) 卸载远处区块
    const limit = R + 2;
    for (const [key, m] of this.meshes) {
      const [x, z] = key.split(',').map(Number);
      if (Math.abs(x - cx) > limit || Math.abs(z - cz) > limit) {
        this.disposeMeshes(m);
        this.meshes.delete(key);
        this.world.chunks.delete(key);
        this.world.dirty.delete(key);
      }
    }
    // 生成过但从未网格化的远处区块也一并清理，防止内存增长
    for (const [key, chunk] of this.world.chunks) {
      if (this.meshes.has(key)) continue;
      const [x, z] = [chunk.cx, chunk.cz];
      if (Math.abs(x - cx) > limit || Math.abs(z - cz) > limit) this.world.chunks.delete(key);
    }
  }

  private disposeMeshes(m: ChunkMeshes) {
    for (const mesh of [m.opaque, m.emissive, m.transparent, m.water]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
  }

  private remesh(cx: number, cz: number) {
    const key = chunkKey(cx, cz);
    const old = this.meshes.get(key);
    if (old) this.disposeMeshes(old);
    const data = meshChunk(this.world, this.atlas, cx, cz);
    const entry: ChunkMeshes = {};
    const make = (a: GeoArrays | null, mat: THREE.Material, order: number) => {
      if (!a || a.indices.length === 0) return undefined;
      const mesh = new THREE.Mesh(buildGeo(a), mat);
      mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      return mesh;
    };
    entry.opaque = make(data.opaque, this.materials.opaque, 0);
    entry.emissive = make(data.emissive, this.materials.emissive, 0);
    entry.transparent = make(data.transparent, this.materials.transparent, 2);
    entry.water = make(data.water, this.materials.water, 2);
    this.meshes.set(key, entry);
    this.events.emit('chunk:meshed', { cx, cz });
  }

  /** 启动时同步预载出生点周围（带进度回调，异步让出主线程绘制加载条） */
  async initialLoad(x: number, z: number, radius: number, onProgress?: (p: number) => void) {
    this.setCenter(x, z);
    const cx = this.centerX;
    const cz = this.centerZ;
    const list = this.spiral(radius);
    for (let i = 0; i < list.length; i++) {
      const [dx, dz] = list[i];
      this.world.ensureChunk(cx + dx, cz + dz);
      if (i % 3 === 2) {
        onProgress?.((i + 1) / list.length * 0.5);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    for (let i = 0; i < list.length; i++) {
      const [dx, dz] = list[i];
      this.world.dirty.delete(chunkKey(cx + dx, cz + dz));
      this.remesh(cx + dx, cz + dz);
      if (i % 3 === 2) {
        onProgress?.(0.5 + (i + 1) / list.length * 0.5);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.world.dirty.clear();
    onProgress?.(1);
  }

  /** 切换渲染距离时清理多余网格 */
  setRenderDistance(r: number) {
    this.renderDistance = r;
    this.spiralRadius = -1;
  }
}