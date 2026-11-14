# Minecraft TS —— TypeScript 体素引擎复刻

一个架构清晰、依赖极轻的前端 Minecraft 基础复刻。运行时唯一依赖为 **three.js**（渲染），
其余全部手写：体素世界、区块流式加载、带 AO 的网格生成、程序化像素纹理、昼夜天空、
物理碰撞、实体 AI、触控适配、存档与扩展 API。

**v1.1.0 新增**：完整可玩的**生存模式**（生命 / 饥饿 / 挖掘耗时 / 掉落背包 / 僵尸 / 死亡重生），
以及面向手机的**性能与交互优化**（动态分辨率、更低渲染距离与粒子预算、触控震动反馈与大按钮布局）。

**v1.3.0 渲染管线升级**：区块网格化整体迁入 **Web Worker 池**（`?worker&inline` Blob Worker，单文件
`file://` 下可直接运行；默认按 `navigator.hardwareConcurrency` 起多 Worker 池、least-busy 派发、
任一 Worker 失败即整体回退主线程），并实现 **Greedy Meshing**——按面方向做 mask
贪心合并，quad 数下降约 40%，且保证「每个面格的贴图与亮度完全不变」。

**v1.2.0 架构革新**：把**事件**与**插件**相关的 API 从 `main.ts` 中彻底独立为服务层
（`ServiceContainer` + `EventService` + `PluginService`），`CraftAPI` 退化为薄门面，
横切逻辑下沉为可启用/停用的一等公民插件；同时修复流式加载竞态与多项实测缺陷，
并把浏览器实景测试纳入 `npm run verify` 与 CI。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

> 非官方学习项目，与 Mojang / Microsoft 无关。所有纹理均为代码逐像素绘制，不含任何原版资源。

