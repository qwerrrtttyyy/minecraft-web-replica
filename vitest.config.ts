import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 试点阶段只收 test/*.test.ts；其余 CJS 断言脚本仍走独立 npm run 入口
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 8 个文件各起一个 worker 时约 200ms/文件的启动成本占比过高；
    // 这些用例互不共享可变全局，关闭隔离实测节省约 1.4s。
    isolate: false,
    pool: 'threads',
  },
});
