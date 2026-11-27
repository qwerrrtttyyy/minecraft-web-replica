# PR #23 优良部分移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PR #23 的 4 处设置修复、Java 1.20 视觉、经验条与横屏模式（修复审查发现的缺陷后）移植到当前 `main` 工作树，并补齐可复现测试。

**Architecture:** PR #23 比当前 main 落后 33 个 commit，不能整分支 cherry-pick；逐 hunk 手工套用，并按当前 main 的既有结构适配（保留 `applyVanillaUI` 等 main 已有逻辑）。横屏模式的显隐判定收敛为"当前方向 + 开关状态"单一路径，旋转提示提供明确的退出按钮。

**Tech Stack:** TypeScript + Vite；浏览器回归用 puppeteer-core（`test/options-check.mjs`）；风格用 Biome/ESLint。

**Spec:** `docs/archive/2026-11/superpowers/specs/2026-11-21-pr23-good-parts-port-design.md`

## Global Constraints

- 开工前先读 `docs/PROJECT-EXPERIENCE.md`（硬规则全文与已知坑），并先跑 `npm run typecheck` 确认基线干净。
- 不改版本号：`src/core/version.ts` 与 `package.json` 的版本号不动。
- 不改方块 id、atlas 图块顺序、Worker、生成层。
- 保持 class 名、DOM 结构、中文文案不变，确保现有测试选择器零改动。
- 不碰工作树中未提交的 AI 改动：`src/ai/*`、`test/ai-check.cjs`、`scripts/build-test-snapshot.mjs`。
- **改动保持未提交**（用户已批准的设计），不执行 `git commit`；是否提交、如何拆分由用户决定。
- 回归门：`npm run verify` 全绿（含 check:version / lint / typecheck / build / snapshot / options / visual 等）。

## Review Focus

- 竖屏且锁定失败时，旋转提示遮罩盖住设置页导致无法退出 → Task 3 测试：移动端 viewport 开启横屏后，点击提示卡片内「关闭横屏模式」按钮可退出（遮罩隐藏、body class 移除、localStorage 回 false）。
- 锁定成功后物理转回竖屏，提示不再出现（陈旧 `landscapeLockOk` 门控）→ Task 3 测试：`needRotateHint()` 不含 `landscapeLockOk`；方向变为 portrait 时提示可重现。
- `» «` 记号被 `width:0` 永久裁切 → Task 2 测试：`.mc-btn:hover`/`:focus-visible` 时 `::before/::after` 的计算 `width > 0`。
- 导入设置后 `experimental:true` 未推到 WASM/插件载体 → Task 1 测试：导入含 `experimental:true` 的设置后， `__mc.services` 中 WASM 后端处于启用状态且插件载体已启用。
- 重置全部设置后移动端 `autoJump` 被关 → Task 1 测试：移动端页关闭 autoJump 后点「重置全部设置」，localStorage 中 `autoJump === true`。

---

### Task 1: 4 处设置修复（适配当前 main）

**Files:**
- Modify: `src/core/options.ts:47`（注释）
- Modify: `src/main.ts:667`（`onResetOptions` 的 normalize fallback）
- Modify: `src/main.ts:767-790`（`applyAllSettings`）
- Modify: `src/ui/hud.ts:1184` + `showDeath()`（死亡文案动态化）
- Test: `test/options-check.mjs`（移动端段 + 导入段）

**Interfaces:**
- Consumes: `normalizeOptions(fallback, base)`、`loadOptions(fallback)`、`HUD.getOptions()`（经 `opts`）、`window.__mc.services`、`window.__mc.hud`。
- Produces: 无新增公开 API；`Options.experimental` 语义变为即时生效。

- [ ] **Step 1: 写失败测试（options-check.mjs）**

在移动端段末尾（现有移动端断言之后、`ok('设置页测试无运行时错误', ...)` 之前）加入：

```js
  // 重置全部设置后，移动端 autoJump 应保持开启
  await clickRow(mob, '自动跳跃');            // 先关掉
  await clickText(mob, '.options-panel .options-footer .mc-btn', '重置全部设置');
  const resetAuto = await mob.evaluate(() =>
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').autoJump);
  ok('重置全部设置后移动端 autoJump 仍开启', resetAuto === true, `autoJump=${resetAuto}`);
```

修改桌面端"导入设置应用并持久化"用例的 payload：把 `JSON.stringify({ volume: 42, invertY: true, bogusField: 1 })` 改为 `JSON.stringify({ volume: 42, invertY: true, experimental: true, bogusField: 1 })`；并在该用例的 `ok(...)` 之后加入：

