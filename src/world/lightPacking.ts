export type VertexLightMode = 'float2' | 'packed8';

export function packLightVertex(sky: number, block: number): number {
  const s = Math.max(0, Math.min(15, Math.round(sky * 15)));
  const b = Math.max(0, Math.min(15, Math.round(block * 15)));
  return s * 16 + b;
}

export function unpackLightVertex(packed: number): [number, number] {
  const v = Math.max(0, Math.min(255, packed | 0));
  return [(v >> 4) / 15, (v & 15) / 15];
}

export function packVertexLights(lights: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(lights.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = packLightVertex(lights[i * 2], lights[i * 2 + 1]);
  }
  return out;
}

export function unpackVertexLights(packed: ArrayLike<number>): Float32Array {
  const out = new Float32Array(packed.length * 2);
  for (let i = 0; i < packed.length; i++) {
    const [sky, block] = unpackLightVertex(packed[i]);
    out[i * 2] = sky;
    out[i * 2 + 1] = block;
  }
  return out;
}