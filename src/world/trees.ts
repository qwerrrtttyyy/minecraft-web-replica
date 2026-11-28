/**
 * 树种形状构建器（纯逻辑，无 World / DOM 依赖）。
 *
 * 地形阶段与生态引擎共用同一份形状：
 * - 生成器按世界坐标随机出树种与高度，再把相对方块裁剪进当前区块；
 * - 树苗随机刻后直接用同一份形状写入世界。
 * 两条路径因此不会出现「自然树」和「树苗长出的树」两种树形。
 */
export type TreeSpecies = 'oak' | 'birch' | 'spruce' | 'acacia' | 'cherry';

export interface TreeBlock {
  dx: number;
  dy: number;
  dz: number;
  kind: 'log' | 'leaves';
}

/** 树种对应的树干高度范围（含端点，单位：格） */
export const TREE_TRUNK: Readonly<Record<TreeSpecies, readonly [number, number]>> = {
  oak: [4, 6],
  birch: [5, 7],
  spruce: [6, 9],
  acacia: [5, 7],
  cherry: [6, 8],
};

export function treeTrunkHeight(species: TreeSpecies, rng: () => number): number {
  const [min, max] = TREE_TRUNK[species];
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 构建一棵树：dy 以树干基部为 0，返回相对坐标列表。
 * 先输出树干再输出树叶，写入方按 kind 处理覆盖规则即可。
 */
export function buildTree(species: TreeSpecies, rng: () => number, trunk = treeTrunkHeight(species, rng)): TreeBlock[] {
  const out: TreeBlock[] = [];
  for (let dy = 0; dy < trunk; dy++) out.push({ dx: 0, dy, dz: 0, kind: 'log' });

  if (species === 'spruce') {
    // 云杉：自下而上逐层收窄的圆锥，顶部再补一片顶叶
    for (let dy = 2; dy <= trunk; dy++) {
      const fromTop = trunk - dy;
      const rad = fromTop <= 1 ? 1 : 2;
      const inner = fromTop <= 2;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
          if (corner && rng() < 0.6) continue;
          if (inner && Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          out.push({ dx, dy, dz, kind: 'leaves' });
        }
      }
    }
    out.push({ dx: 0, dy: trunk + 1, dz: 0, kind: 'leaves' });
    return out;
  }

  if (species === 'acacia') {
    // 金合欢：平顶伞盖，底层半径 3、上层半径 2，层缘随机镂空
    for (const [dy, rad] of [
      [trunk, 3],
      [trunk + 1, 2],
    ] as const) {
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const edge = Math.abs(dx) === rad || Math.abs(dz) === rad;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad) continue;
          if (edge && rng() < 0.25) continue;
          out.push({ dx, dy, dz, kind: 'leaves' });
        }
      }
    }
    return out;
  }

  if (species === 'cherry') {
    // 樱花：比橡树更饱满的大圆冠，顶部再补一片顶叶
    for (let dy = trunk - 2; dy <= trunk + 2; dy++) {
      const rad = dy >= trunk + 1 ? 2 : 3;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy >= trunk || rng() < 0.5)) continue;
          out.push({ dx, dy, dz, kind: 'leaves' });
        }
      }
    }
    out.push({ dx: 0, dy: trunk + 3, dz: 0, kind: 'leaves' });
    return out;
  }

  // 橡树 / 白桦：分层圆冠，最外层四角随机镂空，顶部收成十字
  const crown = 2;
  for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
    const rad = dy >= trunk ? 1 : crown;
    for (let dx = -rad; dx <= rad; dx++) {
      for (let dz = -rad; dz <= rad; dz++) {
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy >= trunk || rng() < 0.5)) continue;
        out.push({ dx, dy, dz, kind: 'leaves' });
      }
    }
  }
  return out;
}
