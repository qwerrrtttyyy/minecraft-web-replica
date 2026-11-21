import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 试点阶段只收 test/*.test.ts；其余 CJS 断言脚本仍走独立 npm run 入口
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
