# 摄影模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加不触碰世界生成算法的摄影模式：自由相机、取景时刻/天气调节、同帧 PNG 导出，退出后世界状态与存档完全复原。

**Architecture:** 新增纯逻辑模块 `photoFrames.ts`（可进测试快照）承载所有数值与格式化；`Engine` 增加渲染后钩子与相机归属字段；`PhotoMode` 作为 System 接管相机、覆盖层与导出；`main.ts` 只做接线与"冻结玩家而非冻结世界"的状态路由。地形生成、方块 id、Worker 复刻、存档结构全部不动。

**Tech Stack:** TypeScript 5.6（strict）、three.js 0.170、Vite 6、Vitest 5、Node CJS 快照测试。

**Spec:** `docs/superpowers/specs/2026-11-28-photo-mode-design.md`

## Global Constraints

- `VERSION` 定为 **`1.6.0-beta.3`**；bump 必须与 `package.json` / `README.md` / `CHANGELOG.md` / 版本断言同 commit，禁止硬编码版本字面量。
- 0 新方块 id（总数仍 165、最大 id 177）、0 新依赖、0 地形生成改动、0 存档 schema 改动。
- 渲染器不得设置 `preserveDrawingBuffer`；截图只能在 `renderer.render()` 之后同帧取像素。
- 测试快照先行：`npm run test:snapshot` 必须先于所有 `require` 快照的纯逻辑测试。
- 输入状态机：暂停 / 死亡 / 返回标题调用 `input.reset()`；`keyup` 无条件处理。
- 版本双轨单一来源：`src/core/version.ts` 是唯一来源。
- 大二进制不入库：截图不进 git、不进 localStorage / 存档。

## Review Focus

- 非 `playing` 态（暂停 / 死亡 / 标题 / 有面板打开）按 `P` 不应进入摄影模式 → Task 4 冒烟断言：暂停态按 `P` 后 `#photo-overlay` 仍不可见且 `photo.active === false`。
- 摄影模式期间 WASD 不应驱动玩家、不应发 `player:move` 标脏、不应移动区块中心 → Task 4 加断言：`enter()` 后模拟 `moveX/moveZ`，`player.pos` 与 `dirtySave` 不变；`chunks.setCenter` 仍读 `player.pos`。
- 相机飞出已加载半径会看到空白区块 → Task 1 用 `clampPhotoPosition` 单测钉死半径钳制与 y 保留。
- 帧外 `toDataURL()` 得到空白 PNG → Task 2/4 只经 `onAfterRender` 取像素；浏览器冒烟断言导出 URL 以 `data:image/png` 开头且非纯色。
- 退出后预览的时刻 / 天气 / HUD / 指针锁 / 存档时刻必须复原 → Task 4 加断言：`exit()` 后 `sky.dayTime`、`weather.forced`、`hud.hudHidden`、`cameraOwner`、`photo.savedDayTime` 全部回到进入前的值。

---

### Task 1: 纯逻辑模块 `photoFrames.ts` 与快照回归

**Files:**
- Create: `src/photo/photoFrames.ts`
- Modify: `scripts/build-test-snapshot.mjs` (entries 数组)
- Modify: `package.json` (新增 `test:photo` 脚本，置于 `test:structure` 之后)
- Test: `test/photo-check.cjs`