## 快速开始

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 类型检查 + 构建为单文件 dist/index.html（可直接双击打开）
```

构建产物是**自包含的单文件 HTML**（three.js 已内联），无网络、无外部资源即可运行。

## 操作

| 按键 | 功能 |
| --- | --- |
| WASD / 方向键 | 移动 |
| 空格 | 跳跃 / 水中上浮 / 飞行上升 |
| 双击空格 或 F | 切换飞行（Shift 下降，仅创造模式可用） |
| Shift | 潜行 |
| Ctrl / 双击 W | 疾跑 |
| 鼠标左键（按住） | 破坏方块（按方块硬度计时，生存模式有进度条） |
| 鼠标右键 | 放置方块 / 手持食物时进食 |
| 鼠标中键 | 取样准星方块 |
| 滚轮 / 1-9 | 切换快捷栏 |
| E | 方块库（全部注册方块，可搜索） |
| F5 | 第一 / 第三人称视角 |
| F3 | 调试面板 |
| F1 | 隐藏 HUD |
| Esc | 菜单 |

移动端：左下虚拟摇杆移动（推满疾跑），右侧空白处拖动转视角，
右下按钮为跳跃 / 破坏（长按持续挖）/ 放置（手持食物时变“进食”）/ 上升 / 下降，自带自动跳台阶。

玩法彩蛋：放置 **TNT** 后左键敲击点燃，1.6 秒后爆炸（可连锁，会波及玩家与生物）。

## 生存模式

标题页可选「生存 / 创造」，默认生存。生存模式把“挖—捡—吃—躲—死—重生”这一循环完整跑通：

| 系统 | 规则 |
| --- | --- |
| 生命 | 10 颗心 = 20 点。摔落（>3 格起算）、溺水、饥饿、僵尸攻击都会掉血；受伤有 0.32s 无敌帧并伴随红屏 + 音效 + 镜头抖动 |
| 饥饿 | 10 个鸡腿 = 20 点。移动 / 跳跃 / 挖掘累积消耗，耗尽后每 4 秒扣 1 点血；饥饿值 ≥18 且未满血时每 4 秒回 1 点血 |
| 呼吸 | 水下 15 秒氧气，耗尽后每秒扣 2 点血，浮出水面恢复 |
| 挖掘 | 每方块按 `硬度 × 1.1 秒` 计时，准星处显示进度条；半途松手保留 1 秒后清零；轻点一下只推进 0.3 秒（手机点按也能挖） |
| 掉落 | 方块与生物死亡都会掉落进背包，新获得的物品自动补进快捷栏空位；草→泥土、石→圆石、树叶 50% 掉自身 + 20% 掉苹果、玻璃/水/基岩/TNT 不掉、猪掉猪排 |
| 背包 | 快捷栏 9 格可堆叠，方块库只显示“已拥有的方块”，格子上标 xN；放置消耗、进食消耗 |
| 敌对生物 | 夜晚在玩家附近生成僵尸（绿皮、双臂前伸、白天会燃烧），追击距离 26 格，接触造成 3 点伤害、冷却 1.05 秒；创造模式左键秒杀，生存模式 3 下击杀 |
| 死亡重生 | 生命归零 → 死亡界面（死因 + 重生 / 返回标题），重生回到出生点、满血满饥饿，**背包保留** |
| 存档 | v2 版存档记录模式、生存状态（生命/饥饿/氧气/背包）、快捷栏堆叠；旧 v1 存档自动升级并进入创造模式 |

食物：苹果（+4 饥饿）、猪排（+6 饥饿）。生存模式下飞行被禁用。

## 移动端优化

- **动态分辨率**：`engine.setQualityScale()` 按帧率自动调整渲染缩放（低于 40fps 每步降 0.1，高于 58fps 每步升 0.05，下限 0.6），像素比上限 1.5，并监听 `visualViewport` 变化。
- **更省的默认预算**：渲染距离 3（桌面 5）、粒子池 380（桌面 800）、TNT 爆炸粒子 55、僵尸夜间上限 4。
- **触控体验**：按钮加大（`pointer:coarse` 媒体查询）、摇杆推满疾跑、破坏键长按持续挖、放置键随手持物切换为“进食”图标、关键操作（受伤/破坏/放置/死亡）触发 `navigator.vibrate` 震动反馈、`env(safe-area-inset-*)` 适配刘海与手势条、560px 与横屏 520px 两套紧凑布局。
- **交互修正**：拖动视角与按钮区域分离（右侧空白拖动），首次点击不会“只锁定指针不干活”。

## 架构（v1.3.0）

```
src/
├── core/                    引擎内核（不含业务横切逻辑）
│   ├── engine.ts            渲染器 / 场景 / 相机 / 系统调度 / 自适应尺寸
│   ├── types.ts             System 接口、常量、工具函数
│   ├── version.ts           ★ 全项目唯一版本来源
│   └── events.ts            兼容垫片：再导出 services/events（旧代码 / 测试快照用）
├── services/                ★ 服务层：插件与事件能力独立于此
│   ├── ServiceContainer.ts  类型安全服务注册表（provide/require/逆序 dispose）
│   ├── events/
│   │   ├── GameEvents.ts    事件契约表（支持声明合并扩展）
│   │   ├── EventService.ts  事件服务：错误隔离 / once / waitFor / onAny / stats / 深度保护
│   │   └── EventChannel.ts  命名空间订阅作用域（插件卸载即自动清理）
│   └── plugins/
│       ├── PluginContext.ts manifest / permissions / PluginContext 契约
│       └── PluginService.ts 注册 / 依赖解析 / 权限裁剪 / 启停 / 生命周期事件
├── api/                     ★ 公开门面（薄适配层，旧 22 项能力签名不变）
│   ├── CraftAPI.ts          window.CraftAPI 实现 + plugins / events 命名空间
│   └── index.ts
├── plugins/
│   ├── builtin/             一等公民内置插件（默认启用）
│   │   ├── autosave.ts      存档脏标记追踪
│   │   ├── hudFeedback.ts   事件 → HUD / 音效 / 触感
│   │   └── deps.ts          内置插件依赖契约（TOKENS.BuiltinDeps）
│   └── example/welcome.ts   插件开发示例（默认不启用）
├── world/  gfx/  player/  entity/  input/  ui/  audio/  save/   业务模块
└── main.ts                  ★ 组装根：只做「建服务 → 注入 → 启插件 → 启动循环」
```

依赖方向单向：`main.ts → services → api(类型) → 业务模块`；插件只依赖服务容器与
`PluginContext`，不 import 引擎内部实现。

### 关键设计

- **服务化扩展点**：事件不再是散落的 `new EventBus()`，插件不再是一堆自由函数。
  两者都有身份、生命周期、依赖与权限，统一由 `ServiceContainer` 装配。
- **插件可热插拔**：`CraftAPI.plugins.register/enable/disable/unload`，停用自动撤销
  事件订阅、执行 teardown；初始化失败隔离为 `failed` 并发出 `plugin:error`。
- **事件错误隔离**：单个订阅者抛错不再中断同事件其他订阅者或整帧逻辑。
- **数据驱动**：方块全部经 `BlockRegistry` 注册，渲染 / 碰撞 / 音效 / 图标只查属性，不硬编码 id。
- **三通道网格**：不透明（含镂空植物，alphaTest）/ 自发光 / 半透明（水、玻璃）。
- **烘焙光照**：面定向明暗 + 逐顶点 AO 写入顶点色，世界用 `MeshBasicMaterial`，无实时阴影开销。
- **流式加载背压 + 自愈**：dirty 积压超 24 暂停生成；视距内「已生成但无网格」的区块
  每帧自动重新入队；卸载按 `world.chunks` 遍历，杜绝幽灵区块与内存泄漏。
- **性能预算**：像素比封顶、每帧限时生成与网格化、编辑差分按 chunkKey 分桶、粒子单 draw call。
- **存档差分 + 全量校验**：只记录玩家改动；`validateSave()` 一次校验所有字段，坏档当作无存档。

## 地形生成（v1.1.2）

`DefaultGenerator` 的全部特征都由「世界坐标 + seed」决定，**区块生成顺序不影响结果**：

- **域扭曲**：先用低频噪声扰动采样坐标，消除值噪声的轴对齐方格感。
- **大陆 / 海洋 + 脊线山脉 + 河道**：大陆度控制海陆，`ridged fBm` 生成连续山脊，`|n|≈0` 等值线切出蜿蜒河谷；河谷按「距海平面高度」平滑淡出，在海岸自然收口，不会在海床上拉出深沟；高度范围约 4~66，海平面 30。
- **温度 × 湿度群系**：`ocean / beach / desert / plains / forest / taiga / alpine`。边界用噪声抖动打散；雪线、陡坡露石、沙滩与水下沙层由群系 + 坡度共同决定。
- **出生点保底陆地**：原点附近把低洼地形平滑抬到「海平面 + 3」，抬升半径带噪声扰动，岛岸不是正圆；40 个 seed 实测全部落在陆地。
- **渐隐洞穴**：脊线隧道 + 团块洞穴两种 3D 噪声，按「距地表深度」渐隐；**水下地层完全不挖**，避免形成被海水压住的空气袋（地表塌陷坑 / 水下空洞都已排除）。
- **分层矿脉**：煤（y≤52）/ 铁（≤40）/ 金（≤26）/ 钻石（≤16）/ 深层萤石晶洞，只替换石头，不会填回洞穴。
- **跨区块树木**：按 6×6 世界格候选点扫描邻域，把树冠裁剪写入每个覆盖到的区块，±x 双向都不出现「半棵树」；树密度随群系变化，陡坡不长树。
- **性能**：每区块先算一次 24×24 列信息并缓存，坡度由网格差分得到；实测约 **2~6 ms / 区块**（Node，纯逻辑，随 seed 与机型浮动）。

可调参数（`TerrainOptions`，构造 `DefaultGenerator` 时第三参传入）：

```js
new DefaultGenerator(seed, registry, {
  warp: 26,            // 域扭曲强度，0 = 关闭
  baseHeight: 32,
  continentAmp: 19,
  hillAmp: 8,
  mountainLift: 16, mountainRidgeAmp: 27,
  riverDepth: 7,
  spawnUplift: 3, spawnRadius: 82,
  treeDensity: { plains: 0.08, forest: 0.42, taiga: 0.34 },
  oreRichness: 1,      // 0 关闭矿脉
});
```

> **旧存档提示**：地形算法变更后，v1.1.1 及更早存档的 `edits` 差分仍按坐标生效，但周围自然地形会变；载入时会自动把玩家抬到新地形之上，避免卡在方块里。方块 id 未变动（矿石追加在表尾）。

## 扩展 API（为未来预留的接口）

所有接口挂在 `window.CraftAPI`，控制台即可试玩：

```js
// 1. 监听事件
CraftAPI.on('block:break', e => console.log('破坏了', e));

