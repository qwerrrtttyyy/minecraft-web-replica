/**
 * Worker 池构造契约回归（纯逻辑，不需要 WebGL / 真实 Worker）。
 *
 * 覆盖「构造期部分失败必须整体回滚，不留残缺池」——对应 chunkManager 曾出现的
 * 缺陷：catch 只打印回退日志，实际仍以 worker 模式带部分实例运行。
 */
const assert = require('node:assert');
const { createWorkerPool } = require('./logic/world/workerPool.js');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 生成可控的 mock 构造器：第 failAt 次（0-based）构造抛错 */
function makeCtor(failAt = -1, created = []) {
  let n = 0;
  return function MockWorker() {
    if (n++ === failAt) throw new Error('mock construct failure');
    const w = {
      terminated: false,
      terminate() {
        this.terminated = true;
      },
    };
    created.push(w);
    return w;
  };
}

{
  const made = [];
  const r = createWorkerPool(makeCtor(-1, made), 4);
  ok('全部构造成功 → partial=false / 4 个实例', r.partial === false && r.workers.length === 4 && made.length === 4);
  ok(
    '全部构造成功 → 没有实例被 terminate',
    made.every((w) => !w.terminated),
  );
}
{
  const made = [];
  const r = createWorkerPool(makeCtor(2, made), 4);
  ok('第 3 次构造失败 → partial=true 且返回空数组', r.partial === true && r.workers.length === 0);
  ok('已建的 2 个实例全部 terminate（整体回滚）', made.length === 2 && made.every((w) => w.terminated));
}
{
  const r = createWorkerPool(makeCtor(0), 4);
  ok('首个构造即失败 → partial=true', r.partial === true && r.workers.length === 0);
}
{
  const r = createWorkerPool(makeCtor(-1), 0);
  ok('want=0 → partial=true（不产生无实例的 worker 池）', r.partial === true && r.workers.length === 0);
}
console.log(`\nPASS Worker 池构造回滚回归：${passed} 组断言`);
