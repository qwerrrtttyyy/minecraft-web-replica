# HUD/UI 仿原版 + 横屏模式 + 设置纠错（本次改造说明）

## 一、HUD / UI 全面对齐 Minecraft Java 版 1.20

涉及文件：`src/ui/styles.css`、`src/ui/hud.ts`

- **菜单面板**：由 beta 期的「泥土面板」改为 Java 1.14+ 的**深灰石板面板**（程序化 CSS 噪点，无外部资源），提高不透明度避免背景透字。
- **按钮**：灰石板立体边框 + 悬停/聚焦黄绿高亮 + `» «` 侧边记号（纯 CSS `::before/::after`，不改 DOM、不影响测试选择器）。
- **HUD 经验条**：新增 Java 版标志性 HUD 元素 —— 快捷栏上方的绿色经验条与等级数字（默认 0 级），并提供 `HUD.setExperience(level, progress)` 供未来接入经验系统。
- 保持全部 class 名、DOM 结构与中文文案不变，现有测试选择器零改动。

## 二、实验性内容：横屏模式（锁定横屏 + 宽屏适配）

涉及文件：`src/core/options.ts`、`src/main.ts`、`src/ui/hud.ts`、`src/ui/styles.css`

- **设置入口**：设置页 →「实验性内容」分组新增「横屏模式」开关，默认关闭。
- **数据层**：`Options.landscapeMode` 字段，纳入默认值、`loadOptions`、`normalizeOptions`、导入/导出/重置全链路。
- **运行时**：调用 `screen.orientation.lock('landscape')` 锁定横向；不支持或被拒（桌面浏览器 / iOS）时降级为先请求全屏再锁定，仍失败则显示**「请旋转设备」提示遮罩**（带旋转图标动画），方向变化后自动重算显隐。
- **宽屏 HUD 适配**：`body` 与 `.hud-root` 双 class 驱动，横屏下重排快捷栏、经验条、状态条、提示栏、虚拟摇杆与触控按钮，并放宽菜单面板高度上限。

## 三、纠正设置系统既有错误（4 处）

1. **重置 `autoJump` 默认值错误**（`main.ts`）：移动端「重置全部设置」后自动跳跃被错误关闭，与首次进入默认值不一致；重置 fallback 补上 `autoJump: isMobile`。
2. **`applyAllSettings` 漏推 experimental**（`main.ts`）：导入/重置设置后界面显示「开」但 WASM 内核/插件载体仍关闭；补上 `wasm.setEnabled` 与 `plugins.setExperimental`。
3. **死亡界面文案误导**（`hud.ts`）：关闭「死亡保留物品」后仍提示“物品会保留”；改为按 `keepInventory` 动态显示保留/掉落。
4. **注释与实际不符**（`options.ts`）：`experimental` 注释「重启生效」改为「即时生效」。

> 过程中功能验证还发现并修复了横屏回调漏写 `settings.landscapeMode = v` 导致开关不持久化的问题。

## 四、验证结果

- `npm run verify`：**100% PASS**（29 个脚本，含 check:version / lint / typecheck / build / 全部回归 / 浏览器实景 / 设置页 50/50 / 图形 13/13），退出码 0。
- 横屏专项验证 **5/5 PASS**（默认关闭、即时生效+持久化、跨会话恢复、重置回退、死亡文案联动）。
- 横屏视觉验证：竖屏 → 旋转提示显示；横屏 → 提示消失、宽屏布局生效。

## 五、效果截图

见 `docs/screenshots/`：`ui-title.png`（标题屏）、`ui-options.png`（设置页）、`ui-hud.png`（游戏 HUD）、`ui-landscape-rotate.png`（横屏旋转提示）。

---
非官方学习项目，与 Mojang / Microsoft 无关。