**Interfaces:**
- Consumes: 无（零依赖纯逻辑）
- Produces:
  - `PHOTO_FOV_MIN = 20`, `PHOTO_FOV_MAX = 100`
  - `TIME_PRESETS = ['dawn','day','dusk','night'] as const`, `type TimePreset`
  - `TIME_PRESET_VALUES: Readonly<Record<TimePreset, number>>` = `{ dawn: 0.25, day: 0.5, dusk: 0.75, night: 0 }`（与 `sky.ts:290` 的 `theta = (dayTime - 0.25)·2π` 对齐）
  - `WEATHER_CYCLE = ['clear','rain','snow','thunder'] as const`, `type PhotoWeather`
  - `interface PhotoMetadata { biome: string; season: string; weather: string; time: string; x: number; y: number; z: number; date: Date }`
  - `clampFov(value: number): number`
  - `nextTimePreset(current: TimePreset): TimePreset`（末项回绕到首项）
  - `nextWeather(current: PhotoWeather): PhotoWeather`（末项回绕到首项）
  - `clampPhotoPosition(camera: {x,y,z}, player: {x,y,z}, radius: number): {x,y,z}` —— 仅钳制水平 x/z，y 原样保留；`radius <= 0` 时返回 player 的 x/z
  - `photoFileName(meta: PhotoMetadata): string` —— 形如 `mc-photo-plains-x12-y40-z-8-20261128-163000.png`；biome 中非 `[a-z0-9_-]` 字符替换为 `_`，坐标取整，时间为 `YYYYMMDD-HHmmss`
  - `photoCaption(meta: PhotoMetadata): string` —— 单行含 biome / season / weather / time / `(x, y, z)`
  - `canWritePlayerCamera(cameraOwner: string | null): boolean` —— `owner === null`

- [ ] **Step 1: 写失败测试 `test/photo-check.cjs`**

按 `test/structure-check.cjs` 的 `ok(name, cond, extra)` 风格，至少断言：
`clampFov(10)===20`、`clampFov(50)===50`、`clampFov(200)===100`；
`TIME_PRESET_VALUES` 四个值精确等于上表；`nextTimePreset('night')==='dawn'`；
`WEATHER_CYCLE` 顺序与 `nextWeather('thunder')==='clear'`；
`clampPhotoPosition({x:100,y:30,z:0},{x:0,y:20,z:0},16).x===16` 且 `.y===30`、`.z===0`；
内部点不被改变；`radius=0` 时水平坐标回到 player；
`photoFileName` 对 biome `'snowy taiga'` 产生 `snowy_taiga`、匹配 `/^mc-photo-.*-x-?\d+-y-?\d+-z-?\d+-\d{8}-\d{6}\.png$/`；
`photoCaption` 含全部 5 类信息；`canWritePlayerCamera(null)===true`、`canWritePlayerCamera('photo')===false`。

```cjs
const { clampFov, TIME_PRESET_VALUES, nextTimePreset, WEATHER_CYCLE, nextWeather,
  clampPhotoPosition, photoFileName, photoCaption, canWritePlayerCamera } =
  require('./logic/photo/photoFrames.js');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:snapshot && node test/photo-check.cjs`
Expected: FAIL（模块不存在 / `require` 报错）

- [ ] **Step 3: 实现 `src/photo/photoFrames.ts`**

按 Interfaces 写出零依赖函数体。文件头注释说明"纯逻辑，无 three / DOM，进测试快照"。时间档位与天气循环是配置表，不要散成 `if` 分支。

- [ ] **Step 4: 接线快照与脚本**

在 `scripts/build-test-snapshot.mjs` 的 `entries` 末尾追加 `'src/photo/photoFrames.ts'`；在 `package.json` 的 `scripts` 中加 `"test:photo": "node test/photo-check.cjs"`，并把它放进 `verify` 与 `verify:node`（紧跟 `test:structure` 之后）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:snapshot && node test/photo-check.cjs && npm run typecheck`
Expected: PASS（15 项以上断言全绿，typecheck 0 error）

- [ ] **Step 6: Commit**

```bash
git add src/photo/photoFrames.ts scripts/build-test-snapshot.mjs package.json test/photo-check.cjs
git commit -m "feat(photo): 摄影模式纯逻辑模块与快照回归"
```

---

### Task 2: 引擎同帧截图钩子与相机归属

**Files:**
- Modify: `src/core/engine.ts:32-75`（类字段与构造）、`src/core/engine.ts:139-162`（`start()` 循环）
- Test: `test/photo-check.cjs`（追加 `canWritePlayerCamera` 的引擎契约断言，复用 Task 1 已实现函数）

**Interfaces:**
- Consumes: `canWritePlayerCamera`（Task 1）
- Produces:
  - `Engine.onAfterRender: (() => void) | null = null` —— 在 `this.renderer.render(this.scene, this.camera)` 之后**立即**调用（同一帧、同一次 rAF）
  - `Engine.cameraOwner: string | null = null` —— 玩家侧相机写入点以 `canWritePlayerCamera(engine.cameraOwner)` 为守卫
  - 不得新增 `preserveDrawingBuffer: true`；不得改动 `Engine.start()` 的系统更新顺序

- [ ] **Step 1: 写失败断言**

在 `test/photo-check.cjs` 末尾追加：读取 `src/core/engine.ts` 源码文本，断言包含 `onAfterRender` 与 `cameraOwner`，且不包含 `preserveDrawingBuffer`。说明：这是契约守卫，真正的像素行为由 Task 4 浏览器冒烟验证。

- [ ] **Step 2: 运行确认失败**

Run: `node test/photo-check.cjs`
Expected: FAIL（源码尚无这两个字段）

- [ ] **Step 3: 实现引擎钩子**

在 `Engine` 类增加两个公开字段；在 `engine.ts:159` 的 `renderer.render(...)` 之后加 `this.onAfterRender?.()`。字段名与调用位置严格按 Interfaces。

- [ ] **Step 4: 运行确认通过**

Run: `node test/photo-check.cjs && npm run typecheck && npm run build`
Expected: PASS；`dist/index.html` 仍为单文件

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts test/photo-check.cjs
git commit -m "feat(photo): 引擎增加同帧渲染后钩子与相机归属"
```

