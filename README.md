# Minecraft TS —— TypeScript 体素引擎复刻

一个架构清晰、依赖极轻的前端 Minecraft 基础复刻。运行时唯一依赖为 **three.js**（渲染），
其余全部手写：体素世界、区块流式加载、带 AO 的网格生成、程序化像素纹理、昼夜天空、
物理碰撞、实体 AI、触控适配、存档与扩展 API。

**v1.1.0 新增**：完整可玩的**生存模式**（生命 / 饥饿 / 挖掘耗时 / 掉落背包 / 僵尸 / 死亡重生），
以及面向手机的**性能与交互优化**（动态分辨率、更低渲染距离与粒子预算、触控震动反馈与大按钮布局）。

**v1.2.0 新增**：**天空光 + 方块光传播**（洞穴自然变暗、火把/南瓜灯照亮周围）、
**火把**与**南瓜灯**两种光源方块；同时修复僵尸模型位置、死亡存档续玩卡死、
新世界/导入存档被卸载保存覆盖，并把编辑差分改为按区块分桶。

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

## 架构

```
src/
├── core/            引擎主循环、类型常量、类型安全事件总线
│   ├── engine.ts    渲染器 / 场景 / 相机 / 系统调度 / 自适应尺寸
│   ├── events.ts    GameEvents 事件表（所有玩法钩子）
│   └── types.ts     System 接口、常量、工具函数
├── world/           体素世界
│   ├── blocks.ts    方块注册表 + 内置 28 种方块（含 4 种矿石、2 种光源）
│   ├── world.ts     区块容器、方块读写、编辑差分、DDA 射线
│   ├── generator.ts IWorldGenerator 接口 + 默认地形（群系/域扭曲/脊线山脉/洞穴/矿脉/跨区块树）
│   ├── noise.ts     可播种 2D/3D 值噪声 + fBm + ridged fBm
│   ├── mesher.ts    隐藏面剔除 + 逐顶点 AO + 天空光/方块光采样 + 三渲染通道
│   ├── light.ts     天空光 / 方块光 BFS 传播与增量更新（跨区块）
│   ├── chunkManager.ts  按玩家位置流式生成/网格化/卸载（每帧限时）
│   └── faces.ts     立方体面几何定义（网格与图标共用）
├── gfx/             渲染表现
│   ├── atlas.ts     程序化 16×16 像素纹理图集 + 等距物品图标
│   ├── sky.ts       渐变天穹 / 方形日月 / 星空 / 体素云 / 昼夜循环
│   └── particles.ts 粒子池（方块碎屑、爆炸）
├── player/          玩家
│   ├── player.ts    物理、第一/第三人称、挖掘计时、放置/进食、攻击生物、手持物品
│   ├── survival.ts  生存状态机：生命 / 饥饿 / 氧气 / 背包 / 伤害 / 死亡重生
│   └── physics.ts   共享 AABB 体素碰撞（玩家与实体共用）
├── entity/          实体系统
│   ├── entity.ts    Entity / EntityManager / 随机漫步 AI / 僵尸 / 战斗掉落 / 夜间种群维持
│   ├── models.ts    史蒂夫风格玩家模型、猪、羊
│   └── tnt.ts       点燃的 TNT 实体
├── input/           统一输入层（键鼠 / 触控映射到同一动作状态）
│   └── touch.ts     虚拟摇杆、视角拖动、动作按钮、震动反馈
├── ui/              HUD、标题屏、方块库、菜单、样式（原版风）
├── audio/           WebAudio 程序化音效（零资源）
├── save/            ISaveProvider 接口 + localStorage 实现
├── api.ts           window.CraftAPI 公开扩展接口
└── main.ts          装配与游戏状态机
```

### 关键设计

- **数据驱动**：方块全部经 `BlockRegistry` 注册，渲染 / 碰撞 / 音效 / 图标只查属性，不硬编码 id。
- **三通道网格**：不透明（含镂空植物，alphaTest）/ 自发光（萤石夜晚恒亮）/ 半透明（水、玻璃）。
- **烘焙光照**：面定向明暗 + 逐顶点 AO + 天空光/方块光采样写入顶点属性，世界用 `MeshBasicMaterial`，
  无实时阴影开销；天空光随昼夜变化、方块光（火把/南瓜灯）恒定，实体用 Lambert 受太阳/半球光照明。
- **性能预算**：像素比封顶（桌面 2 / 移动 1.5）、每帧限时生成与网格化、远处区块自动卸载、
  几何体与材质复用、粒子单 draw call。
- **存档差分**：只记录玩家改动过的方块 + 玩家状态，localStorage 即可，体积通常 < 100KB。

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

## 光照系统（v1.2.0）

- **天空光**：区块生成时按列初始化（露天列保持 15，树叶/水按列衰减），再只把影子边界放进 BFS 队列做水平扩散；
  洞穴会自然变黑，树冠下有明显阴影，不再出现「地下和地表一样亮」。
