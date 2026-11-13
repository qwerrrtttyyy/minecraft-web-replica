# Minecraft TS v1.1.0 源码审查报告

> 角色：Bug 审查员 + 3D 工程师
> 对象：`我的世界网页复刻-生存模式-源码-v1.1.0.txt`
> 结论基于 `src/` 全量 TypeScript 源码静态审查；本环境软件 WebGL 初始化失败，未能运行仓库自带的 puppeteer 冒烟测试，所有判断均给出文件与行号以便复核。

---

## 0. 先看交付物本身

用户给的 `.txt` 其实是一个 **ZIP 压缩包**（文件头 `PK\x03\x04`），正文是二进制乱码。解压后为 `minecraft-ts/` 工程，含 `src/`、`dist/index.html`（单文件 600KB）、`test/`、`package-lock.json`。

**意见**：文件名后缀与实际格式不符，直接当文本打开/入库会变成乱码；应改为 `.zip`，或在 README 里明确"源码包为 zip"。另外 `dist/index.html` 与 `src/` 同时入包，审查/同步时容易改了源码却交付了旧构建产物，建议 CI 里加一条"dist 与 src 构建结果一致性"校验。

---

## 1. 总体评价

架构是这份代码最强的部分，值得肯定：

- `World / ChunkManager / meshChunk / BlockRegistry / EventBus` 分层清晰，`meshChunk` 是纯函数，天然适合搬进 Web Worker；
- 三通道网格（不透明 / 自发光 / 半透明）+ 逐顶点 AO 烘焙进顶点色 + `MeshBasicMaterial`，**零实时光照开销**，是很正确的体素渲染取舍；
- 程序化 16×16 图集、`NearestFilter` + 半像素 UV 内缩、单 draw call 粒子池、`matrixAutoUpdate=false`、按距离卸载区块，移动端预算意识到位；
- 存档只记编辑差分 + 生存状态，扩展 API 与事件表设计完整。

主要问题不在"3D 渲染写得不好"，而集中在两处：**① UI 状态没有真正回写到游戏状态机；② 流式加载的"生成 → 网格化"队列不完整，且每帧预算失效**。这两类问题会让"看起来能跑"变成"走两步就露馅"。

---

## 2. 缺陷清单（按严重度）

### P0 — 阻断级 / 核心玩法

#### P0-1 标题页的「生存 / 创造」选择基本无效
- `src/ui/hud.ts:196-197`：`selectedMode` 只切换按钮高亮；
- `src/ui/hud.ts:181`：只有「生成新世界」按钮把它传给 `onNewWorld(seed, selectedMode)`；
- `src/ui/hud.ts:202-209`：「进入世界 / 继续游戏 / 新的世界」调用 `onStart(cont)`，**不带模式**；
- `src/main.ts:242-246`：`onStart` 里 `else if (saved) newWorld(undefined, gameMode)` / `else startGame(false)`；
- `src/main.ts:63`：`gameMode = saved?.mode ?? 'survival'`，`src/main.ts:104` 把它写进 `survival.mode`。

**后果**：无存档时在标题页点「创造模式」再点「进入世界」，进的仍是生存模式；有存档时点「新的世界」也会沿用存档模式。只有"填种子 + 生成新世界"那条路径尊重选择。README「标题页可选生存/创造」与实际不符。

**建议**：把 `onStart` 改成 `onStart(cont, mode)`；`!cont` 时先把 `survival.mode = mode` 再 `startGame(false)`；「新的世界」统一走 `newWorld(seed, selectedMode)`。「继续游戏」保留存档模式不要覆盖。

#### P0-2 新生成的区块没有入队网格化，靠"邻居生成"副作用间接补，会留永久空洞
- `src/world/world.ts:72-76`：`ensureChunk()` 只把**已生成的邻接区块**加入 `dirty`，**不把自己加入**；
- `src/world/chunkManager.ts:103-112`：`update()` 第 1 步生成缺失区块，第 2 步只处理 `world.dirty`；
- `src/world/world.ts:113-117`：`setBlock()` 才会把自身区块加入 `dirty`。

**后果**：一个区块 C 被生成后，只有当"之后生成的某个邻居"把 C 标脏时才会被 `remesh`。螺旋顺序里**最后生成、以及所有邻居都先于它生成的区块永远没有网格**；`initialLoad()` 只显式 remesh 半径 3 的区块，桌面默认 R=5 时外圈同样受影响。表现为远处地表缺块 / 传送后视野边缘空洞。另外 `chunkManager.ts:123` 会先 `dirty.delete()` 再判断 `generated`，未生成区块的脏标记被直接丢掉，边界面剔除也会滞后。