---

### Task 3: `photo` 按键与输入边缘事件

**Files:**
- Modify: `src/input/keybindings.ts:12-61`（`ACTION_LABELS` / `KeyBindings` / `DEFAULT_BINDINGS`）
- Modify: `src/input/input.ts:14-18`（`InputEdge`）、`src/input/input.ts:219-225`（switch）
- Test: `test/photo-check.cjs`（追加快照断言）

**Interfaces:**
- Consumes: 无
- Produces:
  - `GameAction` 新增 `'photo'`；`ACTION_LABELS.photo = '摄影模式'`；`DEFAULT_BINDINGS.photo = 'KeyP'`。`ACTION_KEYS` 由 `Object.keys(ACTION_LABELS)` 自动包含它。
  - `InputEdge.type` 联合新增 `'photo'`；`Input.onKey` 的 `switch(action)` 增加 `case 'photo': this.edges.push({ type: 'photo' }); break;`
  - `photo` 键沿用 `onKey` 现有的 `e.preventDefault()` 与 `keyup` 无条件删除逻辑，不写特殊分支。

- [ ] **Step 1: 写失败断言**

在 `test/photo-check.cjs` 追加：`require('./logic/input/keybindings.js')` 的 `DEFAULT_BINDINGS.photo === 'KeyP'`、`ACTION_KEYS.includes('photo')`、`ACTION_LABELS.photo === '摄影模式'`。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:snapshot && node test/photo-check.cjs`
Expected: FAIL（无 photo 字段）

- [ ] **Step 3: 实现按键接线**

按 Interfaces 改三处结构。`loadBindings()` 已有"缺字段用默认值补齐"逻辑，无需改动。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:snapshot && node test/photo-check.cjs && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/input/keybindings.ts src/input/input.ts test/photo-check.cjs
git commit -m "feat(photo): 新增可重绑定的摄影模式按键与边缘事件"
```

---

### Task 4: `PhotoMode` 运行时、覆盖层与组装根接线

**Files:**
- Create: `src/photo/PhotoMode.ts`
- Create: `src/photo/photo.css`（或并入 `src/ui/style.css`，二选一，按当前构建方式）
- Modify: `src/main.ts:80`（Mode 类型附近）、`src/main.ts:510-527`（`collectSave`）、`src/main.ts:1707-1771`（`processEdges`）、`src/main.ts:1819-1901`（系统注册）
- Test: `test/survival-smoke.mjs`（追加摄影模式断言）

