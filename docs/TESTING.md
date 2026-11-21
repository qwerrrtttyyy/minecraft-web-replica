# 测试体系（v1.4.9）

本项目的测试全部可离线运行：纯逻辑组不依赖浏览器 / three.js，浏览器组使用
puppeteer-core + 自带 Chromium 的软件 WebGL。`npm run verify` 是唯一入口，
CI（`.github/workflows/verify.yml`）与本地必须跑同一条链。

## 一条命令与执行顺序

```bash
npm run verify
```

| # | 命令 | 内容 | 依赖快照 |
|---|---|---|---|
| 1 | `npm run check:version` | `package.json` / `src/core/version.ts` / README 版本号一致 | — |
| # | 命令 | 内容 | 依赖快照 |
|---|---|---|---|
| 1 | `npm run check:version` | `package.json` / `src/core/version.ts` / README 版本号一致 | — |
| 2 | `npm run lint` | ESLint 静态门禁（语法硬错误 / no-explicit-any / 未使用变量） | — |
| 3 | `npm run typecheck` | `tsc --noEmit`（strict） | — |
| 4 | `npm run build` | 单文件 `dist/index.html` | — |
| 5 | `npm run test:snapshot` | 从当前 TS 源码现场编译 CommonJS 快照 | — |
| 6 | `npm run test:logic` | 生存状态机（含确定性掉落） + 地形基础回归 | ✓ |
| 7 | `npm run test:drop` | 可见掉落物：确定性散开 / 拾取半径与延迟 / 同类合并 / 超时与掉出世界 / 入水终端下沉与出水重力 / 暂停不推进 age | ✓ |
| 8 | `npm run test:light` | 天空光 / 方块光 21 项 | ✓ |
| 9 | `npm run test:mesher` | 网格快照保真、Greedy 等价与收益 | ✓ |
| 10 | `npm run test:services` | 服务容器 / 事件 / 插件 / 存档校验（含可选生态字段与坏档隔离） | ✓ |
| 11 | `npm run test:diagnostics` | 运行时诊断组（健康快照 + 异常注入，含植物能量快照） | ✓ |
| 12 | `npm run test:worker-pool` | Worker 池 ACK / busy 计数 / 运行时配置同步 | ✓ |
| 13 | `npm run test:unstuck` | AABB 脱困纯逻辑回归 | ✓ |
| 14 | `npm run test:edits` | 世界编辑差分回归 | ✓ |
| 15 | `npm run test:terrain-system` | 方块扩充 + 阶段管线 + 群系配置表 + 堆肥桶 / 肥料来源（id 110~118）+ 煤矿石掉落煤炭 / 方块总数 141 | ✓ |
| 16 | `npm run test:feel` | 手感：跳跃输入缓冲（按下沿 / 120ms 窗口 / 消费 / 按住） | ✓ |
| 17 | `npm run test:botany` | 植物随机刻：生长 / 蔓延 / 枯萎 / 树苗长树 | ✓ |
| 18 | `npm run test:plant-energy` | 植物内在能量：代谢 / 蓄能 / 开花 / 采集 / 根系共享 / 季节天气 / 土壤养分 | ✓ |
| 19 | `npm run test:botany-rules` | 生态扩展点：规则注册表 / 权限 / 植物 / 规则 / 生成选种 | ✓ |
| 20 | `npm run test:smoke` | Chromium 实景（桌面 + 移动端） | — |
| 21 | `npm run test:options` | 设置页与选项持久化/行为回归 | — |
| 22 | `npm run test:visual` | 像素级视觉回归（昼夜 / 火光 / 方块墙） | — |

## 快照机制

`scripts/build-test-snapshot.mjs` 用项目自己的 `tsc` 把纯逻辑入口编译到
`test/logic/` 与 `test/terrain-logic/`，再写入 `{"type":"commonjs"}`。
两个目录都在 `.gitignore` 中，**不要手改、也不要提交**；它们唯一的作用是让
Node 测试跑在最新 TS 源码上，杜绝「测试通过但源码已改」。

新增纯逻辑入口时，把文件加进脚本的 `entries` 数组；测试里统一 require
`./terrain-logic/...` 或 `./logic/...`。

## 各测试组的职责

- **logic-check**：生存状态机（掉落 / 消耗 / 进食 / 伤害无敌帧 / 序列化）。
- **terrain-check**：确定性、生成顺序无关、高度范围、水面与洞穴顶连续、
  矿脉分层、跨区块树冠双向连续、参数开关、性能基准。