```js
  // 导入 experimental:true 后必须推到 WASM 与插件载体
  ok('导入设置后 experimental 推到 WASM/插件载体', await page.evaluate(() => {
    const wasm = window.__mc.services.optional({ key: 'wasm' });
    return wasm?.getState() !== 'disabled' && window.__mc.plugins.getExperimental() === true;
  }));
  // 恢复，避免 experimental 开启影响后续用例
  await clickText(page, '.options-panel .menu-row .mc-btn', '导入设置');
  await page.waitForFunction(() => document.querySelector('.options-io-overlay')?.style.display !== 'none');
  await page.evaluate(() => {
    const ta = document.querySelector('.options-io-overlay textarea');
    ta.value = JSON.stringify({ experimental: false });
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.options-io-overlay .mc-btn')].find((b) => b.textContent.includes('应用'))?.click();
  });
  await sleep(200);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && npm run test:options`
Expected: FAIL — 重置后 `autoJump=false`；导入后 WASM/插件未启用。

- [ ] **Step 3: 实现 4 处修复**

1. `src/core/options.ts:47`：注释「（默认关闭，开启后重启生效）」→「（默认关闭，即时生效）」。
2. `src/main.ts:667`：`normalizeOptions({}, { renderDistance: isMobile ? 3 : 5 })` → `normalizeOptions({}, { renderDistance: isMobile ? 3 : 5, autoJump: isMobile })`。
3. `src/main.ts` 的 `applyAllSettings()`：在 `applyMesherThreads(settings.mesherThreads);` 之后插入：
   ```ts
   // 实验性内容：导入 / 重置也必须推到 WASM 内核与插件载体
   wasm.setEnabled(settings.experimental && qs.get('wasm') !== '0');
   plugins.setExperimental(settings.experimental);
   ```
   **保留**该函数末尾已有的 `applyVanillaUI(settings.vanillaUI);`。
4. `src/ui/hud.ts`：将 `buildDeath()` 中硬编码的 `panel.appendChild(h('div', 'menu-note', '物品会保留在背包里'));` 改为 `this.deathNote = h('div', 'menu-note', ''); panel.appendChild(this.deathNote);`（字段声明 `private deathNote!: HTMLElement;`），并在 `showDeath(cause)` 中按 `this.opts.getOptions().keepInventory` 设置 `'物品会保留在背包里'` / `'物品已从背包掉落（原版规则）'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && npm run test:options`
Expected: 新增 2 项 PASS；既有 50 项不回归。

- [ ] **Step 5: 验证并保持未提交**

Run: `npm run typecheck && npm run lint`
Expected: 0 error / 0 lint 问题。不执行 `git commit`。

---

### Task 2: Java 1.20 视觉 + 经验条（修 `» «` 裁切）

**Files:**
- Modify: `src/ui/styles.css`（石板面板、立体按钮、`» «`、`.xp-*` 样式）
- Modify: `src/ui/hud.ts`（XP DOM、`setExperience`）

**Interfaces:**
- Consumes: `h()` DOM helper、`gameHud` 容器。
- Produces: `HUD.setExperience(level: number, progress: number): void`（公开，无调用点，视觉占位）。

- [ ] **Step 1: 写失败测试（视觉/样式）**

在 `test/options-check.mjs` 桌面端现有 UI 断言后加入（设置页此时已打开，`.options-panel .mc-btn` 存在）：

```js
  const btnSel = '.options-panel .mc-btn';
  const markerBefore = await page.evaluate((sel) =>
    parseFloat(getComputedStyle(document.querySelector(sel), '::before').width), btnSel);
  await page.hover(btnSel);
  const markerHover = await page.evaluate((sel) =>
    parseFloat(getComputedStyle(document.querySelector(sel), '::before').width), btnSel);
  ok('Java 1.20 按钮 » 记号在悬停时可见', markerBefore === 0 && markerHover > 0,
    `before=${markerBefore} hover=${markerHover}`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && npm run test:options`
Expected: FAIL — `w1 === '0px'`（伪元素被永久裁切）。

- [ ] **Step 3: 实现视觉与经验条**