**Interfaces:**
- Consumes: `canWritePlayerCamera`、`clampPhotoPosition`、`clampFov`、`TIME_PRESET_VALUES`、`nextTimePreset`、`nextWeather`、`WEATHER_CYCLE`、`photoFileName`、`photoCaption`、`PhotoMetadata`（Task 1）；`Engine.onAfterRender` / `cameraOwner`（Task 2）；`InputEdge 'photo'`（Task 3）。
- Produces（`PhotoMode` 公开面，main.ts 依赖）:
  - `active: boolean`
  - `savedDayTime: number | null`
  - `enter(): boolean` —— 仅在 `mode === 'playing'` 且无菜单 / 合成 / 方块库 / 面板打开、玩家未死亡时返回 true
  - `exit(): void`
  - `update(dt: number): void` —— System 回调，摄影模式激活时驱动相机
  - `requestCapture(withStamp: boolean): void`
  - `setTimePreset(): void` / `cycleWeather(): void` / `toggleStamp(): void`

- [ ] **Step 1: 写失败测试（浏览器冒烟）**

在 `test/survival-smoke.mjs` 增加断言序列：进入世界 → **暂停态按 `P` 不应出现覆盖层** → 恢复游玩 → 按 `P` → `#photo-overlay` 可见且 `gameHud` 带 `hud-hidden` → 记录 `player.pos` → 按住 `W` 若干帧 → `player.pos` 不变 → 按回车触发拍摄 → `window.CraftAPI.photo.lastDataUrl` 以 `data:image/png` 开头且非单一颜色 → 按 `P` 退出 → 覆盖层隐藏、`engine.cameraOwner === null`、`sky.dayTime` 与进入前一致。测试结束后把 `lastDataUrl` 置空。

- [ ] **Step 2: 运行确认失败**

Run: `xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop npm run test:smoke`
Expected: FAIL（`#photo-overlay` 不存在 / `CraftAPI.photo` 未定义）

- [ ] **Step 3: 实现 `PhotoMode` 相机与状态**

- 进入时保存：相机 `position` / `quaternion` / `fov`、`sky.dayTime`、`sky.advanceTime`、`weather.forced`、`hud.hudHidden`、指针锁定状态。
- 设置 `engine.cameraOwner = 'photo'`、`sky.advanceTime = false`、`hud.toggleHudHidden()`（若原本未隐藏）、`document.exitPointerLock()`。
- `update(dt)`：用 `input.moveX/moveZ`、`input.jumpHeld/sneakHeld` 平移相机（相对相机 yaw，无重力），`input.consumeLook()` 转向，滚轮边沿调 FOV 并 `clampFov`；水平位置经 `clampPhotoPosition(camera, player, (renderDistance - 1) * CHUNK_SIZE)` 钳制。
- 退出时恢复全部保存值、`input.reset()`、恢复指针锁定、`cameraOwner = null`。
- 玩家冻结：`main.ts` 的 `gameplay` 系统内把 `player.update(dt)` 包进 `if (!photo.active)`；其余系统（天气 / 实体 / 火焰 / 植物 / AI）继续跑。

- [ ] **Step 4: 实现覆盖层 UI 与截图管线**

- 创建 `#photo-overlay`：左上信息（坐标 / 群系 / 季节 / 天气 / 时刻）、右上按钮（拍摄 / 水印 / 退出）、底部操作提示含"自由相机：已加载区域内"；容器 `pointer-events: none`，按钮 `pointer-events: auto`。
- `requestCapture(withStamp)` 只置 `pendingCapture`，不读像素；`engine.onAfterRender` 回调内：建离屏 2D canvas → `drawImage(renderer.domElement, 0, 0)` → 可选画水印（`photoCaption`）→ `toDataURL('image/png')` → `<a download>` 点击 → 存 `lastDataUrl` 供测试 → 清空 `pendingCapture`。失败时 `hud.toast('截图失败')`，不抛异常。
- `T` / `Y` / `S` / 回车通过 `InputEdge` 之外的轻量 `keydown` 监听处理（仅 `photo.active` 时生效），避免污染 gameplay 按键表；移动端用覆盖层按钮走同一组方法。

- [ ] **Step 5: 组装根接线**

在 `main.ts` 创建 `photo` 实例并 `engine.addSystem(photo)`；`processEdges` 加 `case 'photo'` 调 `photo.enter()` / `exit()`，并在 `case 'pause'` 最前面判断 `photo.active` 时只退出摄影模式并吞掉暂停；`collectSave()` 的 `dayTime` 改为 `photo.active && photo.savedDayTime !== null ? photo.savedDayTime : sky.dayTime`；把 `photo` 挂到 `CraftAPI.photo` 供测试与控制台使用。