**建议**：生成后立刻入队自身，并且不要丢弃未生成区块的脏标记：

```ts
// chunkManager.ts update() 第 1 步
const t0 = performance.now();
for (const [dx, dz] of this.spiral(R)) {
  const key = chunkKey(cx + dx, cz + dz);
  const chunk = this.world.getChunk(cx + dx, cz + dz);
  if (!chunk?.generated) {
    this.world.ensureChunk(cx + dx, cz + dz);
    this.world.dirty.add(key);                 // 关键：自己也要 remesh
    if (performance.now() - t0 > 4) break;     // 关键：t0 不要在循环里重置
  }
}

// 第 2 步
for (const [x, z] of list) {
  const k = chunkKey(x, z);
  if (!this.world.getChunk(x, z)?.generated) continue;  // 保留脏标记等下一帧
  this.world.dirty.delete(k);
  this.remesh(x, z);
  if (performance.now() - t0 > 6) break;
}
```

#### P0-3 "每帧限时 4ms" 的生成预算失效
`src/world/chunkManager.ts:104-112`：每次生成后都执行 `t0 = performance.now()`，于是 `performance.now() - t0 > 4` 只衡量**单个区块**的耗时，而不是整帧累计。地形生成含 fBm/洞穴噪声，单块往往 <4ms，结果一帧内可能把整圈 80+ 区块全部生成完，造成数百毫秒卡顿。README「每帧限时生成与网格化」名不副实，且与 P0-2 叠加后首帧/传送时最明显。修法见上：把 `t0` 移到循环外、循环内不重置。

---

### P1 — 明显影响体验

#### P1-4 触控视角灵敏度被平方
`src/input/touch.ts:114` 已经乘了 `this.input.sensitivity`，`src/input/input.ts:146` 的 `consumeLook()` 又乘一次；桌面 `mousemove`（`input.ts:63-68`）只乘一次。灵敏度设 2 时，触屏实际是 4 倍、桌面是 2 倍，设置项在不同设备语义不一致。**建议**删掉 `touch.ts:114` 里的 `* this.input.sensitivity`，统一由 `consumeLook()` 处理。

#### P1-5 中键取样 / 方块库指派会覆盖快捷栏，物品变成"孤儿"
- `src/player/player.ts:549-558`：`pickBlock()` 直接 `hotbar.slots[hotbar.index] = {kind:'block', id}`；
- `src/ui/hud.ts:612-617`：方块库点击同样直接覆盖当前格；
- `src/main.ts:468-494`：`inventory:change` 只在「数量 >0 且快捷栏里不存在」时补位，且**不发出**补偿事件；
- `src/ui/hud.ts:597-624`：方块库只遍历 `registry.all()`，**不列物品**。

**后果**：开局快捷栏第 1 格是苹果，玩家对着草方块按中键取样后，苹果从快捷栏消失但 `i:apple` 仍在背包里，而方块库没有"苹果"可重新指派 —— 这 2 个苹果永久取不出来。这是生存模式里很容易踩到的死局。**建议**：快捷栏以背包为准；`pickBlock` 若目标格已有不同物品，先找空格或交换而不是覆盖；方块库增加"物品"页签，或提供 `CraftAPI.survival.assign(index, stack)`。

#### P1-6 方块库指派后手持模型 / 触控按钮语义未更新
`src/ui/hud.ts:612-617` 先调 `onAssign(id)`（`main.ts:251-254` 会 emit `hotbar:select`），**之后**才写 `hotbar.slots[index]`。而 `hotbar:select` 处理器（`main.ts:455-464`）此时读到的还是旧格子，于是 `player.setHeldStack()` 和 `syncUseMode()` 都基于旧物品。**建议**：先改 `hotbar.slots[index]`，再 emit 事件（或直接让 `onAssign` 接收并写入新 stack）。

#### P1-7 暂停 / 死亡 / 菜单时昼夜仍在推进
`src/main.ts:595` 把 `sky.update` 无条件注册进引擎主循环，`src/core/engine.ts:90-94` 也没有按 `mode` 跳过系统。于是打开菜单、死亡界面、返回标题后，太阳照常升落、僵尸照常燃烧/清退，回来时世界时间已经跳了一段。**建议**：`mode === 'paused' || mode === 'dead'` 时冻结 `sky.update`（`chunks`/`particles` 可继续，但 `elapsed` 也应停止累计，否则云和星空会跳变）。

