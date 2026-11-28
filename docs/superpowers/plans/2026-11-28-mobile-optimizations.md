# Mobile Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低移动端首屏加载、Worker 争抢、材质解码内存和触控抖动，并补齐安全区。

**Architecture:** 所有优化通过 `isMobile` 在组装根传入，不改变桌面默认路径；触控增量按 rAF 合并，纯 CSS 安全区与现有横屏规则兼容。

**Tech Stack:** TypeScript、three.js、Vitest/CJS 快照、Puppeteer。

## Global Constraints

- 桌面端预载半径、Worker 上限、触控逻辑保持不变。
- 不新增依赖。
- 移动端预载半径 2；网格 Worker 默认最多 2；生成 Worker 默认最多 1。
- 材质解码并发：移动端 2，桌面 4；每个解码 Worker 复用画布。
- 触控拖动每帧最多写一次 `input.addLook`。
- 全部触控按钮使用 `env(safe-area-inset-*)`。

### Task 1: 启动与 Worker 预算

- 修改 `src/main.ts`：移动端 initialLoad 半径 2，ChunkManager 传 `mobile: isMobile`。
- 修改 `src/world/chunkManager.ts`：`mobileMode` + Worker 上限；`recommendedPoolSize` 反映移动端。
- 验证：移动端页面 `recommendedPoolSize() <= 2`，桌面仍按原逻辑。

### Task 2: 材质解码

- 修改 `src/gfx/texturePack.ts`：`concurrency` 选项、每 Worker 复用 canvas。
- 修改 `src/main.ts`：移动端传 2，桌面 4。
- 验证：Java/Bedrock ZIP 导入正常。

### Task 3: 触控与安全区

- 修改 `src/input/touch.ts`：累加 look 增量，rAF 合并；隐藏/结束/暂停时丢弃或刷新。
- 修改 `src/ui/styles.css`：4 个按钮补 safe-area。
- 验证：移动端拖动镜头、按钮点击、无横向溢出。

### Task 4: 回归与提交

- 运行 `typecheck`、`build`、`test:options`、`test:experiments3d`。
- 用 mobile emulation 检查 Worker 上限、触控布局和安全区。
- 接入远端历史，创建 `feat/3d-experiments-mobile` 本地提交，不推送。