// 2. 注册自定义纹理 + 方块
CraftAPI.registerTile('ruby_ore', (set, rng) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = 120 + rng() * 20;
    set(x, y, (v << 16) | (v << 8) | v);           // 石头底
  }
  for (let i = 0; i < 6; i++) set(2 + (rng()*12|0), 2 + (rng()*12|0), 0xe0356a); // 红宝石
});
CraftAPI.registerBlock({
  name: 'ruby_ore', label: '红宝石矿', shape: 'cube',
  solid: true, opaque: true, liquid: false, transparentPass: false,
  lightEmission: 0, hardness: 3, sound: 'stone',
  tiles: { top: 'ruby_ore', bottom: 'ruby_ore', side: 'ruby_ore' },
});
// 新方块立即出现在方块库（E）中

// 3. 注册新实体
CraftAPI.registerEntity({
  id: 'cow', label: '牛', width: 0.9, height: 1.3, speed: 0.9,
  build() { /* 返回 { group: THREE.Group, animate(phase, moving) } */ },
});
CraftAPI.entities.spawn('pig', 5, 40, 5);

// 4. 替换地形生成器（只影响未生成区块）
CraftAPI.setGenerator({ seed: 1, generateChunk(cx, cz, data) {...}, surfaceHeight(x, z) {...} });

