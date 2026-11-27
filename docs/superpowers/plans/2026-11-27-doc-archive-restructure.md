# 文档收敛：活文档 + 归档区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 22 份无引用的历史文档集中到 `docs/archive/2026-11/`，修正所有路径引用，让根目录与 `docs/` 顶层只剩当前口径文档。

**Architecture:** 用 `git mv` 保持历史可追溯；归档区保留原目录结构（`superpowers/specs/`、`superpowers/plans/`、`sdd/`），因此路径替换只需改前缀。新增一份归档索引，并在 `AGENTS.md` 文档索引中指向它。

**Tech Stack:** git、Markdown、Python（`docs/agent/validate.py`）、grep。无源码改动。

**Spec:** `docs/superpowers/specs/2026-11-27-doc-archive-restructure-design.md`

## Global Constraints

- 归档根目录固定为 `docs/archive/2026-11/`，内部保留 `superpowers/specs/`、`superpowers/plans/`、`sdd/` 三个子目录。
- 只移动设计文档中列出的 22 个文件；**本计划文件与对应 spec 文件不参与归档**，留在 `docs/superpowers/` 供后续 skill 按规范使用。
- 不动源码、测试代码、`package.json` 脚本、`.gitignore`；不动工具自有文件 `.atomcode/memory.md`、`.github/PULL_REQUEST_TEMPLATE.md`。
- `docs/agent/tasks/*.yaml` 与 `docs/agent/validate.py` 必须继续可用，`python3 docs/agent/validate.py` 退出码必须为 0。
- 提交信息用 `docs: ` 前缀，写清“归档历史文档并修正引用”。

## Review Focus

- `docs/agent/validate.py:368` 直接读取被移走的 mesher spec，路径不改会让 M04 的 `mesher baseline` 检查 FAIL → Task 2 末尾必须跑 `python3 docs/agent/validate.py`。
- 任务卡 `A00 / C00 / N01 / P00 / A2-5..A2-8` 的 `touch.allow` 与说明引用旧 spec 路径，漏改会让任务契约失效 → Task 2 的 grep 覆盖 `docs/agent/tasks/*.yaml`。
- spec 与 plan 互相引用旧路径，前缀替换必须保留目录结构，否则归档内部链接全断 → Task 2 用统一前缀替换而非逐文件重命名。
- `SDD-REVIEW-RESULT.md` 引用裸文件名 `SDD-REVIEW.txt`，归档后需指向 `docs/archive/2026-11/sdd/SDD-REVIEW.txt` → Task 2 单独处理裸文件名。
- 后续 skill 仍按 `docs/superpowers/specs|plans/` 新建文档；归档后这两个目录为空属预期，需在索引中说明 → Task 1 的 `docs/archive/README.md` 写明。

---

### Task 1: 归档历史文档并建立索引

**Files:**
- Create: `docs/archive/README.md`
- Move（22 个，`git mv`，目标路径如下）:
  - `docs/superpowers/specs/2026-11-21-ai-system-design.md` → `docs/archive/2026-11/superpowers/specs/`
  - `docs/superpowers/specs/2026-11-21-content-system-design.md` → 同上
  - `docs/superpowers/specs/2026-11-21-plant-system-deepening-design.md` → 同上
  - `docs/superpowers/specs/2026-11-21-pr23-good-parts-port-design.md` → 同上
  - `docs/superpowers/specs/2026-11-22-armor-tools-closure-design.md` → 同上
  - `docs/superpowers/specs/2026-11-22-mesher-hotspot-mobile-design.md` → 同上
  - `docs/superpowers/specs/2026-11-22-mesher-wasm-hotspot-design.md` → 同上
  - `docs/superpowers/specs/2026-11-22-new-biomes-expansion-design.md` → 同上
  - `docs/superpowers/plans/2026-11-21-ai-system-implementation.md` → `docs/archive/2026-11/superpowers/plans/`
  - `docs/superpowers/plans/2026-11-21-content-system-implementation.md` → 同上
  - `docs/superpowers/plans/2026-11-21-plant-system-deepening.md` → 同上
  - `docs/superpowers/plans/2026-11-21-pr23-good-parts-port.md` → 同上
  - `docs/superpowers/plans/2026-11-22-mesher-hotspot-mobile.md` → 同上
  - `docs/superpowers/plans/2026-11-22-mesher-wasm-hotspot-plan.md` → 同上
  - `docs/superpowers/plans/2026-11-22-new-biomes-expansion.md` → 同上
  - `SDD-BIOME-REPORT.md`, `SDD-INTEGRATION.md`, `SDD-MOBILE-REPORT.md`, `SDD-REVIEW-RESULT.md`, `SDD-REVIEW.txt` → `docs/archive/2026-11/sdd/`
  - `docs/HISTORY.md`, `docs/PLUGINS.md` → `docs/archive/2026-11/`

**Interfaces:**
- Consumes: 设计文档中的归档清单。
- Produces: `docs/archive/2026-11/` 下 22 个文件；`docs/archive/README.md` 索引；`docs/superpowers/specs/` 与 `plans/` 变空（git 不跟踪空目录，后续可重建）。

