import type * as THREE from 'three';

/**
 * Greedy Meshing 的图集 UV 平铺。
 *
 * 图集是单张 8×8 tile 纹理；合并后的大 quad 若直接把 UV 写成 0..w，
 * 会采样到相邻 tile。这里给几何体增加 aTileRect（每顶点 u0,v0,du,dv），
 * 在 fragment 里用 fract(局部 UV) 把采样限制在单个 tile 内并横向重复。
 *
 * 未合并的普通面局部 UV 为 0..1，fract 后几乎不变（末端做了 UV_EPS 内缩），
 * 因此四个渲染通道可以共用同一套注入逻辑，不需要两套材质。
 */

const VERT_PREAMBLE = `attribute vec4 aTileRect;
varying vec4 vTileRect;
`;

const FRAG_PREAMBLE = `varying vec4 vTileRect;
`;

const TILED_MAP_FRAGMENT = `
#ifdef USE_MAP
  vec2 tiledUv = vTileRect.xy + fract(vMapUv) * vTileRect.zw;
  vec4 sampledDiffuseColor = texture2D( map, tiledUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/**
 * 安装到材质上。会保留并串联已有的 onBeforeCompile（水面波动动画也用它），
 * 每个材质用独立 cache key，避免 water 与 opaque 复用同一编译结果。
 */
export function installTiledAtlas(mat: THREE.Material): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.vertexShader = VERT_PREAMBLE + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvTileRect = aTileRect;',
    );
    shader.fragmentShader = FRAG_PREAMBLE + shader.fragmentShader.replace(
      '#include <map_fragment>',
      TILED_MAP_FRAGMENT,
    );
  };
  // three 默认以 onBeforeCompile.toString() 作为 cache key；此处按材质实例区分，
  // 保证 water（额外顶点动画）与 opaque 不会误共享 program。
  mat.customProgramCacheKey = () => `tiled-atlas-v1-${mat.uuid}`;
}
