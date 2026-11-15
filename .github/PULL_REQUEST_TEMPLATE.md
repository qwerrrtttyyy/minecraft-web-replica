## 改动概述

<!-- 一两句话说明本 PR 做了什么、为什么。 -->

## 关联

<!-- 关联的 Issue，如：Closes #123。无则删除本行。 -->

## 改动范围自检（硬规则）

- [ ] 未修改 `src/core/version.ts` 与 `package.json` 的版本号（版本推进由维护者在里程碑提交完成）
- [ ] 如新增方块：仅末位追加 id，未调整或重排既有 id 1..91
- [ ] 如触碰 Worker 侧：仅依赖 `MeshSource` / `MeshSnapshot` 纯数据，未引入 `three / World / TextureAtlas`
- [ ] 未手改 `test/logic`、`test/terrain-logic` 等生成目录
- [ ] 未夹带范围外的重构 / 重排格式 / 重命名

## 验证

<!-- 列出你实际跑过的命令与结果，例如：`npm run verify` → 15 阶段全绿。 -->

- [ ] `npm run verify` 全绿（或仅文档改动时：`npm run check:version` 通过）

## AI 参与声明

<!-- AI 辅助编写请勾选，并在提交信息中保留 Co-authored-by 标注；纯人工可删除本节。 -->

- [ ] 本 PR 有 AI 参与编写，已由我逐行核验并理解全部改动

## 截图 / 录屏（如涉及画面变化）

<!-- 粘贴前后对比图，或删除本节。 -->
