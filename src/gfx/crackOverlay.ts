import * as THREE from 'three';
import {
  blockKey, CRACK_STAGES, mulberry32, quantizeCrackStage,
  type CrackStage,
} from '../core/types';

// 阶段常量与量化函数从此模块一并导出，供渲染层与外部诊断统一引用；
// 实际定义在 core/types.ts（纯逻辑，可在无 WebGL 的 Node 回归里直接 require）。
export { CRACK_STAGES, quantizeCrackStage };
export type { CrackStage };

/** 裂痕目标方块（世界坐标） */
export interface CrackTarget {
  x: number;
  y: number;
  z: number;
}

const TILE = 64;
const ATLAS_W = CRACK_STAGES * TILE;

/**
 * 确定性裂纹线段：从中心向外放射，阶段 n 只画前 ceil(n/9 * 总数) 条，
 * 因此阶段之间严格「只增不减」，不会出现裂纹突然换形状导致的闪烁。
 */
const CRACK_LINES = (() => {
  const rnd = mulberry32(0x5eed1234);
  const lines: { angle: number; reach: number; bend: number; width: number }[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push({
      angle: (i / 30) * Math.PI * 2 + (rnd() - 0.5) * 0.3,
      reach: 0.2 + rnd() * 0.34,
      bend: (rnd() - 0.5) * 0.5,
      width: 1.1 + rnd() * 1.3,
    });
  }
  return lines;
})();

/** 程序化绘制 10 格横向裂痕图集（零外部资源） */
function buildCrackTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, ATLAS_W, TILE);
    for (let stage = 1; stage < CRACK_STAGES; stage++) {
      ctx.save();
      ctx.translate(stage * TILE, 0);
      const grow = stage / (CRACK_STAGES - 1);
      const count = Math.ceil(grow * CRACK_LINES.length);

      // 中心破损块：随阶段缓慢扩大，作为裂纹的汇聚点
      ctx.fillStyle = 'rgba(10, 10, 12, 0.78)';
      const core = 1.6 + grow * 4.6;
      ctx.fillRect(TILE / 2 - core / 2, TILE / 2 - core / 2, core, core);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < count; i++) {
        const seg = CRACK_LINES[i];
        const r = seg.reach * TILE;
        const cx = TILE / 2;
        const cy = TILE / 2;
        const mx = cx + Math.cos(seg.angle) * r * 0.48 - Math.sin(seg.angle) * seg.bend * r * 0.2;
        const my = cy + Math.sin(seg.angle) * r * 0.48 + Math.cos(seg.angle) * seg.bend * r * 0.2;
        const ex = cx + Math.cos(seg.angle + seg.bend * 0.24) * r;
        const ey = cy + Math.sin(seg.angle + seg.bend * 0.24) * r;
        ctx.strokeStyle = 'rgba(8, 8, 10, 0.86)';
        ctx.lineWidth = seg.width;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(mx, my);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // 高阶段追加分叉，密度继续上升
        if (stage >= 5 && i % 3 === 0) {
          ctx.lineWidth = seg.width * 0.62;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(mx + Math.cos(seg.angle + 1.1) * r * 0.26, my + Math.sin(seg.angle + 1.1) * r * 0.26);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * N3 挖掘裂痕覆盖层：单个 Mesh + 每帧 set(target, stage)。
 * 只在目标方块或阶段号变化时改位置 / UV；每帧不写 DOM、不重绘纹理。
 */
export class CrackOverlay {
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.CanvasTexture;
  private readonly baseUV: Float32Array;
  private currentKey = '';
  private currentStage = -1;

  constructor(scene: THREE.Scene) {
    this.texture = buildCrackTexture();
    this.geometry = new THREE.BoxGeometry(1.004, 1.004, 1.004);
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.baseUV = Float32Array.from(uv.array as Float32Array);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.94,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5; // 高于 BlockHighlight 的 4
    scene.add(this.mesh);
  }

  /** target 为空 / stage=0 时整层立即清除；否则跟随目标并只在阶段变化时换 UV */
  set(target: CrackTarget | null, stage: CrackStage): void {
    if (!target || stage <= 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      this.currentKey = '';
      this.currentStage = -1;
      return;
    }
    const key = blockKey(target.x, target.y, target.z);
    if (key !== this.currentKey) {
      this.mesh.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
      this.currentKey = key;
    }
    if (stage !== this.currentStage) {
      this.applyStage(stage);
      this.currentStage = stage;
    }
    if (!this.mesh.visible) this.mesh.visible = true;
  }

  private applyStage(stage: CrackStage): void {
    const uv = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const array = uv.array as Float32Array;
    // 每格左右各留 2% 边距，避免过滤时采到相邻阶段的裂纹
    const u0 = (stage + 0.02) / CRACK_STAGES;
    const du = 0.96 / CRACK_STAGES;
    for (let i = 0; i < array.length; i += 2) array[i] = u0 + this.baseUV[i] * du;
    uv.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