#### P1-8 Esc 可能与 pointerlockchange 同帧产生两个 `pause` 边沿
`src/input/input.ts:89-91` 的 Escape `keydown` 与 `:76-85` 的 `pointerlockchange` 都会 push `{type:'pause'}`；`src/main.ts:517-524` 一帧内串行处理所有 edges：第一个 `openMenu()`，第二个在 `mode==='paused'` 下命中 `hud.menuOpen` → `resumeGame()`。在指针锁定下按 Esc 的浏览器里可能出现"菜单闪一下又自动回到游戏"。**建议**：对 `pause` 边沿做同帧去重，或在 `openMenu()` 里吞掉紧随其后的锁定丢失事件。

#### P1-9 公开 API 与 README 示例不一致，且 `give('apple')` 静默无效
- `src/api.ts:183,196`：`survival.mode` / `survival.inventory` 是**函数**，README `:165,171` 当属性用（`CraftAPI.survival.mode` 会拿到函数对象）；
- `src/player/survival.ts:103-109`：`addDrop()` 只认 `'item:xxx'` 或方块名；`src/api.ts:190` 的 `give('apple', 3)` 走 `byNameGet('apple')` → `undefined` → **什么都不加**，而 README `:169` 正是这么写的；`count('apple')` 同样返回 0。

**建议**：统一成属性 getter 或函数（改文档也行），并让 `addDrop('apple')` 兼容 `ITEMS` 里的物品名；`give/count` 对无法识别的名字应抛错而不是静默失败。

#### P1-10 两个对外声明的事件从未发出
`src/core/events.ts:22,34` 声明了 `entity:hurt`、`game:pause`；全仓库无 `emit`（`src/main.ts:511` 只有一个空的 `on('entity:hurt')` 占位）。按 README `:179-183` 订阅这两个事件的扩展方永远收不到回调。**建议**：`Entity.hurt()` 里 emit `entity:hurt`，`openMenu()/resumeGame()` 里 emit `game:pause`；否则从事件表和文档里删掉。

#### P1-11 进食"先回血后扣物品"，异常栈可白吃
`src/player/player.ts:522-535`：`eat()` 先 `survival.eat()`（加饥饿 + `heal(1)` + emit `survival:eat`），再 `survival.consume(stack,1)`；`consume` 失败时食物已经生效。`doPlace()`（`:515`）的顺序是对的，应保持一致。**建议**：先 `if (!survival.consume(stack, 1)) return;`，再 `survival.eat()`。

#### P1-12 生存 / 创造切换不重建快捷栏，产生 count=0 幽灵格
`src/main.ts:423-446` 的 `toggleGameMode()` 只改 `survival.mode`，不动 `hotbar.slots`。创造模式的 9 个无限方块格切回生存后仍在，`src/ui/hud.ts:376-380` 把它们标成 `empty`，但 `selectedStack()` 仍返回它们，`consume()` 必然失败。**建议**：切换时对热栏做一次「按背包重建」，或至少清空不在 inventory 里的格子。

#### P1-13 文档与实现不符（其余）
- README `:52` 称摔落「>3 格起算」；`src/player/player.ts:276-277` 实际阈值是 `fallVy > 9`，对应约 **1.5 格**（`v=√(2·27·h)`），1.5 格就会掉约 0.6 血；
- README `:68` 称「受伤/破坏/放置/死亡触发震动」；实际只有 `src/input/touch.ts:164-166` 在按钮按下时 `navigator.vibrate(12)`；
- `src/api.ts:154` `player.setFly(v)` 直接赋值，绕过 `Player.toggleFly()` 的生存模式限制，README「生存禁用飞行」可被 API 破坏。

---

### P2 — 健壮性 / 3D 性能 / 工程化

