/**
 * 摄影模式纯逻辑（零依赖：无 three.js / DOM / World）。
 *
 * 只放数值钳制、配置表与文本格式化，便于直接进 CJS 测试快照
 * （scripts/build-test-snapshot.mjs 的 entries），由 UI / 输入 / 引擎侧消费。
 */

/** 摄影模式 FOV 的合法区间 */
export const PHOTO_FOV_MIN = 20;
export const PHOTO_FOV_MAX = 100;

/** 时刻档位顺序（末项回绕到首项） */
export const TIME_PRESETS = ['dawn', 'day', 'dusk', 'night'] as const;
export type TimePreset = (typeof TIME_PRESETS)[number];

/**
 * 档位对应的 dayTime（0..1）。
 * `night = 0` 与 `dawn = 0.25` 对应 `sky.ts` 的 `theta = (dayTime - 0.25) * 2π`：
 * 日出时太阳位于地平线，正午最高，日落回到地平线，午夜最低。
 */
export const TIME_PRESET_VALUES: Readonly<Record<TimePreset, number>> = {
  dawn: 0.25,
  day: 0.5,
  dusk: 0.75,
  night: 0,
};

/** 天气切换顺序（末项回绕到首项） */
export const WEATHER_CYCLE = ['clear', 'rain', 'snow', 'thunder'] as const;
export type PhotoWeather = (typeof WEATHER_CYCLE)[number];

/** 截图元数据：由摄影模式在按下快门时填入 */
export interface PhotoMetadata {
  biome: string;
  season: string;
  weather: string;
  time: string;
  x: number;
  y: number;
  z: number;
  date: Date;
}

/** 循环取值：未知输入按首项处理，保证结果永远落在配置表内 */
function nextInCycle<T extends string>(cycle: readonly T[], current: T): T {
  const index = cycle.indexOf(current);
  return cycle[index < 0 ? 0 : (index + 1) % cycle.length];
}

/** 把视场角钳制在 [20, 100] */
export function clampFov(value: number): number {
  return Math.min(PHOTO_FOV_MAX, Math.max(PHOTO_FOV_MIN, value));
}

/** 下一个时刻档位，night → dawn */
export function nextTimePreset(current: TimePreset): TimePreset {
  return nextInCycle(TIME_PRESETS, current);
}

/** 下一个天气，thunder → clear */
export function nextWeather(current: PhotoWeather): PhotoWeather {
  return nextInCycle(WEATHER_CYCLE, current);
}

/**
 * 把相机水平位置钳制在以玩家为圆心、radius 为半径的圆内。
 * y 属于自由飞行相机，原样保留；radius <= 0 时水平坐标直接回到玩家。
 */
export function clampPhotoPosition(
  camera: { x: number; y: number; z: number },
  player: { x: number; y: number; z: number },
  radius: number,
): { x: number; y: number; z: number } {
  const result = { x: camera.x, y: camera.y, z: camera.z };
  if (radius <= 0) {
    result.x = player.x;
    result.z = player.z;
    return result;
  }
  const dx = camera.x - player.x;
  const dz = camera.z - player.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= radius) return result;
  // 相机恰好落在玩家水平位置时 distance=0，上面已提前返回
  const scale = radius / distance;
  result.x = player.x + dx * scale;
  result.z = player.z + dz * scale;
  return result;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 导出文件名：mc-photo-<biome>-x<x>-y<y>-z<z>-<YYYYMMDD>-<HHmmss>.png */
export function photoFileName(meta: PhotoMetadata): string {
  const biome = meta.biome.replace(/[^a-z0-9_-]/g, '_');
  const date = meta.date;
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `mc-photo-${biome}-x${Math.round(meta.x)}-y${Math.round(meta.y)}-z${Math.round(meta.z)}-${stamp}.png`;
}

/** 截图水印：单行汇总群系 / 季节 / 天气 / 时刻 / 整数坐标 */
export function photoCaption(meta: PhotoMetadata): string {
  return (
    `${meta.biome} · ${meta.season} · ${meta.weather} · ${meta.time} · ` +
    `(${Math.round(meta.x)}, ${Math.round(meta.y)}, ${Math.round(meta.z)})`
  );
}

/** 玩家侧相机写入守卫：只有相机无主（null）时才允许写入 */
export function canWritePlayerCamera(cameraOwner: string | null): boolean {
  return cameraOwner === null;
}