1. 从 `origin/pr-23:src/ui/styles.css` 移植石板面板、立体按钮、`.xp-wrap/.xp-level/.xp-bar/.xp-fill` 等样式块。
2. **修裁切**：在 `.mc-btn:hover, .mc-btn:focus-visible` 规则内为 `::before/::after` 增加 `width: 1em;`（保留 `overflow: hidden` 的过渡效果）。
3. 从 `origin/pr-23:src/ui/hud.ts` 移植 XP DOM 构建（`xpWrap/xpLevel/xpBar/xpFill` 字段 + `gameHud.appendChild(this.xpWrap)`）与 `setExperience(level, progress)` 方法体；保留其"本项目暂无经验系统，默认 0 级空条"的注释。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run build && npm run test:options && npm run test:visual`
Expected: 新增记号测试 PASS；视觉快照 13/13 不回归（若 XP 条改变快照基线，仅更新对应快照项）。

- [ ] **Step 5: 验证并保持未提交**

Run: `npm run typecheck && npm run format:check`
Expected: 0 error；格式检查通过。

---

### Task 3: 横屏模式（数据层 + HUD + 运行时，修两个缺陷）

**Files:**
- Modify: `src/core/options.ts`（`landscapeMode` 全链路）
- Modify: `src/ui/hud.ts`（`onLandscapeMode`、`rotateHint`、`setLandscape`、`refreshRotateHint`、退出按钮）
- Modify: `src/ui/styles.css`（`.landscape-mode` 宽屏重排、`.rotate-hint`）
- Modify: `src/main.ts`（`landscapeActive`、`lockLandscape`、`needRotateHint`、`applyLandscapeMode`、监听、`onLandscapeMode` 回调）

**Interfaces:**
- Consumes: `Options.landscapeMode`、`HUD` 构造 `opts.onLandscapeMode`、`screen.orientation`、`matchMedia`、`isMobile`、`settings`、`wasm`、`qs`。
- Produces:
  - `HUD.setLandscape(active: boolean, showRotate: boolean): void`（内部调用 `refreshRotateHint`）
  - `HUD.refreshRotateHint(active: boolean, showRotate: boolean): void`
  - `Options.landscapeMode: boolean`
  - 旋转提示卡片内按钮文案固定为「关闭横屏模式」。

- [ ] **Step 1: 写失败测试（options-check.mjs 移动端段）**

```js
  // 横屏模式：开关可见、即时生效、持久化
  ok('设置页含「横屏模式」选项行', await mob.evaluate(() =>
    [...document.querySelectorAll('.options-panel .opt-row .opt-label')]
      .some((e) => e.textContent === '横屏模式')));
  await clickRow(mob, '横屏模式');
  await sleep(200);
  const landOn = await mob.evaluate(() => ({
    body: document.body.classList.contains('landscape-mode'),
    hud: document.querySelector('.hud-root')?.classList.contains('landscape-mode'),
    saved: JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode,
    hint: getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none',
  }));
  ok('横屏模式即时挂 class 并写入 localStorage',
    landOn.body && landOn.hud && landOn.saved === true, JSON.stringify(landOn));
  ok('竖屏且锁定失败时显示旋转提示', landOn.hint, JSON.stringify(landOn));

  // 遮罩阻断时必须能主动退出
  await clickText(mob, '.rotate-hint button', '关闭横屏模式');
  await sleep(200);
  ok('「关闭横屏模式」按钮可退出遮罩', await mob.evaluate(() =>
    !document.body.classList.contains('landscape-mode') &&
    getComputedStyle(document.querySelector('.rotate-hint')).display === 'none' &&
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode === false));
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && npm run test:options`
Expected: FAIL — 无「横屏模式」选项行 / 无 `.rotate-hint`。

- [ ] **Step 3: 实现数据层与 HUD**

1. `src/core/options.ts`：接口加 `landscapeMode: boolean`（注释「锁定设备横屏并启用宽屏 HUD 布局，即时生效」），`DEFAULT_OPTIONS` 加 `landscapeMode: false`，`loadOptions` 与 `normalizeOptions` 各加一行 `landscapeMode: bool(o.landscapeMode, base.landscapeMode)` / `bool(base.landscapeMode, DEFAULT_OPTIONS.landscapeMode)`。
2. `src/ui/hud.ts`：按 PR #23 移植 `HUDOptions.onLandscapeMode`、`landscapeRow`/`syncOptions` 显示、`buildRotateHint()`、`setLandscape()`、`refreshRotateHint()`、`.landscape-mode` 相关 class；**修改**：
   - `buildRotateHint()` 在卡片内追加 `this.mcButton('关闭横屏模式', () => this.opts.onLandscapeMode(false), 'mc-btn-big')`。
   - `setLandscape(active, showRotate)` 只切换 `.landscape-mode` class，然后调用 `this.refreshRotateHint(active, showRotate)`；删除其内部重复的 `matchMedia`/`style.display` 代码。
   - `refreshRotateHint` 保留为唯一的显隐更新路径（`matchMedia('(orientation: portrait)')` + `active && showRotate && portrait`）。

- [ ] **Step 4: 实现 main.ts 运行时**

1. 按 PR #23 移植 `landscapeActive`、`lockLandscape()`、`applyLandscapeMode()`、`orientationchange`/`resize` 监听、启动调用 `applyLandscapeMode(settings.landscapeMode, false)`。
2. **`needRotateHint()` 去掉 `!landscapeLockOk` 门控**：改为 `const needRotateHint = () => landscapeActive && isMobile;`（portrait 判定交由 `hud.refreshRotateHint` 内部 `matchMedia` 统一处理），这样锁定成功后再转竖屏也能重现提示。
3. `applyLandscapeMode()` 内只调用一次 `hud.setLandscape(v, needRotateHint())`；在 `lockLandscape().then(...)` 与方向监听中只调用 `hud.refreshRotateHint(landscapeActive, needRotateHint())`，删除 PR 中 `setLandscape` 后又 `refreshRotateHint` 的重复调用。
4. 在 HUDOptions 对象里（紧邻 `onVanillaUI`）注册：
   ```ts
   onLandscapeMode: (v) => {
     settings.landscapeMode = v;
     applyLandscapeMode(v, true);
     persistOptions(settings);
     hud.toast(v ? '横屏模式：已开启（将尝试锁定横向）' : '横屏模式：已关闭');
     markDirty();
   },
   ```
5. 在 `applyAllSettings()` 中（Task 1 插入的 experimental 推送之后）追加 `applyLandscapeMode(settings.landscapeMode, false);`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run build && npm run test:options`
Expected: 新增 4 项 PASS；既有选项测试不回归。

