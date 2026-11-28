import type { TextureAtlas } from './atlas';
import { readZip } from './zipReader';

const TILE_ALIASES: Readonly<Record<string, string>> = {
  grass_block_top: 'grass_top',
  grass_block_side: 'grass_side',
  grass_block_snow: 'snow',
  oak_log: 'log_side',
  oak_log_top: 'log_top',
  log_oak: 'log_side',
  log_oak_top: 'log_top',
  planks_oak: 'oak_planks',
  leaves_oak: 'oak_leaves',
  short_grass: 'tall_grass',
  grass: 'tall_grass',
  water_still: 'water',
  water_flow: 'water',
  lava_still: 'lava',
  lava_flow: 'lava',
};

const IGNORED_TEXTURES = new Set([
  'grass_block_side_overlay',
  'destroy_stage_0',
  'destroy_stage_1',
  'destroy_stage_2',
  'destroy_stage_3',
  'destroy_stage_4',
  'destroy_stage_5',
  'destroy_stage_6',
  'destroy_stage_7',
  'destroy_stage_8',
  'destroy_stage_9',
]);

const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const DEFAULT_DECODE_CONCURRENCY = 4;

/**
 * 动画纹理首帧（左上）的裁剪矩形。
 * 条带（64×16）与网格（64×64）都是 16 倍数字节，取左上 16×16 那一帧；
 * 非 16 倍数的自定义分辨率回退为左上 min(w,h) 正方形，避免把整张表压成一格。
 */
export function firstFrameRect(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const base = Math.min(width, height);
  const size = width % 16 === 0 && height % 16 === 0 ? Math.min(16, base) : base;
  return { x: 0, y: 0, w: size, h: size };
}

export interface TexturePackLoadResult {
  source: string;
  applied: string[];
  missed: string[];
  errors: string[];
  superseded: boolean;
}

export interface TexturePackLoadOptions {
  shouldApply?: () => boolean;
  /** 并行解码数；移动端建议 2，桌面默认 4 */
  concurrency?: number;
}

function baseName(pathOrName: string): string {
  const file = pathOrName.replace(/\\/g, '/').split('/').pop() ?? pathOrName;
  return file.replace(/\.(png|jpg|jpeg|webp)$/i, '').toLowerCase();
}

export function nameToTile(pathOrName: string): string {
  const base = baseName(pathOrName);
  return TILE_ALIASES[base] ?? base;
}

export function tileForPath(pathOrName: string, known: ReadonlySet<string>): string | null {
  const base = baseName(pathOrName);
  if (IGNORED_TEXTURES.has(base)) return null;
  const tile = TILE_ALIASES[base] ?? base;
  return known.has(tile) ? tile : null;
}

export function filterKnownTiles(
  names: readonly string[],
  known: ReadonlySet<string>,
): { known: string[]; missed: string[] } {
  const hit: string[] = [];
  const missed: string[] = [];
  for (const raw of names) {
    const tile = tileForPath(raw, known);
    if (tile) hit.push(tile);
    else if (!IGNORED_TEXTURES.has(baseName(raw))) missed.push(raw);
  }
  return { known: hit, missed };
}

export function normalizeZipPath(base: string, path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.startsWith('/') || path.startsWith('/') || !base.includes('/')) return clean;
  const combined = `${base.slice(0, base.lastIndexOf('/'))}/${clean}`;
  const out: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function isPackEntry(name: string): boolean {
  return /\.(png|jpg|jpeg|webp)$/i.test(name) || /(^|\/)(pack|manifest)\.json$/i.test(name);
}

async function imageDataOf(blob: Blob, ctx: CanvasRenderingContext2D): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > MAX_IMAGE_DIMENSION ||
      bitmap.height > MAX_IMAGE_DIMENSION ||
      bitmap.width * bitmap.height > MAX_IMAGE_PIXELS
    ) {
      throw new Error(`纹理尺寸异常 ${bitmap.width}×${bitmap.height}`);
    }
    const frame = firstFrameRect(bitmap.width, bitmap.height);
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, 16, 16);
    return ctx.getImageData(0, 0, 16, 16);
  } finally {
    bitmap.close();
  }
}