- **drop-check**：可见掉落物纯逻辑——同 seed + source + index 散开可复现、拾取半径与
  `pickupDelay` 边界、同类合并 / 异类不合并（`item:` 前缀口径）、超时与 `y<0` 消失、
  入水终端下沉 `-waterSink` 与水平 `exp(-8*dt)` 衰减、出水恢复重力，以及
  `DropManager.update(dt, pos, false)` 不推进 age（暂停期间掉落物不过期）。
- **terrain-system**：方块是否末位追加（id 45~91，v1.5.0+ 群系扩充追加 98~109，
  92~97 保留给插件）、`TERRAIN_STAGES` 顺序契约、
  `BIOME_PROFILES` 是否覆盖 11 个群系（原 7 + 恶地 / 沼泥 / 干草原 / 樱花林）
  并驱动地表 / 装饰 / 树种 / 水下植物，以及黏土（浅海床）、灰化土（针叶林地表）、
  仙人掌（沙漠 / 恶地）、甘蔗（临水浅岸）、新花卉（草甸 / 森林 / 针叶林）、
  白桦 / 云杉 / 金合欢 / 樱花（对应群系）、恶地彩色陶瓦层（`strata`）、沼泥、
  海草 / 海带 / 睡莲（海洋）与南瓜（草甸 / 森林）的生成位置约束；另断言煤矿石掉落 `item:coal`（1~2）且方块总数仍为 141。
- **botany**：平坦测试世界里的随机刻规则：甘蔗 / 仙人掌 / 竹子 / 海带长高上限、
  小麦三阶段、浆果成熟、三种树苗长成对应树种、草方块同化泥土、花草与睡莲 / 藤蔓 /
  南瓜藤 / 发光地衣的蔓延、失去支撑后的整列枯萎、`plant:grow` 事件与未加载区块隔离。
- **botany-rules**：扩展植物 id 148~153 末位追加、`PlantRuleRegistry` 动态解析 /
  多规则命中 / 按 owner 注销、`botany:register` 权限裁剪、4 条规则的确定性行为
  （异花传粉 / 夜间蔓延 / 高山霜线 / 雨天补能）、规则按 (priority,id) 排序、
  扩展上下文 day/season/weather/soil/enrichSoil、Botany 兜底分派与注销后失效、
  自然生成选种的确定性与群系 / 临水约束。
- **plant-energy**：植物特性表（solar / hydro / fungal 分类与花蜜掉落）、白天蓄能、
  夜间呼吸下限、完全黑暗 / 离水 / 火光旁的枯死、`plant:bloom` 开花事件、采集与浆果回退、
  能量不足时禁止树苗生长、向日葵根系共享、`stats()` 统计；v1.6 追加季节历法 /
  天气确定性 / 中性 env 等价、土壤养分懒初始化 / 消耗 / 施肥 / 截断、
  生态状态存档 round-trip / 坏档隔离 / 柱状锚点清理。
- **crafting-check**：配方表结构（id 唯一 / 有序与无序互斥 / 产物与数量）、有序配方的
  3×3 内偏移摆放、材料组 `#planks`、无序配方不放多余材料、L 形摆放不匹配、
  2×2 个人格与 3×3 工作台的尺寸差异，以及背包取料 → 合成 → 产出 → 扣料的完整闭环，以及煤炭 + 木棍 → 4 火把（`torch_fuel`）配方可合成。
- **light-check**：天空光列、方块光衰减、跨区块传播、放置 / 破坏后的增量回收。
- **mesher-check**：`MeshSnapshot` 保真、Greedy 面覆盖与光照逐格等价、quad 下降比例。
- **services-check**：服务容器、事件服务、插件生命周期、权限裁剪（emit 门禁 / 通道归属 /
  manifest 防篡改）、级联停用、存档校验。
- **diagnostics-check**：健康快照 + 注入异常后对应 `issue.id` 必须出现（含
  `plugins.dependency`：启用中的插件缺少已启用依赖）。
- **survival-smoke**：真实浏览器里的完整玩法链路；固定 seed=2026，条件轮询等世界收敛。
- **visual-check**：固定 seed=2026 / 时段，断言夜间变暗、火光提亮、方块墙颜色丰富。
- **experiment-3d**（`npm run test:experiment`，**不挂 `verify`**）：3D 优化的受控 A/B 测量。
  固定种子 / 相机 / 区块集合，换最小系统组并冻结水面与天空相位，同页翻转变量后比对
  帧率 / draw call / 逐通道 mesh 与顶点字节 / 归一化像素签名；自带 12 项有效性闸门
  （含「噪声底必须为零」），失败非零退出。设置与数据见 [EXPERIMENTS.md](EXPERIMENTS.md)。