// 5. 世界 / 玩家 / 时间脚本
CraftAPI.world.biomeAt(120, -40);    // 'ocean'|'beach'|'desert'|'plains'|'forest'|'taiga'|'alpine'
CraftAPI.world.terrain(120, -40);    // { x, z, height, biome, temperature, humidity, slope }
CraftAPI.world.setBlock(0, 45, 0, CraftAPI.blocks.byNameGet('glowstone').id);
CraftAPI.player.teleport(0, 50, 0);
CraftAPI.player.setFly(true);
CraftAPI.time.set(0.75);            // 日落
CraftAPI.time.setDayLength(120);    // 2 分钟一天
CraftAPI.tnt.ignite(2, 40, 2);

// 6. 替换存档后端（云存档 / IndexedDB）
CraftAPI.save.setProvider({ async load(){...}, async save(d){...}, async clear(){...} });
const data = CraftAPI.save.export();

// 7. 生存模式（v1.1.0）
CraftAPI.survival.mode();                   // 'survival' | 'creative'（函数）
CraftAPI.survival.setMode('survival');      // 切换模式
CraftAPI.survival.damage(4, '测试');         // 扣血，带无敌帧
CraftAPI.survival.heal(4);
CraftAPI.survival.give('apple', 3);         // 给物品（'apple' / 'porkchop' / 'cobblestone' ...）
CraftAPI.survival.count('apple');
CraftAPI.survival.inventory();              // [{ key, count }]
CraftAPI.survival.respawn();
CraftAPI.player.breakBlock();               // 直接破坏准星方块（走掉落与背包）

// 8. 挂入自定义更新系统
CraftAPI.engine.addSystem({ update(dt, t) { /* 每帧调用 */ } });
```

事件契约位于 `src/services/events/GameEvents.ts`（`src/core/events.ts` 保留兼容再导出）。
除原有玩法事件外，v1.2.0 新增 `chunk:unloaded` / `stream:backpressure` / `service:ready` /
`plugin:registered` / `plugin:enabled` / `plugin:disabled` / `plugin:error`，
并支持用 TypeScript 声明合并追加自定义事件类型。

### v1.2.0：插件与事件成为独立服务

`CraftAPI` 之上新增两组服务入口（旧 22 项能力签名完全不变）：

```js
// 1) 插件：有 id / 版本 / 依赖 / 权限 / 生命周期，可热插拔
CraftAPI.plugins.register({
  manifest: {
    id: 'demo:mining-log', version: '1.0.0',
    permissions: ['api:emit'], dependencies: [],
  },
  setup(ctx) {
    // ctx.events 是命名空间通道，停用插件时订阅自动撤销
    ctx.events.on('block:break', (e) => ctx.log('破坏方块', e.block));
    ctx.onDispose(() => ctx.log('已停用'));
    return () => ctx.log('teardown');   // 也可直接返回清理函数
  },
});
await CraftAPI.plugins.enable('demo:mining-log');
CraftAPI.plugins.list();                    // [{ manifest, state: 'enabled' }]
CraftAPI.plugins.disable('demo:mining-log');
CraftAPI.plugins.unload('demo:mining-log');