- [ ] **Step 6: 验证并保持未提交**

Run: `npm run typecheck && npm run lint`
Expected: 0 error / 0 lint 问题。

---

### Task 4: 回归测试补全 + CHANGELOG

**Files:**
- Test: `test/options-check.mjs`（补齐持久化/跨会话/重置回退断言）
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–3 产出的 `landscapeMode` 开关与 `window.__mc.hud`。
- Produces: 无。

- [ ] **Step 1: 写失败测试（补齐断言）**

在 Task 3 的横屏测试后追加：

```js
  // 跨会话恢复：清一次 localStorage 标签标记后重新加载，设置应保留
  await mob.evaluate(() => localStorage.setItem('minecraft-ts-options-v1',
    JSON.stringify({ ...JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}'), landscapeMode: true })));
  await mob.reload({ waitUntil: 'load' });
  ok('横屏模式跨会话恢复', await mob.evaluate(() =>
    document.body.classList.contains('landscape-mode')));

  // 重置回退到默认关闭（reload 后设置页已关闭，先重新打开）
  await clickText(mob, '.title-links .link-btn', '设置');
  await sleep(300);
  await clickText(mob, '.options-panel .options-footer .mc-btn', '重置全部设置');
  ok('重置后横屏模式回退为关闭', await mob.evaluate(() =>
    !document.body.classList.contains('landscape-mode') &&
    JSON.parse(localStorage.getItem('minecraft-ts-options-v1') || '{}').landscapeMode === false));
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build && npm run test:options`
Expected: FAIL（新断言尚未被满足或测试未接入）。

- [ ] **Step 3: 修正实现并补 CHANGELOG**

1. 若跨会话恢复失败，检查 `applyAllSettings()` 中 `applyLandscapeMode(settings.landscapeMode, false)` 是否在启动路径被调用；若重置失败，检查 `normalizeOptions` 的 `landscapeMode` 默认值是否为 `false`。
2. `CHANGELOG.md`：在最新版本的变更列表中追加一条，例如 `移植 PR #23：Java 1.20 HUD/UI、经验条、横屏模式与 4 处设置修复（含旋转提示退出按钮）`；**不改版本号**。

- [ ] **Step 4: 完整回归**

Run: `npm run verify`
Expected: 全绿，退出码 0。若 `test:ai:vitest` 因工作树在途 AI 改动失败，单独复核并在交付说明中标明，不修改 AI 文件。

- [ ] **Step 5: 交付前检查**

确认：`git status --porcelain` 中只包含 PR 涉及文件 + 本设计/计划文档；AI 在途改动仍原样存在且未被提交；不做 `git commit`。
