/**
 * 四季与天候 / 寒冷纯逻辑回归（需先 npm run test:snapshot）。
 *
 * 覆盖：确定性天气派生、降水形态、变暗因子、闪电、指数逼近、
 * 环境惩罚（含「天气与季节」关闭时必须停寒冷）、冻伤节拍与 ColdSystem 集成。
 */
const assert = require('node:assert');
const {
  weatherTarget, weatherKindAt, precipitationForm, weatherFactor,
  lightningRoll, isLightning, approachWeather,
} = require('./logic/world/weather.js');
const { environmentPenalty, freezeDue, ColdSystem } = require('./logic/world/cold.js');
const { COLD } = require('./logic/core/tuning.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

console.log('天气 / 寒冷回归');

// 1) 确定性派生
{
  const a = weatherTarget(2026, 3, 0.8, 'spring');
  const b = weatherTarget(2026, 3, 0.8, 'spring');
  assert.deepStrictEqual(a, b); // 不一致会直接抛错
  ok('同 seed/day/温度/季节产出完全一致', true);
  ok('rain 日派生雨天', a.form === 'rain' && a.kind !== 'clear', JSON.stringify(a));
  ok('冬季把雨改为雪', weatherKindAt(2026, 3, 0.8, 'winter') === 'snow');
  ok('低温把雨改为雪', precipitationForm(0.2, 'spring', 'rain') === 'snow');
  ok('晴天无降水', precipitationForm(0.8, 'spring', 'clear') === 'none');
}

// 2) 变暗因子与闪电
{
  ok('晴天亮度因子为 1', weatherFactor('clear') === 1);
  ok('雷暴亮度因子来自唯一变暗源', weatherFactor('thunder') === 0.58);
  ok('闪光把亮度拉回 1', weatherFactor('thunder', 1) === 1);
  const rollA = lightningRoll(7, 3, 9);
  const rollB = lightningRoll(7, 3, 9);
  const flashA = isLightning(7, 3, 9);
  const flashB = isLightning(7, 3, 9);
  ok('闪电哈希确定', rollA === rollB);
  ok('闪电判定确定', flashA === flashB);
}

// 3) 指数逼近：帧率无关、单调收敛
{
  const from = weatherTarget(2026, 3, 0.8, 'spring');
  const to = weatherTarget(2027, 3, 0.8, 'spring');
  const one = approachWeather(from, to, 0.2);
  const half1 = approachWeather(from, to, 0.1);
  const half2 = approachWeather(half1, to, 0.1);
  ok('逼近后亮度介于起止之间', one.darkness <= Math.max(from.darkness, to.darkness) &&
    one.darkness >= Math.min(from.darkness, to.darkness));
  ok('两个半步 ≈ 一个整步', Math.abs(one.darkness - half2.darkness) < 1e-9,
    `${one.darkness} vs ${half2.darkness}`);
  ok('kind/form 原子切换', one.kind === to.kind && one.form === to.form);
}

// 4) 环境惩罚
{
  ok('雨天惩罚', environmentPenalty('rain', 'spring', 0.8, false) === COLD.rainPenalty);
  ok('雪天惩罚更强', environmentPenalty('snow', 'spring', 0.8, false) === COLD.snowPenalty);
  ok('雷暴最强', environmentPenalty('thunder', 'spring', 0.8, false) === COLD.stormPenalty);
  ok('冬季叠加', environmentPenalty('rain', 'winter', 0.8, false) === COLD.rainPenalty + COLD.winterPenalty);
  ok('夜间叠加', environmentPenalty('rain', 'spring', 0.1, false) === COLD.rainPenalty + COLD.nightPenalty);
  ok('遮蔽缩放', environmentPenalty('snow', 'spring', 0.8, true) === COLD.snowPenalty * COLD.shelterMultiplier);
  ok('关闭天气与季节后无任何寒冷（含冬季夜晚）',
    environmentPenalty('thunder', 'winter', 0.1, false, false) === 0);
}

// 5) 冻伤节拍
{
  ok('低温暖 + 足够时间 + 有惩罚 → 冻伤', freezeDue(10, COLD.damageInterval, COLD.rainPenalty));
  ok('温暖达标不冻伤', !freezeDue(COLD.warmthThreshold + 1, COLD.damageInterval, COLD.rainPenalty));
  ok('间隔不足不冻伤', !freezeDue(10, COLD.damageInterval - 0.1, COLD.rainPenalty));
  ok('无惩罚不冻伤', !freezeDue(10, COLD.damageInterval, 0));
}

// 6) ColdSystem 集成：开关必须真正关掉冻伤
{
  const survival = { isSurvival: true, warmth: 10 };
  const run = (enabled) => {
    const hurt = [];
    const sys = new ColdSystem({
      survival,
      observe: () => ({ kind: 'thunder', season: 'winter', daylight: 0.1, sheltered: false, enabled }),
      hurt: (amount, cause, kind) => hurt.push({ amount, cause, kind }),
    });
    sys.update(COLD.damageInterval + 0.1);
    return hurt;
  };
  const off = run(false);
  ok('关闭天气与季节：冻伤完全停止', off.length === 0);
  const on = run(true);
  ok('开启后按节拍冻伤，cause/kind 正确',
    on.length === 1 && on[0].amount === COLD.damage && on[0].cause === '冻伤' && on[0].kind === 'freeze',
    JSON.stringify(on));
}

console.log(`\nPASS 天气 / 寒冷回归：${passed} 组断言全部通过`);