- [ ] **Step 6: 运行确认通过**

Run: `npm run typecheck && npm run build && xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop npm run test:smoke`
Expected: PASS；无空白截图；玩家坐标与存档时刻未被预览污染

- [ ] **Step 7: Commit**

```bash
git add src/photo/PhotoMode.ts src/photo/photo.css src/main.ts test/survival-smoke.mjs
git commit -m "feat(photo): 摄影模式运行时、覆盖层与同帧导出"
```

---

### Task 5: 运行时诊断、版本 bump 与文档

**Files:**
- Modify: `src/diagnostics/RuntimeDiagnostics.ts`（`DiagnosticSnapshot` 增可选 `photo` 字段 + 一条检查）
- Modify: `test/diagnostics-check.cjs`（注入式回归）
- Modify: `src/main.ts:1520-1589`（`collectDiagnostics` 填 `photo` 字段）
- Modify: `src/core/version.ts`、`package.json`、`README.md`、`CHANGELOG.md`
- Test: `test/diagnostics-check.cjs`、`npm run check:version`

**Interfaces:**
- Consumes: `photo.active`、`engine.cameraOwner`（Task 4）
- Produces: `DiagnosticSnapshot.photo?: { active: boolean; cameraOwner: string | null; fov: number }`；检查 id `photo-camera-owner`：`active === true` 时 `cameraOwner` 必须为 `'photo'`；`active === false` 时不得为 `'photo'`。旧快照缺 `photo` 字段时跳过。

- [ ] **Step 1: 写失败注入回归**

在 `test/diagnostics-check.cjs` 增加：注入 `photo: { active: true, cameraOwner: 'player', fov: 72 }` 应报 error 且 issue id 为 `photo-camera-owner`；注入 `active: false, cameraOwner: 'photo'` 同样报错；缺 `photo` 字段的旧快照不报错。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:snapshot && node test/diagnostics-check.cjs`
Expected: FAIL（检查项尚不存在）

- [ ] **Step 3: 实现诊断检查与快照接线**

按 Interfaces 增加可选字段与检查；`collectDiagnostics` 从 `photo` / `engine` 读取真实值填入。

- [ ] **Step 4: 版本与文档**

`src/core/version.ts` 的 `VERSION` 改为 `1.6.0-beta.3`（`RELEASE` 保持 `v1`）；同步 `package.json` 的 `version`；README 顶部版本行与版本沿革、CHANGELOG `[Unreleased]` 改为 `[1.6.0-beta.3]` 条目并写明"0 新方块 / 0 地形改动 / 0 新依赖"。所有版本断言保持动态读取，不硬编码。

- [ ] **Step 5: 全量验收**

Run: `npm run verify`
Expected: 全绿（含 `test:photo`、浏览器实景、视觉回归）；`check:version` 一致

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/RuntimeDiagnostics.ts test/diagnostics-check.cjs src/main.ts src/core/version.ts package.json README.md CHANGELOG.md
git commit -m "release: 1.6.0-beta.3 摄影模式与诊断回归"
```

---

## Self-Review

- **Spec coverage：** §2 目标全部覆盖；§5.1 模块划分对应 Task 1/4；§5.2 引擎改动对应 Task 2；§5.3 冻结玩家/不暂停世界/不写存档对应 Task 4；§5.9 相机边界对应 Task 1+4；§5.5 截图管线对应 Task 4；§5.7 测试诊断对应 Task 1/4/5；§5.8 版本文档对应 Task 5。
- **Step scan：** 每步只决定一件事；测试步骤给出断言与期望输出，代码步骤给出签名与固定值。
- **Type consistency：** `cameraOwner`、`onAfterRender`、`photo.active`、`savedDayTime`、`pendingCapture`、`canWritePlayerCamera` 等名字在各任务中一致。
- **Review Focus：** 5 条均已挂到具体任务。
- **Proportion：** 计划长度与 spec 相当，未写出程序正文。