| # | 位置 | 问题与建议 |
|---|---|---|
| P2-14 | `src/gfx/atlas.ts:12,404` | 图集 8×8=64 格，内置 28 个；`registerTile()` 无容量校验，注册超过 36 个自定义纹理后 `uv()` 会算出越界行列，纹理静默错乱。应 `if (indices.size >= GRID*GRID) throw`。 |
| P2-15 | `src/world/world.ts:64-69` | 每生成一个区块都遍历**全部** `edits` 并 `split(',')`，大存档/大爆炸后是 O(区块数 × 编辑数)。应把 edits 按 `chunkKey` 分桶。另 `explode()`（`main.ts:201-208`）把每个被炸方块都写成 AIR 差分且从不清理，编辑表会持续膨胀。 |
| P2-16 | `src/world/mesher.ts:148-153` + `blocks.ts:125-128` | 树叶 `opaque:false`，`faceVisible()` 只在 `neighbor.opaque` 时剔面，于是**相邻树叶之间的内部面也全画**（玻璃有专门的 glass-glass 剔除，树叶没有）。树冠三角形数可达必要量的 2~3 倍。建议对同 ID 的非 opaque 方块也剔面，或单独给树叶一个 `cullSame` 标志。 |
| P2-17 | `src/world/chunkManager.ts:52-59` | 水 / 玻璃均为 `DoubleSide + depthWrite:false + renderOrder=2`，双面片元翻倍，且水与玻璃互相叠加时排序依赖 three 的透明物体排序，容易穿插。建议改 `FrontSide`（水面单独补底面）、按区块中心到相机距离设 `renderOrder`。 |
| P2-18 | `src/world/chunkManager.ts:15-23` | `buildGeo()` 为区块写入 `normal` 属性，但四个通道全是 `MeshBasicMaterial`（`models.ts` 的实体才用 Lambert），法线完全没被用到，白占约 25% 顶点内存。可去掉。 |
| P2-19 | `src/world/world.ts:156-160` | DDA 在 `t=0` 就检查起点格，命中时返回法线 `(0,0,0)`。正常站立时眼睛格是空气；但通过 `CraftAPI.player.teleport()` / 异常存档把玩家塞进非空气方块时，准星会命中"自己所在格"，放置侧的 `hit.nx/ny/nz` 全 0，`boxIntersectsBlock` 也会误判。建议 `t===0` 时跳过非 solid 方块，或对零法线命中直接返回 null。 |
| P2-20 | `src/world/generator.ts:91-93,112-113` | 树只在 `lx,lz ∈ [2,13]` 生成（离区块边界至少 2 格），导致每个 16×16 区块四周固定有一圈 2 格宽的"无树带"，地形会出现规则格子感；`placeTree` 又用 `xx>=CS` 把树叶截断在本区块内，树冠结构上无法跨区块延伸。建议把树木装饰改成"生成后第二遍、可写邻区块"的 pass。 |
| P2-21 | `src/player/physics.ts:33-68` | `collide()` 按 `minX..maxX` 顺序找到第一个实心方块就 `return` 并钳位；若玩家被传送进墙内/存档坐标异常，可能被弹到反方向（瞬移）。建议沿运动方向选最近的面，或先做一次 AABB 脱困。 |
| P2-22 | `src/save/save.ts:46-79` + `main.ts:164-171,688-690` | v2 存档无任何字段校验（坏档会在 `main.ts:96` 的 `for...of saved.edits` 直接抛错）；`beforeunload` 里 `saveNow()` 是 Promise，换成自定义异步 provider 时可能来不及落盘。建议加 schema 校验 + `navigator.sendBeacon`/同步兜底。 |
| P2-23 | `src/main.ts:213,219` | `player.pos.distanceTo({...} as never)` 把普通对象塞给 `Vector3.distanceTo`，靠 three 只读 `.x/.y/.z` 侥幸能跑。建议复用一个 `tmpV.set(cx,cy,cz)`。 |
| P2-24 | `src/main.ts:182-184,615-618` | `tntList` 只在 `mode==='playing'` 更新；暂停/死亡态被链条点燃的 TNT 会永久冻结不爆。建议把引爆队列做成独立系统或随暂停冻结 fuse 并明确恢复。 |
| P2-25 | `src/gfx/particles.ts:84-89` | 淡出用 `colors *= 0.9 + f*0.1` 每帧相乘，帧率不同衰减速度不同。建议改为 `pow(k, dt)` 形式。 |
| P2-26 | `src/core/engine.ts:16,99` / `entity.ts:98` | `Engine.paused`、`Engine.dispose()`、`Entity.hurtCooldown` 均为死代码；`engine.camera.far=900`（`engine.ts:43`）远大于实际雾距（`sky.ts:235-238` 最大约 125），白白损失深度精度，建议按 `renderDistance*16*1.1` 动态收敛。 |
| P2-27 | `src/main.ts:661-677` | 动态分辨率系统不判断 `mode`，标题页/暂停时也会因 FPS 降分辨率；且 `fps` 是 0.5s 窗口的硬阈值（40/58），与"6ms 网格化"尖峰互相触发容易来回震荡。建议 EMA 平滑 + 仅在 `playing` 调整。 |
| P2-28 | `src/world/chunkManager.ts:62-70` | 水面动画用 `onBeforeCompile` 字符串替换 `begin_vertex`，强绑定 three r170 的 shader 源码，升级 three 会静默失效。建议用 `customProgramCacheKey` + 版本断言，或改成几何层面的顶点属性动画。 |

