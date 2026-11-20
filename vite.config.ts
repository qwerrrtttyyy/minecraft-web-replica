import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { VitePWA } from 'vite-plugin-pwa';

// 构建产物为单文件 HTML，可直接双击在浏览器打开。
// PWA 插件额外产出独立 manifest / Service Worker / 图标：
// 游戏 JS 全部内联进 index.html + Worker 走 ?worker&inline 的 Blob URL，
// 因此 SW 的 precache 只需缓存 index.html 与图标，无跨源 Worker 问题。
export default defineConfig({
  base: './',
  plugins: [
    viteSingleFile(),
    VitePWA({
      registerType: 'autoUpdate',
      // 手动注册（见 index.html）：singlefile 无独立入口 JS；且需判断协议，
      // file:// 下注册 SW 会抛未捕获异常（单文件双击打开 / 自动化测试都走 file://）
      injectRegister: false,
      manifest: false, // 手写 manifest 到 public，路径更可控（相对 base: './'）
      workbox: {
        // 避免 SW 生成阶段 terser 挂起（部分 Node 版本下 renderChunk Promise 不收敛）；
        // 开发模式仅关闭压缩，功能与缓存策略不变
        mode: 'development',
        // 单文件构建：只有 index.html 需要缓存（JS/CSS 已内联其中）
        globPatterns: ['**/*.{html,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 100_000_000, // 内联后的 HTML 体积较大
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: false,
  },
});