- [ ] **Step 1: 建立归档目录并 git mv 22 个文件**

按上面的清单逐组执行 `git mv`（不要用 `mv`，保留 rename 记录）。确认 `docs/superpowers/specs/` 与 `plans/` 中只剩下 `2026-11-27-doc-archive-restructure-design.md` 与本计划文件。

- [ ] **Step 2: 校验移动结果**

Run: `find docs/archive/2026-11 -type f | wc -l`
Expected: `22`
Run: `git status --short | grep '^R' | wc -l`
Expected: `22`

- [ ] **Step 3: 写 `docs/archive/README.md`**

内容要求：标题「历史文档归档」；一句话说明这里是历史快照、非当前口径，当前口径见 `AGENTS.md` 文档索引；按四组列出归档路径（specs / plans / sdd / 其它）并各给一句话用途；写明 `docs/superpowers/specs/` 与 `plans/` 为空是预期，后续新文档仍按原路径创建。

- [ ] **Step 4: 确认引用尚未修正（红）**

Run: `python3 docs/agent/validate.py`
Expected: FAIL，`M04.yaml` 的 `mesher baseline` 报 FAIL（spec 路径已移动）。这证明旧引用确实存在，交给 Task 2 修正。

- [ ] **Step 5: Commit**

```bash
git add -A docs/archive docs/superpowers SDD-BIOME-REPORT.md SDD-INTEGRATION.md SDD-MOBILE-REPORT.md SDD-REVIEW-RESULT.md SDD-REVIEW.txt docs/HISTORY.md docs/PLUGINS.md
git commit -m "docs: 历史 spec/plan 与 SDD 报告归档到 docs/archive/2026-11"
```

### Task 2: 修正所有路径引用

**Files:**
- Modify: `docs/agent/validate.py`（第 368 行的 spec 路径）
- Modify: `docs/agent/tasks/A00.yaml`, `C00.yaml`, `N01.yaml`, `P00.yaml`, `A2-5-core-hooks.yaml`, `A2-6-armor-closure.yaml`, `A2-7-tools-plugin.yaml`, `A2-8-armor-tools-release.yaml`
- Modify: `docs/archive/2026-11/` 下互相引用的 spec/plan 与 `sdd/SDD-REVIEW-RESULT.md`

**Interfaces:**
- Consumes: Task 1 的归档路径。
- Produces: 全仓无指向旧位置的引用；`validate.py` 恢复通过。

- [ ] **Step 1: 前缀替换**

对被跟踪的 `.md` / `.yaml` / `.py` 文件执行替换 `docs/superpowers/` → `docs/archive/2026-11/superpowers/`，但**排除**以下两个文件（它们描述历史决策，保留旧路径作为说明即可）：
`docs/superpowers/specs/2026-11-27-doc-archive-restructure-design.md`、
`docs/superpowers/plans/2026-11-27-doc-archive-restructure.md`。
可用：`git ls-files '*.md' '*.yaml' '*.py' | grep -v '2026-11-27-doc-archive' | xargs sed -i 's#docs/superpowers/#docs/archive/2026-11/superpowers/#g'`。

- [ ] **Step 2: 处理裸文件名引用**

在归档后的 `.md` 文件中，把作为路径/链接引用的 `SDD-REVIEW.txt`、`SDD-BIOME-REPORT.md`、`SDD-INTEGRATION.md`、`SDD-MOBILE-REPORT.md`、`SDD-REVIEW-RESULT.md` 改为 `docs/archive/2026-11/sdd/<文件名>`。`docs/archive/README.md` 索引里作为条目标题的文字保持原样。

- [ ] **Step 3: 确认无残留旧引用**

Run: `grep -rn --include='*.md' --include='*.yaml' --include='*.py' 'docs/superpowers/\(specs\|plans\)/' . | grep -v '^./docs/archive/' | grep -v '2026-11-27-doc-archive'`
Expected: 无输出。

- [ ] **Step 4: 运行任务卡验证器（绿）**

Run: `python3 docs/agent/validate.py`
Expected: 退出码 0，输出中无 `FAIL`；`M04.yaml` 的 `mesher baseline` 为 PASS。

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "docs: 更新归档后失效的 spec/plan/SDD 引用"
```

### Task 3: 更新入口索引并做最终验收

**Files:**
- Modify: `AGENTS.md`（§6 文档索引）

**Interfaces:**
- Consumes: Task 1 的 `docs/archive/README.md`、Task 2 的验证通过状态。
- Produces: 维护者能从 `AGENTS.md` 找到归档区。

- [ ] **Step 1: 在 AGENTS.md §6 文档索引增加归档区一行**

在表格末尾新增一行：`docs/archive/README.md` ｜ 历史 spec/plan、SDD 验收报告与旧专题文档（历史快照，非当前口径）。并在表格上方一句话说明：当前口径只认本表列活文档，其余历史材料都在归档区。

- [ ] **Step 2: 全量验收**

Run: `python3 docs/agent/validate.py && npm run verify:node`
Expected: 两者退出码均为 0，结果与文档改动前一致。

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS 索引补充历史归档入口"
```
