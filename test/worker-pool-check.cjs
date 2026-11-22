/**
 * Worker 池构造契约回归（纯逻辑，不需要 WebGL / 真实 Worker）。
 *
 * 覆盖「构造期部分失败必须整体回滚，不留残缺池」——对应 chunkManager 曾出现的
 * 缺陷：catch 只打印回退日志，实际仍以 worker 模式带部分实例运行。
 */
const assert = require('node:assert');
const { createWorkerPool } = require('./logic/world/workerPool.js');
const { planDrain } = require('./logic/world/meshTypes.js');

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
/**
 * T3 限流收割策略（纯数据）：config-ack 优先且不占配额，其余按入队顺序取前 N 条，
 * 未处理条目留在队首 —— 这三条共同保证「无饥饿 + busy 计数可回退」。
 */
{
  const msg = (n) => ({ type: 'result', wid: 0, cx: n, cz: 0, generation: 1, mesh: {}, stats: {} });
  const ack = { type: 'config-ack', wid: 0, revision: 2 };
  const queue = [msg(1), ack, msg(2), msg(3), msg(4), msg(5), msg(6)];
  const plan = planDrain(queue, 4);
  ok('config-ack 被抽出且不占收割配额', plan.acks.length === 1 && plan.batch.length === 4);
  ok(
    '收割按入队顺序取前 4 条',
    plan.batch.every((m, i) => m.type === 'result' && m.cx === i + 1),
  );
  ok('未处理条目留队首且不丢消息', plan.rest.length === 2 && plan.rest[0].cx === 5 && plan.rest[1].cx === 6);
  ok('limit=0 被钳到 1，避免队列永久冻结', planDrain([msg(1), msg(2)], 0).batch.length === 1);
  // 逐帧消费：最多 ceil(7/4)=2 帧即可排空，证明不存在永久饥饿
  let pending = queue.filter((m) => m.type !== 'config-ack');
  let frames = 0;
  while (pending.length && frames < 10) {
    const p = planDrain(pending, 4);
    pending = p.rest;
    frames++;
  }
  ok('限流下 2 帧内排空全部结果（无区块永久饥饿）', pending.length === 0 && frames === 2, `frames=${frames}`);
  const stale = { type: 'error', wid: 0, cx: 9, cz: 0, generation: 1, message: 'stale' };
  ok('过期代次的 error 消息仍进入 batch（主线程据此回退 busy）', planDrain([stale], 4).batch.length === 1);
}
console.log(`\nPASS Worker 池构造回滚与收割限流回归：${passed} 组断言`);
