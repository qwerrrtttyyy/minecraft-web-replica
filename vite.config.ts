import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { VitePWA } from 'vite-plugin-pwa';

const indexHtmlPath = fileURLToPath(new URL('./dist/index.html', import.meta.url));
/** 单文件产物的内容哈希：作为 SW precache revision，内容一变就触发 SW 更新。 */
const htmlRevision = () => {
  try {
    return createHash('sha256').update(readFileSync(indexHtmlPath)).digest('hex').slice(0, 16);
  } catch {
    return 'bootstrap';
  }
};

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
        // development 模式绕开 workbox terser 在部分 Node 版本上的 renderChunk 挂起，
        // 但该模式会把 precache 的 revision 置为 null → 浏览器永远认为 SW 没更新，
        // 老用户被旧 index.html 永久缓存（新功能看不到）。这里按构建产物内容哈希
        // 显式给 index.html 一个 revision，内容一变 SW 就更新、缓存自然失效。
        mode: 'development',
        manifestTransforms: [(entries) => ({
          manifest: entries.map((e) => (e.url === 'index.html' ? { ...e, revision: htmlRevision() } : e)),
          warnings: [],
        })],
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
