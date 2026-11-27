# 文档收敛：活文档 + 归档区（短设计）

日期：2026-11-27

## 意图与为什么

仓库跟踪了 41 个 Markdown，其中约 20 个没有 inbound 引用：15 份 `docs/superpowers/` 下的历史 spec/plan、4 份根目录 SDD 验收报告、`docs/HISTORY.md`、`docs/PLUGINS.md`。维护者打开仓库看到的是大量并列文档，分不清哪些是当前口径、哪些是历史快照。目标是**减少根目录与 docs 顶层的文档数量**，同时不丢历史、不改代码与硬规则。

## 目标 / 非目标 / 反目标

- 目标：根目录下只保留入口文档（README / CHANGELOG / AGENTS / CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / 语言版 README），历史材料集中到一个归档区并有索引。
- 非目标：不重写任何技术内容，不修改源码与测试，不删除 git 历史。
- 反目标：不让硬规则、测试矩阵、任务卡的引用失效；不把工具自有文件（`.atomcode/memory.md`、`.github/PULL_REQUEST_TEMPLATE.md`）纳入归档。

## 约束与已查到的事实

- `docs/agent/validate.py:368` 直接读取 `docs/superpowers/specs/2026-11-22-mesher-hotspot-mobile-design.md`。
- 任务卡 `A00 / C00 / N01 / P00 / A2-5..A2-8` 在 `touch.allow` 或说明中引用 `docs/superpowers/specs|plans/...`。
- spec/plan 之间互相引用 `docs/superpowers/specs/...` 与 `plans/...`。
- `SDD-REVIEW-RESULT.md` 引用 `SDD-REVIEW.txt`；两者都是历史验收材料。
- `docs/agent/tasks/*.yaml` 与 `validate.py` 必须继续可用。

## 方案与取舍

- **A（选定）**：`git mv` 历史文档到 `docs/archive/2026-11/`，保留内部目录结构（`superpowers/specs/`、`superpowers/plans/`、`sdd/`），用统一的路径前缀替换更新引用，新增 `docs/archive/README.md` 索引，更新 `AGENTS.md` 的文档索引。数量骤减且历史可查、git 可追溯；代价是要改一批路径引用。
- **B（否决）**：直接删除无引用文档。数量最少，但设计决策与验收记录不再随仓库分发。
- **C（否决）**：彻底重排为单一入口 + 拆分/合并核心文档。长期导航最好，但会动到硬规则与测试矩阵文档，风险与改动面过大。

## 实施要点

1. 归档清单（15 + 4 + 2 + 1 = 22 个文件）：
   - `docs/superpowers/specs/*.md`（8 份）→ `docs/archive/2026-11/superpowers/specs/`
   - `docs/superpowers/plans/*.md`（7 份）→ `docs/archive/2026-11/superpowers/plans/`
   - `SDD-BIOME-REPORT.md`、`SDD-INTEGRATION.md`、`SDD-MOBILE-REPORT.md`、`SDD-REVIEW-RESULT.md`、`SDD-REVIEW.txt` → `docs/archive/2026-11/sdd/`
   - `docs/HISTORY.md`、`docs/PLUGINS.md` → `docs/archive/2026-11/`
   - 本设计文档留在 `docs/superpowers/specs/`，不参与归档。
2. 前缀替换：在被跟踪的 `.md` / `.yaml` / `.py` 文本中，把 `docs/superpowers/` 改为 `docs/archive/2026-11/superpowers/`；`SDD-*.md|txt` 的裸文件名引用改为 `docs/archive/2026-11/sdd/<文件名>`。
3. 新增 `docs/archive/README.md`：按主题列出归档文件、一句话用途、声明“历史快照，非当前口径”，并给出新路径。
4. `AGENTS.md` §6 文档索引新增归档区一行，明确“活文档 = 被引用的那份清单”。
5. `docs/superpowers/specs/` 与 `plans/` 归档后为空（git 不跟踪空目录），后续按 skill 规范新建时自动重建。

## 验证

- `python3 docs/agent/validate.py` 通过。
- `npm run verify:node` 与前一次结果一致（纯文档改动，不应影响代码）。
- 全仓 grep 确认没有残留的旧路径引用：`docs/superpowers/(specs|plans)/` 仅出现在归档索引与本设计文档中。

## 交付

一个提交：仅文档移动 / 路径引用更新 / 索引新增，无源码改动。