async function decodeAll(
  blobs: ReadonlyMap<string, Blob>,
  concurrency: number,
): Promise<{ images: Map<string, ImageData>; errors: string[] }> {
  const images = new Map<string, ImageData>();
  const errors: string[] = [];
  const entries = [...blobs.entries()];
  let next = 0;
  const worker = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    while (next < entries.length) {
      const [tile, blob] = entries[next++];
      try {
        images.set(tile, await imageDataOf(blob, ctx));
      } catch (e) {
        errors.push(`${tile}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  const workers = Math.max(1, Math.min(8, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: Math.min(workers, entries.length) }, worker));
  return { images, errors };
}

function parseManifest(bytes: Uint8Array): Record<string, string> | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const tiles = (raw as { tiles?: unknown }).tiles;
    if (!tiles || typeof tiles !== 'object' || Array.isArray(tiles)) return null;
    const out: Record<string, string> = {};
    for (const [tile, path] of Object.entries(tiles)) {
      if (typeof path === 'string') out[tile] = path;
    }
    return out;
  } catch {
    return null;
  }
}

function zipManifest(entries: Map<string, Uint8Array>): { name: string; tiles: Record<string, string> } | null {
  for (const [name, data] of entries) {
    if (!/(^|\/)(pack|manifest)\.json$/i.test(name)) continue;
    const tiles = parseManifest(data);
    if (tiles) return { name, tiles };
  }
  return null;
}

function blobOf(data: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer], { type });
}

function addZipImages(
  entries: Map<string, Uint8Array>,
  known: ReadonlySet<string>,
  blobs: Map<string, Blob>,
  result: TexturePackLoadResult,
): void {
  const manifest = zipManifest(entries);
  if (manifest) {
    for (const [key, path] of Object.entries(manifest.tiles)) {
      const target = tileForPath(key, known);
      if (!target) {
        result.missed.push(key);
        continue;
      }
      const resolved = normalizeZipPath(manifest.name, path);
      const data = entries.get(resolved) ?? entries.get(path.replace(/\\/g, '/'));
      if (!data) {
        result.missed.push(`${key} -> ${path}`);
        continue;
      }
      blobs.set(target, blobOf(data, 'image/png'));
    }
    return;
  }
  for (const [name, data] of entries) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
    const tile = tileForPath(name, known);
    if (!tile) {
      if (!IGNORED_TEXTURES.has(baseName(name))) result.missed.push(name);
      continue;
    }
    blobs.set(tile, blobOf(data, name.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream'));
  }
}

export async function loadTexturePackInto(
  atlas: TextureAtlas,
  files: readonly File[],
  options: TexturePackLoadOptions = {},
): Promise<TexturePackLoadResult> {
  const result: TexturePackLoadResult = {
    source: '本地图片',
    applied: [],
    missed: [],
    errors: [],
    superseded: false,
  };
  const blobs = new Map<string, Blob>();
  const known = new Set(atlas.tileNames());

  for (const file of files) {
    if (/\.(zip|mcpack)$/i.test(file.name)) {
      result.source = file.name;
      let entries: Map<string, Uint8Array>;
      try {
        entries = await readZip(await file.arrayBuffer(), { filter: isPackEntry });
      } catch (e) {
        result.errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      addZipImages(entries, known, blobs, result);
      continue;
    }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file.name)) {
      result.missed.push(file.name);
      continue;
    }
    const tile = tileForPath(file.name, known);
    if (!tile) {
      if (!IGNORED_TEXTURES.has(baseName(file.name))) result.missed.push(file.name);
      continue;
    }
    blobs.set(tile, file);
  }

  const { images, errors } = await decodeAll(blobs, options.concurrency ?? DEFAULT_DECODE_CONCURRENCY);
  result.errors.push(...errors);
  if (images.size > 0 && (!options.shouldApply || options.shouldApply())) {
    atlas.applyTileImages(images);
    result.applied = [...images.keys()].sort();
  } else {
    result.superseded = images.size > 0;
  }
  return result;
}
