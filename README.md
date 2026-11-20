# Minecraft TS —— TypeScript 体素引擎复刻

<p align="center">
  <img src="docs/assets/showcase.gif" width="720" alt="实机演示：清晨森林 → 挖掘 → 黄昏 TNT → 星空">
</p>

<p align="center">
  <a href="https://qwerrrtttyyy.github.io/minecraft-web-replica/">在线试玩</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a> ·
  <a href="docs/TESTING.md">测试</a> ·
  <a href="docs/HISTORY.md">演进实录</a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml"><img alt="verify CI" src="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/tags"><img alt="version" src="https://img.shields.io/github/v/tag/qwerrrtttyyy/minecraft-web-replica?label=version"></a>
  <img alt="TypeScript 5.6" src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white">
  <img alt="three.js 0.170" src="https://img.shields.io/badge/three.js-0.170-049ef4?logo=threedotjs&logoColor=white">
  <img alt="runtime deps: three.js only" src="https://img.shields.io/badge/runtime%20deps-three.js%20only-2ea44f">
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> 🤖 本项目完全由 AI 生成（源码 / 测试 / 文档），人类仅提出方向；生成方式与质量边界见「[关于本项目](#关于本项目)」。
> 📖 简体中文 | [English](README_EN.md)

一个依赖极轻的体素 Minecraft 复刻：运行时唯一依赖 **three.js**，其余全部手写——体素世界、
区块流式加载、带 AO 的贪心网格化、三通道光照 BFS、程序化像素纹理、昼夜天空、物理碰撞、
实体 AI、植物生态、合成与存档。构建产物是**单个自包含 HTML**，离线、`file://` 双击即玩；
所有纹理均代码逐像素绘制，不含任何原版资源。

当前正式版：v1 ｜ 当前非正式版：1.5.0（双轨版本号，唯一来源 [`src/core/version.ts`](src/core/version.ts)）

## 特性总览

- **体素引擎**：区块流式加载（背压暂停 + 自愈重入队），数据 / 天空光 / 方块光三通道网格，
  Worker 池上跑 Greedy Meshing（quad 数约降 40%）
- **光照**：天空光 + 方块光双通道 BFS（0–15 级），增量更新，烘焙进顶点属性（零额外 draw call）
- **地形**：四阶段管线 `columns → ores → trees → decorate`，域扭曲 + `ridged fBm` 山脊与河道，
  温度 × 湿度双轴群系，渐隐洞穴，分层矿脉，跨区块树冠
- **生存循环**：生命 / 饥饿 / 呼吸 / 挖掘硬度 / 掉落入包 / 敌对生物 / 死亡重生 / 3×3 合成
- **植物生态**：随机刻引擎 + 内在能量体系（solar / hydro / fungal 三类代谢、根系共享、开花反馈）
- **91+ 方块**：全部经 `BlockRegistry` 数据驱动注册，8×8 → 16×16 程序化图集（256 槽）
- **插件体系**：服务容器 + 命名空间事件 + 热插拔插件（js / wasm:module / wasm:host 三载体），
  `window.CraftAPI` 扩展门面
- **移动端**：虚拟摇杆、动态分辨率、震动反馈、safe-area 适配
- **工程化**：`npm run verify` 一条链完成版本一致性 → 类型检查 → 构建 → 全量回归 → 浏览器实景

## 快速开始

**在线试玩（GitHub Pages）**：<https://qwerrrtttyyy.github.io/minecraft-web-replica/>

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 类型检查 + 单文件 dist/index.html
npm run verify   # 全量验收：版本 + 类型 + 构建 + 回归 + 浏览器实景
```

## 操作

| 按键 | 功能 |
| --- | --- |
| WASD / 空格 / Shift | 移动 / 跳跃（双击或 F 飞行，创造）/ 潜行 |
| 左键 / 右键 / 中键 | 破坏（按硬度计时）/ 放置、进食、采集 / 取样 |
| 滚轮 / 1-9 / E | 快捷栏 / 方块库 |
| F5 / F3 / F1 | 视角 / 调试面板 / 隐藏 HUD |
| Esc | 菜单 → 设置、工作台、按键重绑定 |

**设置页**：音效音量、FOV、渲染距离、灵敏度、画质档位、粒子、自动跳跃、触控灵敏度；
开发者组提供调试常显、Greedy 开关、网格化线程、自动保存间隔与设置导入导出。
选项原版风格双列排布（小屏单列），持久化于 `localStorage`；游戏内「关于」页
（标题屏 / 菜单 / 设置页入口）展示版本与项目信息。

## 架构

```
src/
├── core/       引擎内核：engine（渲染/调度）、types、version（★唯一版本源）
├── services/   ★ ServiceContainer / EventService（错误隔离、waitFor、stats）/ PluginService
├── api/        ★ CraftAPI 薄门面（plugins / events / settings / survival 命名空间）
├── plugins/    builtin 内置插件（autosave、hud-feedback）+ 示例
├── world/      地形 / 光照 / 网格化 / 植物生态 / 方块注册
├── gfx/  player/  entity/  input/  ui/  audio/  save/  diagnostics/
└── main.ts     ★ 组装根：建服务 → 注入 → 启插件 → 启动循环
```

依赖方向单向：`main.ts → services → api(类型) → 业务模块`；插件只依赖服务容器与
`PluginContext`。关键设计：

- **服务化扩展点**：事件与插件有身份、生命周期、依赖与权限，由 `ServiceContainer` 统一装配；
  停用插件自动撤销订阅并执行 teardown，`disable(A)` 级联停用下游依赖
- **权限白名单**：`world:write` / `player:write` / `save:write` / `blocks:register` 等未声明的
  写能力在插件上下文被拦截；读能力默认开放
- **数据驱动**：渲染 / 碰撞 / 音效 / 掉落只查 `BlockRegistry` 属性，不硬编码 id
- **烘焙光照**：面定向明暗 + 逐顶点 AO + 光照通道写入顶点属性，`MeshBasicMaterial` 无实时阴影
- **存档**：编辑差分（只记玩家改动，按 chunkKey 分桶）+ `validateSave()` 全量校验，坏档当作无存档

## 地形生成

`DefaultGenerator` 全部特征由「世界坐标 + seed」决定，区块生成顺序不影响结果。
四阶段管线 `TERRAIN_STAGES`（`columns → ores → trees → decorate`）：矿石只替换石头、
树木先于花草、装饰不覆盖树冠；地表 / 填充 / 装饰统一收进 `BIOME_PROFILES` 配置表。

- **域扭曲 + 脊线山脉 + 河道**：低频噪声扰动采样坐标；`ridged fBm` 生成山脊，`|n|≈0`
  等值线切出河谷，河谷按距海平面高度平滑淡出、不在海床拉沟
- **群系**：温度 × 湿度双轴 + 坡度决定 `ocean / beach / desert / plains / forest / taiga / alpine` 地表
- **洞穴**：脊线隧道 + 团块洞穴双 3D 噪声，按距地表深度渐隐；水下地层不挖，杜绝空气袋
- **矿脉**：煤 / 铁 / 金 / 钻 / 铜 / 红石 / 青金石 / 绿宝石按深度分层，绿宝石逐格校验群系边界
- **跨区块树木**：6×6 候选点扫描，树冠裁剪写入覆盖区块，双向无「半棵树」
- **性能**：24×24 列信息缓存 + 网格差分坡度，实测 2~6 ms / 区块（Node 纯逻辑）

可调参数经构造第三参 `TerrainOptions` 注入（`warp` / `baseHeight` / `treeDensity` / `oreRichness` 等），
详见 `src/world/generator`。

## 光照与渲染

- 双通道光照（天空光 / 方块光，0–15）由主线程 `LightEngine` 维护：天空光按列初始化后只对
  影子边界做 BFS；方块光光源 14~15 级、逐格衰减、可跨区块；`World.setBlock` 增量更新并标记脏区块
- Greedy mask key 含光照档位——光照不同的面不合并，避免插值抹平火把照亮区
- Shader 顶点属性 `aLight = (sky, block)`，亮度 `max(sky × daylight, block)`；
  夜间天空光偏蓝、日出日落按太阳色染色；萤石 / 南瓜灯走 emissive 常亮
- 单区块光照初始化 3~6 ms，方块变化更新约 1 ms（Node 实测）

## 扩展 API

全部接口挂在 `window.CraftAPI`，控制台即可试玩（完整契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：

```js
CraftAPI.on('block:break', e => console.log(e));            // 事件
CraftAPI.registerTile('ruby_ore', (set, rng) => {...});      // 逐像素程序化纹理
CraftAPI.registerBlock({ name: 'ruby_ore', hardness: 3, tiles: {...} }); // 数据驱动方块，即刻进方块库
CraftAPI.registerEntity({ id: 'cow', build() {...} });       // 自定义实体
CraftAPI.setGenerator({ generateChunk(cx, cz, data) {...} }); // 替换地形（只影响未生成区块）
CraftAPI.player.teleport(0, 50, 0);
CraftAPI.save.setProvider({ load, save, clear });             // 云存档后端
CraftAPI.engine.addSystem({ update(dt) {...} });             // 每帧更新系统

// 插件：有 id / 版本 / 依赖 / 权限 / 生命周期
CraftAPI.plugins.register({
  manifest: { id: 'demo:mining-log', version: '1.0.0', permissions: ['api:emit'] },
  setup(ctx) { ctx.events.on('block:break', e => ctx.log(e.block)); },
});
await CraftAPI.plugins.enable('demo:mining-log');

// 生态扩展（需 botany:register 权限）：注册植物特性 + 随机刻规则
CraftAPI.botany.registerPlant('my_flower', { metabolism: 'solar', bloom: 80, growthCost: 18 });
CraftAPI.botany.registerRule({ id: 'me:rule', owner: 'me:my-pack', tick: (ctx) => false });
```

事件契约在 `src/services/events/GameEvents.ts`，支持 TypeScript 声明合并追加自定义事件。

## 测试

```bash
npm run verify   # 唯一验收入口，要求浏览器测试 100% PASS
```

| 命令 | 覆盖 |
|---|---|
| `test:logic` | 生存状态机 8 组 + 地形 23 组（含性能基准、旧方块 id 兼容） |
| `test:light` / `test:mesher` | 光照 21 组；网格快照保真、Greedy 光照逐格等价、quad 收益 |
| `test:services` / `test:diagnostics` | 服务容器 / 事件 / 插件 / 存档 38 项；运行时诊断 20 组 |
| `test:terrain-system` / `test:botany` / `test:plant-energy` | 方块 id append-only 校验、生态随机刻、能量体系 |
| `test:crafting` | 配方表、有序 / 无序匹配、2×2 与 3×3 尺寸差异 43 组 |
| `test:wasm` / `test:plugin-v2` / `test:plugin-carrier` | WASM 自检回退、插件体系 v2、三载体 |
| `test:smoke` / `test:visual` | Chromium 实景 + 像素级视觉回归（Xvfb 软渲染） |

矩阵细节与固定种子规则见 [docs/TESTING.md](docs/TESTING.md)；benchmark 数字以
`test/artifacts/results.json` 实际输出为准。

## 版本规范

双轨版本号，唯一来源 `src/core/version.ts`（`check:version` 在 verify 中机械校验）：

- `vN`：正式里程碑（当前 `v1`），只在里程碑发布时推进并打同名 Git 标签
- `X.Y.Z`：迭代版（当前 `1.5.0`），日常迭代递增；预发布走
  `alpha.N → beta.N → rc.N → 正式`（如 `1.5.0-alpha.1`）

变更摘要见 [CHANGELOG.md](CHANGELOG.md)，v1.1.1 → v1.5.0 各版本演进实录见
[docs/HISTORY.md](docs/HISTORY.md)。

## 关于本项目

- **生成方式**：全部源码、测试与文档由 AI 编程代理生成，人类仅提出方向并合并；每次改动均经
  `npm run verify` 机械验收
- **质量边界**：测试覆盖核心逻辑与视觉回归，但未见过的边角行为仍可能出现；请勿用于生产环境
- 非官方学习项目，与 Mojang / Microsoft 无关；MIT License，欢迎 [参与贡献](CONTRIBUTING.md)