// 2) 事件服务：异步等待 / 全局观测 / 派发统计 / 作用域订阅
await CraftAPI.events.waitFor('chunk:meshed', 3000);
const off = CraftAPI.events.onAny((type, payload) => console.log(type, payload));
CraftAPI.events.stats();                    // { emitted, subscribers, channels }
CraftAPI.events.scope('demo:ns');           // 返回 EventChannel，dispose() 一键清理
```

权限白名单 `world:write` / `player:write` / `save:write` / `api:emit` / `blocks:register`：
未声明的写能力在插件上下文里会被拦截并抛错，读能力默认开放。
内置插件 `core:autosave`、`core:hud-feedback` 就是用同一套契约实现的，见
`src/plugins/builtin/`。完整契约与迁移路径见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 已预留的未来方向

- 合成 / 工具耐久 / 护甲 / 更多怪物：生存循环已跑通，可在 `src/player/survival.ts` 与
  `src/world/blocks.ts` 的 `drops` 字段上继续叠加（见 `CraftAPI.survival`）。
- 光照传播：自发光通道已独立，可插入 `ILightEngine` 做光照扩散。
- 更多生物群系 / 结构：实现 `IWorldGenerator` 即可整体替换。
- 多人联机：世界读写集中在 `World`，编辑差分天然是同步消息格式。
- 纹理包：`registerTile` 可运行时重绘图集。
- Worker 网格化：`meshChunk` 是纯函数，可直接搬进 Web Worker。

## 测试

一条命令完成全量核验（版本一致性 → 类型检查 → 构建 → 重建测试快照 → 纯逻辑回归 → 浏览器实景）：

```bash
npm run verify
```

| 命令 | 内容 |
|---|---|
| `npm run check:version` | `package.json` / `version.ts` / README 版本号机械校验 |
| `npm run typecheck` / `build` | TypeScript strict + 单文件 `dist/index.html` |
| `npm run test:snapshot` | **从当前 TS 源码现场编译** `test/logic` / `test/terrain-logic`，杜绝手工同步漂移 |
| `npm run test:logic` | 生存状态机 8 组 + 地形 23 组（性能基准、旧 22 方块 id 兼容） |
| `npm run test:mesher` | **网格等价与收益**：快照保真、Greedy 面覆盖逐格等价、quad 下降比例 |
| `npm run test:services` | 服务容器 / 事件服务 / 插件服务 / 存档校验 31 项 |
| `npm run test:smoke` | Chromium 实景（桌面 + 移动端），结果与截图写入 `test/artifacts/` |

Linux 无 GPU 环境用软件渲染跑实景（v1.1.2 声称「本环境无法初始化 WebGL」其实是缺
`--disable-gpu-sandbox` 与 `--enable-unsafe-swiftshader`）：

```bash
CHROME_PATH=/usr/bin/chromium MC_HEADLESS=0 MC_GL=desktop \
  xvfb-run -a -s "-screen 0 1280x760x24" npm run verify
