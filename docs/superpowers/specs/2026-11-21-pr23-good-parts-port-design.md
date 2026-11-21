# PR #23 优良部分移植设计

日期：2026-11-21
范围：把未合并 PR #23 中经审查确认的优良改动移植到当前 `main` 工作树。

## 意图 / Why

两个 open PR 的审查已完成。**PR #20 的内容已全部落在 `main`**（`vanillaUI` 全链路、gfx 数值、5 项测试均已存在），无需移植；唯一"缺口"星透明度 0.187 本就是 PR 声称却未实现的新改动，不属于移植范畴。

**PR #23 完全不在 `main`**（无 `landscapeMode`、无 Java 1.20 样式、无经验条、4 处设置修复均未落地）。目标是把其中好的部分搬过来，并顺手修掉审查发现的缺陷，避免把 PR 的 bug 一起带进来。

## 目标 / 非目标 / 反目标

**目标**
- 落地 4 处确认正确的设置修复。
- 落地 Java 1.20 HUD/UI 视觉改版（含按钮 `» «` 记号），修好被裁切的缺陷。
- 落地标志性经验条（作为视觉占位，无运行时调用）。
- 落地横屏模式，但修掉"遮罩阻断无法关闭"和"锁定后转竖屏提示不重现"两个真实缺陷。
- 补齐横屏模式的可复现测试。

**非目标**
- 不移植 PR #23 的 >1MB 截图（违反 `AGENTS.md` r15，0.996 MiB 截图共 4 张，约 2.3 MB）。
- 不移植 PR 自带的 `docs/CHANGELOG-UI-LANDSCAPE.md`（其中"5/5 PASS"等声称无法复现）；改为在 `CHANGELOG.md` 追加一条简短说明。
- 不改版本号（沿用 PR 自检硬规则与 `CONTRIBUTING.md` 版本约定）。
- 不碰生成层 / 方块 id / Worker，不改 `src/ai/*` 等在途未提交工作。

**反目标（做了就算失败）**
- 把遮罩做成无法退出的死路；让已有测试选择器因为 class/DOM/中文文案变化而失效；产生与 `applyVanillaUI` 的重复/冲突推送。

## 约束

- 当前工作树有未提交的 AI 相关改动（`AIComponent.ts`/`AIService.ts`/`AIContext.ts`/`actions.ts`/`conditions.ts`/`test/ai-check.cjs`/`scripts/build-test-snapshot.mjs`），**只读、不修改、不提交**。
- 保持 class 名、DOM 结构、中文文案不变，确保 `test/options-check.mjs` 等现有选择器零改动。
- 所有改动先保持未提交，便于验证；是否提交、如何拆分由用户决定。
- 回归门：`pnpm test` / `npm run verify` 等以项目实际脚本为准，跑通后再交付。

## 方案（已选 A）

- **A 全量优良（已选）**：4 修复 + Java 1.20 视觉 + 经验条 + 横屏模式（均修好缺陷）+ 补测试。价值最大，缺陷已定位可修。
- B 修复+视觉：不做横屏模式，风险较低但放弃移动端实用功能。
- C 仅修复：只搬 4 处设置修复，最小改动。

选 A 的理由：横屏模式的两个缺陷根因清楚、修复局部，保留它能拿到完整功能价值。

## 落地决策（How）

### 1. 4 处设置修复（适配当前 main，不能照搬 PR 原文）

- **reset fallback**：`main.ts` 的 `onResetOptions` 改为 `normalizeOptions({}, { renderDistance: isMobile ? 3 : 5, autoJump: isMobile })`（启动处已有 `autoJump: isMobile`，无需重复）。
- **applyAllSettings 补推 experimental**：在现有 `applyAllSettings()` 中追加 `wasm.setEnabled(settings.experimental && qs.get('wasm') !== '0'); plugins.setExperimental(settings.experimental);`，**保留** 当前 main 已有的 `applyVanillaUI(settings.vanillaUI)`（PR #23 分支早于 #20，原文没有这行）。待横屏落地后再在同一函数追加 `applyLandscapeMode(settings.landscapeMode, false)`。
- **死亡文案**：`hud.ts` 的 menu-note 由硬编码 `'物品会保留在背包里'` 改为按 `getOptions().keepInventory` 动态显示保留/掉落。
- **注释**：`options.ts` 中 experimental 注释「开启后重启生效」改为「即时生效」。

### 2. Java 1.20 视觉 + 经验条

- 移植 `styles.css` 的石板面板/立体按钮/`» «` 记号/经验条样式，以及 `hud.ts` 的 XP DOM 与 `setExperience(level, progress)` API。
- **修 `» «` 裁切**：在 `.mc-btn:hover, .mc-btn:focus-visible` 规则中给 `::before/::after` 补 `width: 1em`（并保留 `overflow: hidden` 动画效果），否则记号永久 `width:0` 不可见。
- 经验条保持纯视觉：`setExperience` 保留为公开 API 但无调用点，注释说明其为未来经验系统预留（视觉默认 0 级空条）。

### 3. 横屏模式（移植并修缺陷）

- `options.ts` 增加 `landscapeMode` 字段：接口、默认值、`loadOptions`、`normalizeOptions` 全链路。
- `main.ts` 增加 `landscapeActive` / `lockLandscape()` / `needRotateHint()` / `applyLandscapeMode()`，以及 `orientationchange`、`resize` 监听；注册 `onLandscapeMode` 开关回调。
- `hud.ts` 增加 `buildRotateHint()`、`setLandscape()`、`refreshRotateHint()` 与横屏相关 CSS 类；`styles.css` 增加 `.landscape-mode` 宽屏重排与 `.rotate-hint` 样式。
- **修"锁定后转竖屏提示不重现"**：`needRotateHint()` 不再用陈旧的 `landscapeLockOk` 作为门控（锁定成功后该值永远为 true）；改为只按当前方向与开关状态判定，方向判定交给 `hud` 内部 `matchMedia` 统一处理。
- **修"遮罩阻断无法关闭"**：在旋转提示卡片内加一个「关闭横屏模式」按钮，接到 `onLandscapeMode(false)`，确保竖屏且锁定失败时用户能主动退出；保留遮罩的视觉阻断意图但提供明确出路。
- **消除重复/数据泥团**：`hud.setLandscape()` 内部调用 `refreshRotateHint()`，不再两份重复的 `matchMedia` + `style.display` 逻辑；`main.applyLandscapeMode()` 只走单一更新路径，不再 `setLandscape` 后又 `refreshRotateHint`。

### 4. 测试与文档

- 在 `test/options-check.mjs` 追加横屏模式回归（沿用 `vanillaUI` 的 5 项模式）：选项行存在、开/关即时生效 + `#ui`/`body` 类、写入 localStorage、跨会话恢复、重置回退，以及"关闭横屏模式"按钮可退出遮罩。
- `CHANGELOG.md` 追加一条简短说明，不改版本号。

## 留给实现者

- 具体 hunk 以 `git diff origin/main...origin/pr-23` 为准；当前 main 比 PR 分支新（PR 落后 33 commit），`main.ts`/`hud.ts`/`options.ts` 需按本设计的"适配当前 main"条目手工套用，不做整分支 cherry-pick。
- 移植后用现有验证脚本确认：选项回归、typecheck/build、相关视觉/UI 测试全绿；若 `» «` 或旋转提示的修复需要微调选择器，只在移植新增的样式内调整，不动既有选择器。
- 验收标准：4 处修复生效；Java 1.20 按钮记号可见；经验条显示；横屏开关可开可关、竖屏有出路、转竖屏提示可重现；新增测试通过；未触碰 AI 在途改动。
