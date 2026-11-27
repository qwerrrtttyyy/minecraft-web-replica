# SDD 集成记录 — 2026-11-22 双线

## Controller Rulings

- **R1**: 两线隔离 worktree 并行；SDD "禁止并行实现" 仅针对同一工作树冲突，不适用。线内按卡串行。
- **R2**: 主工作树 `/workspace/minecraft-web-replica-botany` 的用户未提交变动不碰、不清理（用户已确认）。
- **R3**: 12:08 遗留的 0 字节 `.git/index.lock`（无进程持有）已删除以便 docs 提交；未触碰其他内容。
- **R4**: 每线一名 implementer 按卡实现，线末整支 review；理由：用户要求并行且计划含精确接口/判据。代价：单任务级即时 review 缺失，由线末 review 与自动护栏补偿。
- **R5**: 本机无可用浏览器；完整 `npm run verify` 必在 `test:smoke` exit 1；按已确认口径记为环境阻塞，不作完成条件。
- **R6**: worktree 共享 `.git`，并发 commit 产生瞬时 `index.lock`；遇锁先查持有进程，确认释放后重试，不盲目删除。
- **R7**: `/tmp/opencode/` 被周期性清理；所有 ledger / 报告 / 审查输入改存各 worktree 内 `SDD-*.md|txt` 持久文件。
- **R8（审查 I1）**: frost_bloom 在 snowy_tundra / snowy_taiga 的 spawn 权重被既有 frostline 规则衰减（枯死）。**裁决：不改 frostline 规则**。理由：用户明确限定"botany 只补 spawn 权重、不改规则"，且 spec 非目标写明不加新植物/规则；既有规则交互非本轮缺陷。代价：雪原 frost_bloom 权重不形成可见种群，记为已知限制写进最终文档。若用户日后想让霜花在雪原存活，属独立规则改动，另开一轮。
- **R9**: 性能基准以本线实测为准（baseline `msPerChunk = 142.56`，本机与 tuning 文档的 87.27 不同机器/口径）；1.5× 目标按本线基线计算，未达标则如实记录实际倍数。

## 合并与验收清单

- [x] integration worktree 建立（`integration/2026-11-22`，base `90ccd6c`）
- [x] `validate.py` CHECKS 扩展 7 关键词并提交 `2444672`
- [x] 群系线 Tasks 1–4 review：Spec 合规 PASS，0 Critical / 1 Important（R8 裁决）/ 2 Minor；结果 `/workspace/minecraft-web-replica-biome/SDD-REVIEW-RESULT.md`
- [ ] 群系线 Task 5 收尾
- [ ] 移动端线 Task 4 收尾
- [ ] 合并两线到 integration
- [ ] `EXPERIMENTS.md` / `CHANGELOG.md` 汇总
- [ ] 总门：`validate.py --strict`、`verify:node`、完整 `verify` 记录阻塞