```

`.github/workflows/verify.yml` 按此配置接入 CI，要求浏览器测试 **100% PASS**。
断言总数以 `test/artifacts/results.json` 实际输出为准——文档不再手写会过时的数字。

覆盖：模式选择、血量/鸡腿/氧气 HUD、挖掘进度与掉落入包补位、放置与消耗、伤害与死亡重生、
进食、夜间僵尸生成与攻击、模式切换、存档 v2 与继续游戏、移动端摇杆/长按挖掘/按钮语义/安全区布局；
v1.2.0 另加版本一致性、服务容器注册、内置插件启用、事件派发统计、插件热注册/停用清理，
以及传送后「流式加载队列收敛且生成的区块都有网格」的轮询断言（取代固定 sleep）。
v1.3.0 再补：网格化确实跑在 Worker、Greedy 生效且有合并收益，以及 `?mesher=main&greedy=0`
的**降级路径仍能正常出网格**（Worker 在受限环境创建失败时的兜底）。

## 技术栈

- TypeScript 5.6（strict）
- three.js 0.170（唯一运行时依赖）
- Vite 5 + vite-plugin-singlefile（构建为单文件 HTML）

## 审查修复记录（v1.1.1）

按源码审查报告落地的主要修复：

- **P0** 标题页「生存 / 创造」选择真正写回状态机；有存档时「新的世界」也遵循所选模式。
- **P0** 新生成区块自身入队网格化，未生成区块的脏标记不再被提前删除；生成 / 网格化改为「整帧累计限时 4ms / 6ms」。
- **P1** 触控灵敏度不再被平方；暂停 / 死亡态冻结昼夜；Esc 与指针锁定丢失的 pause 边沿去重；进食先扣物品；模式切换按背包重建快捷栏；中键取样与方块库指派不再把物品覆盖成孤儿，方块库支持重新指派食物；`give('apple')` / `count('apple')` 可用；`entity:hurt` / `game:pause` 事件正式发出；`setFly` 遵守生存限制。
- **P2** 树叶同材质内部面剔除、区块网格不再上传无用法线、图集容量溢出报错、DDA 起点零法线命中跳过、存档 v2 字段校验、粒子淡出与帧率无关、摔落阈值对齐「>3 格」、相机 far 随渲染距离收敛、动态分辨率仅在游玩时调整、受伤 / 破坏 / 放置 / 死亡补充震动反馈。
- 测试新增 4 项回归断言：标题 UI 模式接线、两个事件可订阅、远距离传送后区块均完成网格化。

> 尚未实施（属于较大重构，建议单独排期）：`meshChunk` 搬入 Web Worker、Greedy Meshing、透明通道按距离排序、编辑差分按区块分桶、AABB 脱困。

## 地形升级记录（v1.1.2）

- 重写 `DefaultGenerator`：域扭曲高度场、脊线山脉与河道、温度/湿度群系、雪线与陡坡露石。
- 洞穴改为「随距地表深度渐隐」，新增分层矿脉与 4 种矿石方块/纹理（追加在注册表末尾，旧 id 不变）。
- 树木改为世界坐标候选点 + 邻域裁剪，**跨区块树冠连续**（原报告的遗留项已完成）。
- `World.surfaceHeight()` 与 `Player.spawn()` 改用地形高度，不再把树冠/草丛误判为地面；载入旧存档时自动抬升脱困。
- `CraftAPI.world.biomeAt()` / `terrain()` 开放群系与列信息查询。
- 出生岛抬升半径加噪声扰动，岸线不再是正圆；河道改为按陆地高度平滑淡出。
- 新增 `test/terrain-check.cjs`（**23 组断言**：确定性、生成顺序无关、群系多样性、洞穴不穿地表、矿脉分层、±x 双向跨区块树冠、参数开关、性能基准，以及下方核验项）。

### 收尾核验补修（同版本）

专项核验用大范围采样发现并修复两个隐藏缺陷：

| 问题 | 修复前 | 修复后 |
|---|---|---|
| 水下地层被洞穴挖出空气袋（46587 体素采样） | 9.20% | **0%** |
| 河道切入深海床（远场 3471 列采样） | 141 列 | **0 列** |

对应做法：水下地层 `fade = 0` 不挖洞穴；河道深度乘 `smoothstep(SEA_LEVEL-1, SEA_LEVEL+4, h)` 平滑淡出。两项均已固化为回归断言，另补充「40 个 seed 出生点均为陆地」「旧 22 方块 id 未变 / 矿石 id 23–26」「存在成片海洋」等兼容性断言。

核验结果：`tsc --noEmit`（strict）0 error；`vite build` 通过；`logic-check.cjs` 8 组 + `terrain-check.cjs` 23 组全通过；图集 31/64 格未溢出。浏览器实景冒烟测试当时未执行——v1.2.0 已定位到真实原因（缺少 `--disable-gpu-sandbox` / `--enable-unsafe-swiftshader` 两个 flag，并非环境不支持 WebGL）并跑通。

## v1.2.0 架构革新与修复记录

### 架构

| 变化 | 说明 |
|---|---|
| `services/ServiceContainer.ts` | 类型安全服务注册表（provide / require / 逆序 dispose） |
| `services/events/` | EventService：错误隔离 / once / waitFor / onAny / stats / 递归深度保护；EventChannel 命名空间作用域 |
| `services/plugins/` | PluginService：注册 / 依赖解析 / 权限裁剪 / 启停 / 生命周期事件；PluginContext 契约 |
| `api/` | CraftAPI 退化为薄门面，新增 `plugins` / `events` 命名空间，旧 22 项能力签名完全不变 |
| `plugins/builtin/` | `core:autosave`、`core:hud-feedback` 从 800 行 `boot()` 抽出，成为一等公民插件 |
| `core/events.ts` | 兼容垫片（旧代码与纯逻辑测试快照仍可用） |
| `main.ts` / `core/version.ts` | 前者退化为组装根；后者成为全项目唯一版本来源 |

### 修复与优化

| 项 | 内容 |
|---|---|
| 幽灵区块竞态 | 删除 `initialLoad()` 末尾的 `dirty.clear()`；预载期间主循环让开；每帧兜底把「已生成但无网格」的区块重新入队 |
| 流式加载 | dirty 积压 > 24 触发背压暂停生成；卸载改按 `world.chunks` 遍历，未网格化区块同样释放 |
| Pointer Lock | `requestPointerLock()` 返回的 Promise 加 `.catch()`；实现 iframe / 无头环境的拖拽视角降级（v1.1.2 里 `lockFailed`/`dragging` 是死代码） |
| 版本一致性 | `version.ts` 单一来源 + `check-version` 机械校验，修复包名 / package.json / CraftAPI / F3 四处漂移 |
| 存档 | `validateSave()` 全量字段校验，供 `load()` 与 `CraftAPI.save.import()` 共用 |
| 存档差分 | `edits` 按 chunkKey 分桶，`ensureChunk()` 从 O(全档编辑数) 降到 O(本区块编辑数) |
| UI / 状态机 | 有存档时标题模式高亮同步真实模式；`openPalette()` 补发 `game:pause` |
| 测试工程化 | 快照自动从源码编译、`npm run verify`、31 项服务单测、流式断言改轮询、CI 要求 100% PASS |

## v1.3.0 渲染管线升级记录

### Worker 化

| 项 | 内容 |
|---|---|
| 数据契约 | `meshTypes.ts`：`MeshSource` 接口 + `MeshConfig`（方块元数据 + UV 表）+ `MeshSnapshot`（1 格 halo，18×80×18 `Uint8Array`）+ `PackedGeo`（Transferable） |
| 同一份算法 | `mesher.ts` 只依赖 `MeshSource`；主线程 `WorldMeshSource` 与 Worker `SnapshotMeshSource` 共用，杜绝两套实现漂移 |
| 调度 | `?worker&inline` Blob Worker；请求代次（generation）去重、在途结果丢弃、每帧只投递预算内任务 |
| 降级 | Worker 创建/运行失败自动切主线程同步网格化；`?mesher=main` 可强制验证 |
| 卸载 | 区块卸载时取消在途任务，避免回传已删除区块的几何 |

### Greedy Meshing

| 项 | 内容 |
|---|---|
| 合并条件 | 按面方向建 mask，key = 方块 id + AO 档位；**仅四角 AO 完全相等才合并**，保证合并后双线性插值与原逐面结果一致（`flip` 恒为 false，三角化方向也不变） |
| 特殊方块 | cross 植物、液体（水面降顶）、玻璃、自发光、AO 不均的面一律走原逐面路径 |
| UV 平铺 | 合并面局部 UV 为 `0..w / 0..h`，`tiledAtlas.ts` 用 `onBeforeCompile` 注入 `fract(vMapUv)`，避免图集越界或拉伸 |
| 对照开关 | `?greedy=0` 关闭合并，用于基准与回归对照 |

### 实测

| 核验 | 结果 |
|---|---|
| 面覆盖等价（3 种子 × 2 区块 × 4 通道） | 逐格一致，亮度差 `0.0e+0` |
| 快照 vs 直读数据源 | 逐字节一致（两种 greedy 设置） |
| quad 数 | 11,526 → 6,978（**-39.5%**），最大合并面 105 格 |
| 浏览器实景 | 网格化 `mesherMode=worker`，`gen=89 / mesh=89 / dirty=0`，无幽灵区块 |

### 已知限制（带排期）

- Greedy 使单区块网格化 CPU 增加约 40%（多一次按面扫描 + 每个可见面一次 AO 计算）；因已移出主线程，
  渲染不再被阻塞。v1.3.0 已按 `navigator.hardwareConcurrency` 起 **Worker 池**（least-busy 派发，
  `?workers=N` 可覆盖）解除单 Worker 吞吐上限，8 核环境流式加载收敛随核数线性提升。
- 透明通道未按距离排序，重叠玻璃可能闪烁。
- 无 AABB 脱困：被方块挤住时需手动挖开。
- 软件渲染下 FPS 约 10，引擎把 `dt` 钳制到 0.05 防穿墙，游戏时间流速约为真实的一半；
  不影响真实浏览器，但自动化测试必须按条件轮询而非固定 sleep。

## v1.3.0 网格化 Worker 池记录

v1.3.0 把网格化搬进单个 Blob Worker，解除了主线程阻塞，但单 Worker 仍是流式加载吞吐的上限
（多核机器只有一个核在干活）。v1.3.0 把单 Worker 升级为**多 Worker 池**：

| 项 | 内容 |
|---|---|
| 池大小 | 默认 `min(navigator.hardwareConcurrency - 1, 4)`（留 1 核给主线程，至多 4）；`?workers=N` 可覆盖，夹紧 1..8，便于基准对照 |
| 派发 | `pickWorker()` 选「在途任务数最少」的 Worker（least-busy），避免重区块堆积在某一核 |
| 计数 | 请求带 `wid`，Worker 原样回显；`drainResults` 按 `wid` 回退在途计数，保证计数与派发一致 |
| 降级 | 任一 Worker 构造或运行失败 → `fallbackToMain()` 终止整池并同步补算；`?mesher=main` 仍可强制 |
| 零改动 | `mesher.ts` / `mesh.worker.ts` / 契约（`MeshSource` / `MeshSnapshot` / `PackedGeo`）完全不动，池只是调度层 |

### 实测（v1.3.0 实景）

| 核验 | 结果 |
|---|---|
| 网格化默认在 Worker 池 | `mesherMode=worker`，`workerCount=4`（8 核机） |
| 流式收敛 | `gen=89 / mesh=89 / dirty=0`，无幽灵区块 |
| Greedy 收益不受影响 | `quads=223546 / merged=169465`，亮度差 `0.0e+0` |
| 降级路径 | `?mesher=main&greedy=0` 仍正常出网格（`mesh=89 / merged=0`），无运行时错误 |
| 回归 | 版本一致 / tsc 0 error / 构建单文件 638KB / 逻辑 23 / mesher 43 / 服务 31 / 实景 87 全部 0 失败 |

## v1.3.0 性能优化记录

同一版本号下的纯性能优化：玩法、确定性、公共 API 与网格输出均不变。
验收口径为「优化前后网格输出逐字节一致」——3 个种子 × 9 个区块 × greedy/legacy 两种配置，
共 270/270 项哈希完全一致。

| 优化点 | 内容 |
|---|---|
| `buildMeshSnapshot` | 中心 16×16 按 y 行整段 `set`，halo 直接读 3×3 邻居的 `chunk.data`，移除逐格 `world.getBlock` 的字符串 key 查找 |
| 方块注册表 | 稠密 id 数组 + `opaque`/`solid` 字节标志快路径；自定义 id ≥ 65536 自动回退 `Map`，避免稀疏大数组 |
| Worker 数据源 | `SnapshotMeshSource` 预计算 id → 遮光字节表，AO 每面 12 次采样不再走 `def()` 属性链 |
| mesher 分配 | 逐面 / 逐顶点临时数组改为模块级 scratch，`pushQuad` 直接写入通道数组；AO 写入预分配 `Int32Array` |
| 生成器缓存 | 超限时淘汰最旧 1/4，而不是 `clear()` 整表，消除邻区块复用时周期性重算尖峰 |
| 天空 | 每帧不再 `new Vector3` / `new Color`，复用临时对象 |
| 实体 | 离场时释放每个实例新建的 geometry / material / texture，修复反复刷新种群的 GPU 资源泄漏 |

### A/B 基准

5 轮交替执行取全局最小值；本机为 3 核共享环境，绝对值受负载影响，只看相对变化。

| 项 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| `buildMeshSnapshot` | 0.928 ms/区块 | 0.173 ms/区块 | **-81%** |
| mesher 逐面（legacy） | 7.20 ms | 6.64 ms | -7.8% |
| mesher greedy | 10.03 ms | 8.68 ms | -13.5% |
| `BlockRegistry.isOpaque` | 25.1 ns | 8.1 ns | -68% |
| `BlockRegistry.isSolid` | 25.2 ns | 6.7 ns | -73% |
| `BlockRegistry.get` | 24.1 ns | 18.2 ns | -24% |
| `World.isSolidAt` | 149.4 ns | 111.5 ns | -25% |
| `World.getBlock` | 基本持平 | 基本持平 | — |

### 回归结果

| 项 | 结果 |
|---|---|
| 网格输出哈希 | 270/270 逐字节一致 |
| 版本一致 / 类型检查 | `check:version` 通过，`tsc --noEmit` 0 error |
| 逻辑 / mesher / 服务 | 23 / 43 / 31 项全部通过 |
| 构建 | `dist/index.html` 641.05 kB（单文件） |

---

内容由 AI 生成