- **options-check**：桌面 + 移动端两标签页；覆盖设置入口与关闭回源、音效 / 音量 / 渲染距离 /
  FOV / 灵敏度 / 反转 Y、画质档位（映射 `engine.qualityScale`）、粒子 / 视角摇晃 / 自动跳跃 /
  Greedy / 网格化线程（主线程 ↔ Worker 池）/ 自动保存间隔 / 调试信息常显，以及设置导出
  （合法 JSON）与导入（未知字段过滤 + 即时生效），最后校验 localStorage 跨刷新保留与一键重置。

## 固定种子与确定性

地形规则只依赖「世界坐标 + seed」，因此测试可以不落盘任何基准图：

| 种子 | 用途 |
|---|---|
| 2026 | 实景 / 视觉回归（出生点稳定、群系多样） |
| 777 | `terrain-system` 大范围扫描（新方块 / 植物在 ±7 区块内全部出现） |
| 4242 | `terrain-check` 群系多样性 / 矿石分层 |
| 20261115 | `botany` / `plant-energy` 平坦测试世界（种子仅控制随机刻序列） |
| 120 以内多 seed | 跨区块树冠双向连续性搜索 |

新增自然方块时，优先在 `terrain-system-check.cjs` 里断言「固定种子 + 固定半径内
一定出现」，并写清生成位置规则（群系 / 深度 / 邻水等），不要把断言放宽成「偶尔出现」。

**确定性范围澄清**：项目的确定性硬规则只约束**掉落判定**——可见掉落物的散开与新动物加权
抽取走 `dropHash(seed, source, index)`（`src/world/dropLogic.ts`），掉落路径禁止新增
`Math.random()`。既有实体 AI 的游荡 / 生成坐标 `Math.random()` 属既有技术债，本轮不动，
也不作为回归断言的目标；`test:drop` 只锁定散开 / 拾取 / 合并 / 入水 / 暂停计时等掉落判定。
繁殖择偶按实体 id 升序稳定选择，同种子同状态结果一致（`src/entity/breeding.ts`）。
所有相关数值集中在 `src/core/tuning.ts`，`DropManager`（`src/entity/droppedItem.ts`）负责
渲染与生命周期；新增纯逻辑入口才需登记 `scripts/build-test-snapshot.mjs` 的 `entries`。

## 浏览器环境

无 GPU 的 Linux / CI：

```bash
CHROME_PATH=/usr/bin/chromium MC_HEADLESS=0 MC_GL=desktop \
  xvfb-run -a -s "-screen 0 1280x760x24" npm run verify
```

- `MC_HEADLESS=0` 走 Xvfb；`MC_GL=desktop` 用 Mesa 桌面 GL。
- 纯 headless 环境需要 `--enable-unsafe-swiftshader`（脚本已内置）。
- 断言必须用 `waitForFunction` / 条件轮询等待世界收敛，禁止固定长 sleep。
- 截图与 `results.json` 写入 `test/artifacts/`（已 gitignore）。

## 新增测试的硬规则

1. 纯逻辑优先：能放进 Node 的规则不要放进浏览器组。
2. 新方块 / 新群系 / 新生成阶段必须同时更新 `test:terrain-system`；
   新增生长 / 蔓延 / 枯萎规则必须同时更新 `test:botany`；
   新增代谢类型 / 能量规则 / 采集产物必须同时更新 `test:plant-energy`。
3. 新增插件生态规则 / 扩展植物必须同时更新 `test:botany-rules`，
   并在 `scripts/build-test-snapshot.mjs` 的 `entries` 中登记纯数据入口。
4. 修复真实缺陷时补一条能复现该缺陷的回归，而不是只改实现。
5. 断言输出要带可诊断信息（坐标、种子、实际值），失败时无需加日志重跑。
6. 不提交 `test/logic`、`test/terrain-logic`、`test/artifacts`、`dist`。
7. 掉落 / 繁殖判定必须可复现：新增随机性一律走 `dropHash` / `createRng`，不要新增
   `Math.random()`；确定性硬规则只管掉落判定，既有 AI 游荡 / 生成坐标的 `Math.random()`
   不在本轮范围。新增掉落规则同时更新 `test:drop`。
8. 图集新增纹理（含新物品 tile）必须追加在全部既有 painter 之后，既有 tile 索引不变；
   方块 id 只追加，本轮方块总数仍 141、id 到 147。新增方块 / 纹理后同步更新
   `test:terrain-system` 的 id / tile 断言与本文。
