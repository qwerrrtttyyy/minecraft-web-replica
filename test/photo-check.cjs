/**
 * 摄影模式纯逻辑回归（需先 npm run test:snapshot）。
 *
 * 覆盖：FOV 钳制 / 时刻档位表与回绕 / 天气循环 / 相机水平半径钳制（保留 y） /
 * 元数据文件名清洗与格式化 / 单行水印文案 / 玩家相机写入守卫 /
 * 引擎同帧截图钩子与相机归属的源码契约。
 */
const assert = require('node:assert');
const {
  PHOTO_FOV_MIN,
  PHOTO_FOV_MAX,
  TIME_PRESETS,
  TIME_PRESET_VALUES,
  nextTimePreset,
  WEATHER_CYCLE,
  nextWeather,
  clampFov,
  clampPhotoPosition,
  photoFileName,
  photoCaption,
  canWritePlayerCamera,
  isLockPauseEdge,
} = require('./logic/photo/photoFrames.js');
const {
  ACTION_LABELS,
  ACTION_KEYS,
  DEFAULT_BINDINGS,
  emitsEdgeWhileDisabled,
} = require('./logic/input/keybindings.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};
const same = (name, actual, expected) => {
  ok(
    name,
    assert.deepStrictEqual(actual, expected) === undefined,
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
};

console.log('摄影模式纯逻辑回归');

// 1) FOV 边界
ok('FOV 常量为 20 / 100', PHOTO_FOV_MIN === 20 && PHOTO_FOV_MAX === 100);
ok('低于下限钳到 20', clampFov(10) === 20);
ok('区间内原样返回', clampFov(50) === 50);
ok('高于上限钳到 100', clampFov(200) === 100);
ok('边界值不被改动', clampFov(20) === 20 && clampFov(100) === 100);

// 2) 时刻档位配置表
same('时刻档位顺序固定', [...TIME_PRESETS], ['dawn', 'day', 'dusk', 'night']);
same('时刻档位数值与 sky.sunDirection 对齐', { ...TIME_PRESET_VALUES }, { dawn: 0.25, day: 0.5, dusk: 0.75, night: 0 });
ok(
  '时刻档位逐项回绕',
  nextTimePreset('dawn') === 'day' &&
    nextTimePreset('day') === 'dusk' &&
    nextTimePreset('dusk') === 'night' &&
    nextTimePreset('night') === 'dawn',
);

// 3) 天气循环配置表
same('天气循环顺序固定', [...WEATHER_CYCLE], ['clear', 'rain', 'snow', 'thunder']);
ok(
  '天气循环逐项回绕',
  nextWeather('clear') === 'rain' &&
    nextWeather('rain') === 'snow' &&
    nextWeather('snow') === 'thunder' &&
    nextWeather('thunder') === 'clear',
);

// 4) 相机位置钳制：仅水平 x/z，y 永不动
{
  const clamped = clampPhotoPosition({ x: 100, y: 30, z: 0 }, { x: 0, y: 20, z: 0 }, 16);
  ok('超出半径的 x 被钳到 16', clamped.x === 16, `x=${clamped.x}`);
  ok('相机 y 原样保留（不用玩家 y）', clamped.y === 30, `y=${clamped.y}`);
  ok('z 未越界则不动', clamped.z === 0, `z=${clamped.z}`);

  const inside = clampPhotoPosition({ x: 3, y: 77, z: -4 }, { x: 0, y: 20, z: 0 }, 16);
  same('半径内坐标不被改动', inside, { x: 3, y: 77, z: -4 });

  const zero = clampPhotoPosition({ x: 100, y: 30, z: -50 }, { x: 7, y: 20, z: -9 }, 0);
  same('radius=0 时水平回到玩家、y 仍保留', zero, { x: 7, y: 30, z: -9 });
  const negative = clampPhotoPosition({ x: 100, y: 30, z: -50 }, { x: 7, y: 20, z: -9 }, -4);
  same('负半径等同 0', negative, { x: 7, y: 30, z: -9 });

  const diagonal = clampPhotoPosition({ x: 30, y: 5, z: 40 }, { x: 0, y: 0, z: 0 }, 25);
  ok('斜向按水平距离成比例钳制', diagonal.x === 15 && diagonal.z === 20, `x=${diagonal.x} z=${diagonal.z}`);
  const origin = clampPhotoPosition({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 }, 16);
  same('相机与玩家重合时安全返回', origin, { x: 0, y: 5, z: 0 });
}

// 5) 文件名：清洗 biome、取整坐标、时间戳
{
  const meta = {
    biome: 'snowy taiga',
    season: 'winter',
    weather: 'snow',
    time: '08:00',
    x: 12,
    y: 40,
    z: -8,
    date: new Date(2026, 10, 28, 16, 30, 0),
  };
  const name = photoFileName(meta);
  ok('biome 空格替换为下划线', name.startsWith('mc-photo-snowy_taiga-'), name);
  ok('文件名格式与时间戳', /^mc-photo-.*-x-?\d+-y-?\d+-z-?\d+-\d{8}-\d{6}\.png$/.test(name), name);
  ok('完整文件名逐字一致', name === 'mc-photo-snowy_taiga-x12-y40-z-8-20261128-163000.png', name);
  ok(
    '坐标取整后写入文件名',
    photoFileName({ ...meta, x: 12.6, y: -3.6, z: 7.2 }) === 'mc-photo-snowy_taiga-x13-y-4-z7-20261128-163000.png',
  );
  ok(
    '非法 biome 字符全量清洗为下划线',
    photoFileName({ ...meta, biome: 'snowy/taiga!' }).startsWith('mc-photo-snowy_taiga_-'),
  );
  ok(
    '合法数字 / 下划线 / 连字符保持不变',
    photoFileName({ ...meta, biome: 'snowy_taiga-2' }).startsWith('mc-photo-snowy_taiga-2-'),
  );
}

// 6) 水印文案：单行、含全部信息
{
  const caption = photoCaption({
    biome: 'plains',
    season: 'spring',
    weather: 'rain',
    time: '18:45',
    x: 12.7,
    y: 40.2,
    z: -8.4,
    date: new Date(2026, 10, 28, 16, 30, 0),
  });
  ok('水印是单行', !caption.includes('\n') && !caption.includes('\r'), caption);
  ok('水印含 biome', caption.includes('plains'), caption);
  ok('水印含 season', caption.includes('spring'), caption);
  ok('水印含 weather', caption.includes('rain'), caption);
  ok('水印含 time', caption.includes('18:45'), caption);
  ok('水印含整数坐标三元组', caption.includes('(13, 40, -8)'), caption);
}

// 7) 玩家相机写入守卫：仅无主（null）时可写
ok('无主相机可写', canWritePlayerCamera(null) === true);
ok('摄影模式占用时不可写', canWritePlayerCamera('photo') === false);
ok('玩家自己占用时也不可写', canWritePlayerCamera('player') === false);

// 8) 引擎同帧截图钩子契约（源码守卫；像素行为由 Task 4 浏览器冒烟验证）
{
  const fs = require('node:fs');
  const path = require('node:path');
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.ts'), 'utf8');
  ok('引擎声明 onAfterRender 钩子', engineSource.includes('onAfterRender'));
  ok('引擎声明 cameraOwner 归属字段', engineSource.includes('cameraOwner'));
  ok('引擎不启用 preserveDrawingBuffer', !engineSource.includes('preserveDrawingBuffer'));
}

// 9) 摄影模式按键：可重绑定动作、默认键位与边缘事件源
{
  ok('DEFAULT_BINDINGS.photo 默认 KeyP', DEFAULT_BINDINGS.photo === 'KeyP', `photo=${DEFAULT_BINDINGS.photo}`);
  ok('ACTION_KEYS 自动包含 photo', ACTION_KEYS.includes('photo'), `keys=${JSON.stringify(ACTION_KEYS)}`);
  ok('ACTION_LABELS.photo 为 摄影模式', ACTION_LABELS.photo === '摄影模式', `label=${ACTION_LABELS.photo}`);
}

// 10) 摄影模式存档快照：dayCount 与 dayTime 一样取进入前值（0 是合法天数，显式判 null）
{
  const fs = require('node:fs');
  const path = require('node:path');
  const modeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'photo', 'PhotoMode.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'CraftAPI.ts'), 'utf8');
  ok('PhotoMode 快照并清空 savedDayCount',
    /savedDayCount\s*:\s*number\s*\|\s*null\s*=\s*null/.test(modeSource) &&
    /this\.savedDayCount\s*=\s*sky\.dayCount/.test(modeSource) &&
    /this\.savedDayCount\s*=\s*null/.test(modeSource));
  ok('PhotoAPI 暴露 savedDayCount', /readonly savedDayCount\s*:\s*number\s*\|\s*null;/.test(apiSource));
  ok('collectSave 的 dayCount / dayTime 均取摄影前快照',
    /dayCount:\s*photo\?\.active\s*&&\s*photo\.savedDayCount\s*!==\s*null\s*\?\s*photo\.savedDayCount\s*:\s*sky\.dayCount/.test(mainSource) &&
    /dayTime:\s*photo\?\.active\s*&&\s*photo\.savedDayTime\s*!==\s*null\s*\?\s*photo\.savedDayTime\s*:\s*sky\.dayTime/.test(mainSource));
}

// 11) 覆盖层显示态 / 伪 pause 窗口 / teardown：源码契约（像素行为由浏览器冒烟验证）
{
  const fs = require('node:fs');
  const path = require('node:path');
  const modeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'photo', 'PhotoMode.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  const inputSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'input', 'input.ts'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'photo', 'photo.css'), 'utf8');
  ok('CSS 默认隐藏覆盖层，.photo-visible 才切回 flex',
    /#photo-overlay\.photo-overlay\s*\{[\s\S]*?display:\s*none;/.test(css) &&
    /\.photo-visible\s*\{\s*display:\s*flex;/.test(css));
  ok('CSS 保留纵向分栏与 hints 居中',
    /flex-direction:\s*column/.test(css) && /justify-content:\s*space-between/.test(css) &&
    /#photo-overlay\s+\.photo-hints\s*\{[\s\S]*?align-self:\s*center/.test(css));
  ok('PhotoMode 不再用 inline display 切换覆盖层',
    !/overlay\.style\.display/.test(modeSource) &&
    /overlay\.classList\.add\('photo-visible'\)/.test(modeSource) &&
    /overlay\.classList\.remove\('photo-visible'\)/.test(modeSource));
  ok('只有 pointerlockchange 的伪 pause 被吞，真实 Esc 永不按时间窗误吞',
    isLockPauseEdge({ type: 'pause', source: 'pointerlock' }) === true &&
    isLockPauseEdge({ type: 'pause', source: 'key' }) === false &&
    isLockPauseEdge({ type: 'pause' }) === false &&
    !/LOCK_PAUSE_GRACE_MS/.test(modeSource) &&
    /source:\s*'pointerlock'/.test(inputSource) &&
    /source:\s*'key'/.test(inputSource) &&
    /isLockPauseEdge\(e\)/.test(mainSource));
  ok('输入禁用期间 pause 与 jei 仍上报边沿（面板内 J / Esc 可关闭）',
    emitsEdgeWhileDisabled('pause') === true &&
    emitsEdgeWhileDisabled('jei') === true &&
    emitsEdgeWhileDisabled('forward') === false &&
    /emitsEdgeWhileDisabled\(action\)/.test(inputSource));
  ok('摄影模式带独立进入按钮（桌面 / 触控共用）',
    /\.id\s*=\s*['"]photo-enter['"]/.test(modeSource) &&
    /#photo-enter/.test(css) &&
    /photoEnter\.addEventListener\('click'/.test(modeSource) &&
    /canEnter\(\)/.test(modeSource));
  ok('PhotoMode.dispose 移除五条全局监听并归还引擎状态',
    /dispose\(\): void/.test(modeSource) &&
    /removeEventListener\('keydown', this\.onKeyDown\)/.test(modeSource) &&
    /removeEventListener\('mousemove', this\.onMouseMove\)/.test(modeSource) &&
    /removeEventListener\('mouseup', this\.onMouseUp\)/.test(modeSource) &&
    /this\.canvas\.removeEventListener\('wheel', this\.onWheel\)/.test(modeSource) &&
    /this\.canvas\.removeEventListener\('mousedown', this\.onMouseDown, \{ capture: true \}\)/.test(modeSource) &&
    /this\.exit\(false\)/.test(modeSource));
  ok('main 的 teardown 调用 photo.dispose()',
    /const teardown = \(\) => \{[\s\S]*?photo\?\.dispose\(\)/.test(mainSource));
}

console.log(`\n${passed} 项通过`);