- **方块光**：`lightEmission > 0` 的方块（火把 14、南瓜灯/萤石 15）作为种子，每格衰减 1、水中衰减 2，可跨区块传播。
- **增量更新**：放置 / 破坏方块只做局部「移除 + 重新扩散」，并且只重网格化光照真正变化的区块，不全量重算。
- **着色**：网格写入 `aLight`（天空光、方块光），`MeshBasicMaterial` 通过 `onBeforeCompile` 注入 `uDaylight`，
  亮度取 `max(天空光 × 昼夜, 方块光)` —— 夜晚火把照亮的区域不会被整体压暗。
- **新方块**：**火把**（十字植物形，光照 14，可放在实心方块上）与**南瓜灯**（完整方块，光照 15）。
  生存模式新手补给现在包含 2 个苹果 + 8 支火把，洞穴探索不再只能摸黑。

## 美术优化（v1.2.0）

- **树叶**：从逐像素随机噪声改成 4×4 叶簇 + 边缘镂空 + 底部暗部，树冠不再呈椒盐噪点。
- **草方块 / 石头**：草色降低饱和度并加入成簇草叶；石头加入短裂纹；水面改为更深的蓝色与高光。
- **逐方块色差**：`BlockDefinition.colorVariance` 让每个方块实例有确定性的亮度抖动，
  大片草地、石墙、树冠不再完全重复（仍然零额外贴图 / 零 DrawCall）。
- **昼夜染色**：夜间天空光偏冷，日出日落按太阳颜色把地形染暖；云层随昼夜压暗，不再出现夜里发光的白板。
- **火把与南瓜灯**：火把纹理加宽到 4px，48px 快捷栏图标也能辨认；南瓜灯四面带雕刻脸。
- **手持物与出生点**：竖屏手持物自动缩小避免遮挡按钮；出生点优先选择露天、非沙滩/沙漠的位置，
  标题镜头抬高到能看清树林与地平线。

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

事件表（`src/core/events.ts`）：`block:break / block:place / block:ignite / explosion /
player:spawn / player:move / player:camera / hotbar:select / time:change /
chunk:generated / chunk:meshed / entity:spawn / entity:despawn / entity:dead / game:start /
game:pause / save:done / inventory:change / survival:damage / survival:death / survival:respawn /
survival:eat`。

### 已预留的未来方向

- 合成 / 工具耐久 / 护甲 / 更多怪物：生存循环已跑通，可在 `src/player/survival.ts` 与
  `src/world/blocks.ts` 的 `drops` 字段上继续叠加（见 `CraftAPI.survival`）。
- 光照传播：自发光通道已独立，可插入 `ILightEngine` 做光照扩散。
- 更多生物群系 / 结构：实现 `IWorldGenerator` 即可整体替换。
- 多人联机：世界读写集中在 `World`，编辑差分天然是同步消息格式。
- 纹理包：`registerTile` 可运行时重绘图集。
- Worker 网格化：`meshChunk` 是纯函数，可直接搬进 Web Worker。

## 测试

仓库自带两套无头浏览器测试与一套图形回归（Chromium + 软件 WebGL）：

```bash
npm test                         # 编译纯逻辑源码 → 生存 / 地形 / 光照三组回归
npm run build

# 没有本地 Chrome 时先下载一个：
# npx @puppeteer/browsers install chrome@stable
# export CHROME_PATH=/path/to/chrome

node test/survival-smoke.mjs     # 生存 + 移动端冒烟，72 项断言
node test/test.mjs               # 创造模式综合冒烟，22 项断言
node test/visual-check.mjs       # 图形回归，6 项断言 + 昼/黄昏/夜/火光/方块墙截图
node test/capture.mjs            # 只抓视觉截图
```

结果与截图写入 `test/artifacts/`。`npm test` 会先用 `tsconfig.test.json` 把 `src` 里的
纯逻辑模块编译到 `test/.build`，再直接测**当前源码**（不维护手写 JS 副本）；
三组共 8 + 23 + 14 项断言，无需浏览器 / WebGL。

软件 WebGL 的帧率可能低于 1fps，浏览器测试会在进入世界后降低渲染负载、等待区块流式加载收敛，
并用固定步长推进同一套 `player.update` 来验证输入 → 挖掘 / 进食 / 破坏逻辑，避免把「等真实时间」误当成功能失败。

覆盖：模式选择、血量/鸡腿/氧气 HUD、挖掘进度与掉落入包补位、放置与消耗、伤害与死亡重生、
进食、夜间僵尸生成与攻击、模式切换、存档 v2 与继续游戏、移动端摇杆/长按挖掘/按钮语义/安全区布局，
以及夜间变暗、火光提亮、方块墙颜色丰富度等图形断言。

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

核验结果：`tsc --noEmit`（strict）0 error；`vite build` 通过；`logic-check.cjs` 8 组 + `terrain-check.cjs` 23 组全通过；图集 31/64 格未溢出。浏览器实景冒烟测试因本环境无法初始化 WebGL 上下文仍未执行。

---

内容由 AI 生成