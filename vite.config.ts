import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';

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
/**
 * 双构建：
 * - 默认 `npm run build` → 单文件 index.html（可双击打开、file:// 可玩）。
 * - `npm run build:web` → 多文件产物（JS 独立成 chunk，three.js 单独分包），
 *   首屏可并行加载、命中长缓存；Pages / 静态托管用这一份更划算。
 */
const multiFile = process.env.WEB_MULTI === '1';

export default defineConfig({
  base: './',
  plugins: [
    ...(multiFile ? [] : [viteSingleFile()]),
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
        manifestTransforms: [
          (entries) => ({
            manifest: entries.map((e) => (e.url === 'index.html' ? { ...e, revision: htmlRevision() } : e)),
            warnings: [],
          }),
        ],
        // 单文件构建：只有 index.html 需要缓存（JS/CSS 已内联其中）
        globPatterns: ['**/*.{html,png,webmanifest,js,css}'],
        maximumFileSizeToCacheInBytes: 100_000_000, // 内联后的 HTML 体积较大
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2020',
    // 多文件构建时不内联资源，让浏览器按需加载并长期缓存
    assetsInlineLimit: multiFile ? 4096 : 100_000_000,
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: false,
    rollupOptions: multiFile
      ? {
          output: {
            // three.js 体积占一半以上且几乎不变：拆成独立 chunk，升级游戏代码不失效缓存
            manualChunks: { three: ['three'] },
          },
        }
      : {},
  },
});
