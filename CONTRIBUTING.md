# 参与贡献

感谢你对 **Minecraft TS** 的兴趣！本项目是非官方学习项目，欢迎任何形式的贡献：
报告缺陷、提议功能、改进文档、提交代码，或分享你基于 CraftAPI 写的插件。

> 非官方学习项目，与 Mojang / Microsoft 无关。所有纹理均为代码逐像素绘制，
> 贡献内容**不得包含任何原版资源**（贴图、音效、模型、存档格式二进制等）。

## 开发环境

- Node.js 20+（CI 使用 Node 20）
- npm（仓库自带 `package-lock.json`，请用 `npm ci` 或 `npm install`）

```bash
npm install
npm run dev      # 开发服务器（热更新）
npm run build    # 类型检查 + 单文件构建（dist/index.html）
```

## 提交前必须通过的验证

```bash
npm run verify   # 全量核验，CI 要求 100% PASS
```

`verify` 依次执行：版本一致性（`check:version`）→ 类型检查 → 构建 → 测试快照重建 →
逻辑 / 光照 / 网格 / 服务 / 诊断 / Worker 池 / 编辑差分 / 地形 / 植物 / 能量 回归 →
生存冒烟 → 视觉回归。浏览器实景测试需要 Chromium（本地可用
`xvfb-run -a npm run test:smoke:xvfb` 复现 CI 环境）。

**CI 红灯的 PR 不会被合并**。如果你的改动只涉及文档，至少跑 `npm run check:version`
并确保 README 的两行版本标记完好。

## 动代码前必读的硬规则

改代码前请先读 [docs/PROJECT-EXPERIENCE.md](docs/PROJECT-EXPERIENCE.md)——
它是本项目踩坑后固化的工程契约，摘要如下（违反这些规则的 PR 会被直接要求返工）：

- **版本双轨单一来源**：`src/core/version.ts` 是唯一版本源。日常 PR **不要**改版本号
  （`VERSION` / `RELEASE` 的推进由维护者在里程碑提交中完成）。
- **方块 id 只追加**：内置方块 id 1..91 不能调整或重排（旧存档 `edits` 差分会指向错误方块），
  新方块只能末位追加，且必须同步测试。
- **数据 / 渲染解耦**：Worker 侧只允许依赖 `MeshSource` / `MeshSnapshot` 纯数据，
  禁止 `import three / World / TextureAtlas`。
- **测试快照目录不要手改**：`test/logic`、`test/terrain-logic` 由脚本生成。
- **新增高风险不变量时**，优先在 `src/diagnostics/RuntimeDiagnostics.ts` 增加检查，
  并在 `test/diagnostics-check.cjs` 补注入式回归。

架构背景见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，测试体系见 [docs/TESTING.md](docs/TESTING.md)。

## 提交与 PR 规范

- **提交信息**：沿用仓库现有风格——Conventional Commits 前缀（`feat:` / `fix:` / `docs:` /
  `chore:`）+ 简洁中文描述；涉及缺陷修复时在正文中写明根因与验证结果。
- **PR 范围**：一个 PR 只做一件事；大重构请先开 Issue 讨论。
- **PR 描述**：按模板填写，列出你实际跑过的验证命令与结果。
- **不改无关内容**：不要顺手重排格式、重命名既有标识符或「优化」无关代码。

## 关于 AI 辅助贡献

本项目大量代码由人类维护者与 AI 编程代理协作产出，**欢迎 AI 辅助的贡献**，但请注意：

1. **人工核验责任在提交者**：AI 生成的代码必须由你逐行读懂并验证，`npm run verify`
   全绿只是及格线，不是免责牌。
2. **如实标注**：AI 参与编写的提交请在提交信息中保留
   `Co-authored-by: traeagent` 或等价标注（沿用仓库惯例）。
3. **遵守硬规则**：AI 容易忽略「方块 id 只追加」「版本号不动」等隐式契约，
   提交前请对照上文清单与 PROJECT-EXPERIENCE.md 逐条自查。
4. **拒绝「顺手重构」**：AI 常夹带范围外的重构与格式化，请在 review 前自行剥离。

## 报告缺陷 / 提议功能

- 使用 [Issue 模板](../../issues/new/choose) 提交，缺陷报告请附 F3 面板显示的版本号
  （如 `Minecraft TS v1 (1.4.2)`）、浏览器与设备信息、复现步骤。
- 安全相关问题请勿公开提 Issue，见 [SECURITY.md](SECURITY.md)。

## 版本与发布

双轨版本号（正式版 `vN` / 迭代版 `X.Y.Z`）的完整规则见
README「版本规范」一节；历史变更见 [CHANGELOG.md](CHANGELOG.md)。

再次感谢你的贡献！
