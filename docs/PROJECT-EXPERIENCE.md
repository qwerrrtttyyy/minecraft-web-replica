# mapgen · 项目级 Agent 指南

确定性程序化奇幻地图生成器（TypeScript，零运行时依赖）。核心生成（A 阶段）已完成，渲染/交互（B 阶段）待做。

**开工前先读**：`docs/PROJECT-EXPERIENCE.md`（架构、九阶段、踩坑、扩展 recipe）；B 阶段开工前先读第 11.5 节（任务卡契约审计）。
**执行任务卡**：`docs/agent/tasks/*.yaml` + `docs/agent/RUNBOOK.md`；一次只做一张卡。
**接口以任务卡 `outputs` 和源码为准**，不要凭记忆猜签名。

## 基线命令

```bash
pnpm test        # 210 passed / 16 files（单线程，约 65–95s）
pnpm typecheck   # tsc --noEmit，必须 0 error
python3 docs/agent/validate.py   # 27 张任务卡，必须 0 FAIL/WARN
```

回归门固定为 `pnpm test && pnpm typecheck`；提交命令与回归门放在同一条 `&&` 链，evidence 记录真实 exit code。

## 硬规则

- **确定性**：所有随机性走 `createRng(seed)` 或 `ctx.rng.fork(label)`；禁止 `Math.random`；排序用 `(值, 下标)` 双键。
- **阶段顺序**：`height → ocean → coast → climate → biomes → rivers → lakes → features → names`，不要随意调整；新增阶段插在因果正确的位置。
- **契约**：`WorldData` 只读、不加方法；`PixelWorldData` 四参构造（`{ seaLevel }` 在第四参）；`ctx.world` 由 `createWorld` 注入。
- **群系下标**：`BIOME_IDS` 只能末尾追加，禁止中间插入。
- **生成层无 DOM**：只有 `src/app/export-json.ts` 接触 `document/URL`；生成/序列化不得 import DOM。
- **序列化**：快照必须拷贝缓冲（`slice()`），防 `transferList` detach；JSON 不塞逐格高度（biome RLE）。
- **测试纪律**：先红后绿；红了先确认“为什么红”；green 之后不改测试迁就实现。
- **范围锁**：只改任务卡 `touch.allow` 内的文件；不新增依赖（除任务卡显式声明）。

## 当前状态（2026-11-14）

- A01–A12 完成并提交；A11 曯有假绿事故，证据已修正。
- B01–B15 未开始；**先修 11.5 的 6 个开工阻塞契约缺口，再从 `B01`（DOM 桩 + 基准）开始**。
- 无 `project.json`，尚未接入 Maker/UrhoX；当前是纯 TS 库，没有浏览器入口。
- 已知潜在问题见第 5.1 节与第 11.6 节（`setHeight` 小数坐标、`toSnapshot` 非 Pixel 丢数据、群系不可达、河流入水、256² JSON 超预算等）。

## 常用文件

| 路径 | 用途 |
|---|---|
| `src/world/generate.ts` | `createWorld` 唯一装配入口 |
| `src/generation/pipeline.ts` | 九阶段顺序 |
| `src/world/WorldData.ts` | 只读契约与 `BIOME_IDS` |
| `src/world/serialize.ts` | 快照 / JSON |
| `src/dynamic-experiments.test.ts` | 尺度/种子/边界/确定性/削减实验 |
| `.agent/evidence/` | 每张任务卡的真实执行证据与 handoff |