---

## 3. 3D 工程师视角：渲染管线意见

**做得好的**：烘焙 AO + 面定向明暗写进顶点色、世界用 `MeshBasicMaterial` 免实时光、自发光独立通道、三通道分层、`NearestFilter` 图集 + 半像素内缩、粒子单 `Points`、区块 `matrixAutoUpdate=false`、雾距随渲染距离联动 —— 这套组合在移动端是合理且克制的。

**建议按优先级推进**：

1. **把 `meshChunk` 搬进 Web Worker**（README 已预留）。目前 P0-3 的生成预算失效 + 主线程 6ms/帧网格化，是移动端掉帧的最大来源；Worker 化后主线程只做 `BufferGeometry` 上传，配合 `SharedArrayBuffer`/转移 `ArrayBuffer` 可基本消除卡顿。
2. **面合并 / Greedy Meshing**。现在石头、泥土大面积内壁逐面出四边形，加上 P2-16 的树叶内部面，三角形数偏高。至少先做"同材质相邻面剔除"，再考虑按行/列合并。
3. **透明通道排序**。水与玻璃同 `renderOrder=2` 且 `depthWrite:false`，跨区块观察水下玻璃时容易前后颠倒；应按网格中心距相机排序，或把水拆成独立 pass 并开启深度预写。
4. **光照模型要一致**。`vertexColors` 在 three 里按线性空间处理，而图集纹理是 `SRGBColorSpace` 解码；夜色只是调 `material.color`，`emissive` 通道完全不调 —— 结果是"萤石恒亮"但没有真正光照传播。若后续加 `ILightEngine`，建议把光照值也烘进顶点色，不要引入逐像素光，保持零阴影开销的优势。
5. **深度精度与 far plane**。`camera.far` 固定 900，雾最远约 125，收紧到 `renderDistance*16*1.1` 能减少远距离 z-fighting，几乎零成本。
6. **shader 注入加保护**（P2-28），并在 `package.json` 把 `three` 锁死到 0.170 时加一条升级检查清单。

---

## 4. 测试与回归建议

仓库自带 `test/survival-smoke.mjs`（桌面 + 移动端 64 项）覆盖得不错，但 `test/survival-smoke.mjs:48-52` 的 `startGame()` 直接调 `__mc.startGame(false)`，**绕过了标题页 UI**，因此 P0-1 这类"UI → 状态机"接线问题天然测不到。建议补 3 条断言即可挡住本次最严重的回归：

1. 点击 `.mode-btn[data-mode="creative"]` → 点击「进入世界」→ 断言 `__mc.gameMode === 'creative'`；
2. 传送到 20 个区块外，等待 2~3 秒 → 断言 `chunks.meshCount === world.chunks.size`（或差值 ≤ 1），挡住 P0-2；
3. 订阅 `game:pause` / `entity:hurt` 并触发对应操作 → 断言收到事件，挡住 P1-10；
4. 额外：中键取样覆盖苹果格后，断言仍能通过某种途径把苹果放回快捷栏，挡住 P1-5。

另外建议把 `__mc` 内部钩子与真实 UI 点击的测试分开：前者测逻辑，后者测接线，否则 UI 层永远是测试盲区。

---

## 5. 结论

这是一个**架构分远高于完成度**的项目：扩展性、渲染取舍、程序化资源都做得漂亮，但 v1.1.0 把生存模式叠上去之后，"标题模式选择、快捷栏与背包的一致性、流式加载队列"三处接线没有收口，导致首次进入、走动、取样这几个最基础的路径就会出问题。

**修复顺序建议**：P0-1 → P0-2 → P0-3 → P1-4/5/6/7 → P1-9/10/11 → P2 性能项。前 3 个 P0 都是几行到十几行的改动，修完后建议立刻跑一遍自带冒烟测试 + 上面 4 条新断言，再上 Worker 化与 Greedy Meshing。届时才适合把 `dist/index.html` 作为"可直接双击打开"的正式交付物对外发布。
