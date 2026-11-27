# 3D 优化实验（第 2 轮）

第 2 轮优化不做「拍脑袋调参」，先把三个候选改动做成**受控实验**：
每个改动都有假设、对照、翻转方式与判据，数据全部来自浏览器实景（headless Chromium + SwiftShader），
原始数据落在 `test/artifacts/experiment-3d.json`。

- 复现：`npm run build && npm run test:experiment`（**不在 `verify` 链里**，它是测量工具，不是回归门禁）
- 脚本：`test/experiment-3d.mjs`
- 环境：渲染距离 3、seed 2026、creative、1280×760

---

## 1. 实验设置

### 1.1 为什么必须「受控」

区块流式加载的最终集合随帧率漂移（生成有每帧预算），云在漂移、水在波动、
botany 会种树、粒子在动。**不把这些停掉，任何两帧画面都不相同，A/B 无从谈起。**
所以脚本在进世界后做了五件事：

| 步骤 | 做法 | 目的 |
| --- | --- | --- |
| 换最小系统组 | 进世界后**第一件事**就是把 `engine.systems` 换成只留 `chunks` 一项 | `main.ts` 注册的是**闭包** system，按对象引用过滤无效，必须整组替换；botany / 物理 / 粒子都会改写世界 |
| 等出生点收敛 | 等区块数 / 已网格数 / 脏队列 / 在途任务连续 4 s 不变 | 流式加载按每帧预算推进，不收敛就往下走，两个页面的起点就不同 |
| 钉场景 | 玩家与相机固定在 `(8, surfaceHeight(8,8)+1.02, 8)`，`yaw 0.65 / pitch -0.06`，`dayTime 0.32`、`dayLength 1e6` | 落地位置会随物理帧时序漂移，两个页面的中心区块就不同 |
| 裁剪 + 强制生成 | 先删掉渲染半径外的残留区块（复刻引擎自己的卸载步骤），再一次性 `ensureChunk` 整个半径 | 出生点附近残留几个「已生成 / 已网格化」的区块取决于传送前那几帧的时序（实测 6 / 10 个），两页不同；裁掉后场景是确定性的 (2R+1)² = 49 |
| 冻结 | `engine.systems = []`，并把 `chunks.waterTime` / `sky.localTime` 归零后再 `sky.update(0,0)` | 水面微波与云/星相位是持续动画；归零后两次探针才是同一帧画面 |

前三步的顺序不能换：先收敛再钉点，否则「钉点之前」生成的集合随帧率漂移；
先裁剪再强制生成，否则残留会让 `gen` / `verts` 两个页面不一致（场景一致性闸门就是为此设的）。

> 冻结后渲染循环仍在跑，所以**帧率依然是真实渲染成本**，不是暂停时的空转。

光源阵列：以玩家为中心的 **7×7 区块**，每块中心摆一块萤石 + 一支火把（49 个）。
目的是让 E3 的对照路径必然产生 49 个独立 emissive mesh，A/B 才有东西可比。

### 1.2 度量

| 指标 | 采集方式 | 用途 |
| --- | --- | --- |
| 帧率 | 页面内 rAF 计 2.5 s 帧数 | 端到端成本（软件渲染下即填充率成本） |
| `renderMs` | 连续 10 次强制 `renderer.render` 取均值 | 渲染 CPU 成本的代理 |
| draw calls / triangles / programs | 强制渲染后读 `renderer.info` | 结构收益 |
| 逐通道 mesh 数 / 顶点数 / 顶点缓冲字节 | 遍历 `chunks.meshes`，按 `attribute.array.byteLength` 累加 | 几何体量 |
| 像素签名 | 归一化坐标上抽 96×54 点，读 RGB | A/B 画面等价性 |
| 噪声底 | B→D：同页重复测量，什么都不翻 | 证明「零差异」不是测量失效 |

**像素签名必须在归一化坐标上抽样**：SSAA 会改变 `drawingBuffer` 尺寸，
按像素步长抽样会把「分辨率不同」误判成「画面不同」。

### 1.3 Arm 与对照

| Arm | 内容 | 翻转方式 | 对照 |
| --- | --- | --- | --- |
| **E1** | 顶点属性打包：每顶点 60 B → 44 B | **无运行时开关**（结构改动） | 靠 `test/mesher` 的逐顶点等价断言 + 实测字节数 |
| **E2** | 抗锯齿分档 `?aa=off\|msaa\|ssaa` | SSAA：同页改 `pixelRatio`；MSAA：单独开页 | 同页 B→C / 跨页 B→M |
| **E3** | 自发光并入不透明通道（`aTint=2`） | 同页改 `mergeEmissiveOption` | `?emerge=0` 保留并入前的独立 emissive 通道 |

同页扫描（`main` 页）：

| 编号 | emerge | pixelRatio | 角色 |
| --- | --- | --- | --- |
| A | 0 | 1.0 | 对照（第 1 轮渲染行为） |
| B | 1 | 1.0 | E3 |
| C | 1 | 1.5 | E2 / SSAA |
| D | 1 | 1.0 | 回到 B，噪声底 |
| M | 1（`?aa=msaa` 页） | 1.0 | E2 / MSAA |

---

## 2. 假设与结果

### E1 顶点属性打包（60 B → 44 B / 顶点）

**假设**：把 `colors`(3) + `aTileRect`(4) 收成 `aShade`(1) + `aTileOrigin`(2)，
字节数下降而画面不变。

**为什么不给运行时开关**：两种顶点布局跨 Worker 边界传输意味着网格化与传输代码近乎翻倍，
只为多一点实验信息不划算。它的证据是**结构测量 + 逐顶点等价断言**。

**结果**：

| 项 | 值 |
| --- | --- |
| 每顶点字节 | **44.0 B**（旧布局 60 B，-26.7%） |
| 顶点布局 | `position(3) + uv(2) + shade(1) + light(2) + tile(2) + flags(1)` |
| 实测顶点缓冲 | 11,863,984 B / 269,636 顶点 |
| 等价性 | `test/mesher` 51 项全过：Greedy 与逐面的覆盖 / 亮度 / tile 一致；自发光「并入 vs 独立通道」逐顶点一致 |

**结论**：成立。收益是显存与带宽，代价为零（无新增属性、无新增 draw call）。

### E2 抗锯齿分档

**假设**：`?aa=` 三档可切换，MSAA / SSAA 都能被观测到画面差异与帧率代价。

**结果**：

| 档 | 帧率 | 分辨率 | 像素差 MAD | 变化采样 |
| --- | --- | --- | --- | --- |
| off（B） | 8.93 | 1280×760 | — | — |
| SSAA（C，同页 B→C） | 4.82 | **1920×1140** | 2.429 | 970 / 15552 |
| MSAA（M，跨页 B→M） | 7.00 | 1280×760 | 0.160 | 61 / 15552 |
| 噪声底（D） | 6.91 | 1280×760 | **0.000** | **0** / 15552 |

- SSAA 把 `drawingBuffer` 放大 2.25 倍，帧率 8.93 → 4.82（1.85×）；`renderMs`
  0.44 → 0.49 几乎不动 —— 提交成本与分辨率无关，代价全在填充率上。
- MSAA 页 `mc.engine.aaMode === 'msaa'` 且 `gl.getContextAttributes().antialias === true`，
  帧率 8.93 → 7.00，像素差集中在边缘（MAD 0.160、61 个采样）→ 硬件 MSAA 生效。

**结论**：成立。默认 `?aa=off`；MSAA 是「要边缘质量」的选项，SSAA 是「要最好质量、填充率换」的选项。

> 诚实标注：SwiftShader 是软件渲染，`renderMs` 只反映 CPU 侧成本，MSAA 的真实带宽代价在
> 真 GPU 上才会完全显现；这里的帧率数字**只在同一页内做相对比较**才有意义。

### E3 自发光并入不透明通道

**假设**：萤石 / 南瓜灯 / 火把不需要光照与染色，复用不透明材质 + `aTint=2` 跳过光照，
可以省掉一份材质、一次 draw call 与一份几何，而画面完全不变。

**对照的保真度**：并入前的独立 emissive 材质是 `MeshBasicMaterial({map, vertexColors:true})`，
栅格化时乘的是 `aShade`（面定向 × AO）。所以新路径的 shader 在 `unlit` 分支里
**保留 `vShade`**，`?emerge=0` 也用 `injectLegacyEmissive` 复现旧行为，而不是「大概像」。

**结果（同页 A→B，只翻这一个变量）**：

| 项 | A（独立 emissive 通道） | B（并入 opaque） |
| --- | --- | --- |
| draw calls | 64 | **47**（-17） |
| emissive mesh（派发半径内） | 49 | **0** |
| programs | 10 | 10 |
| 顶点数 | 269,636 | **269,636** |
| 顶点索引字节 | 1,617,816 | **1,617,816** |
| 像素差 | — | **MAD 0.000 / max 0 / 0 个采样变化** |
| 帧率 | 8.97 | 8.93 |

**结论**：成立，且是纯收益。几何缓冲逐字节相同（顶点数与索引字节完全一致），
只是少了一份材质与 17 次 draw call；画面 15552 个采样点**零差异**。

> `triangles` 从 79,454 变成 79,580 不是几何变化（索引字节相同），
> 而是拆分通道时 emissive mesh 的包围球与 opaque mesh 不同，导致逐 mesh 视锥剔除结果不同。
>
> 「派发半径内」= `renderDistance + 1`。半径外的区块在 `ChunkManager.update` 的
> step 2 里直接丢掉脏标记、根本不会被重新网格化，它们保留旧通道是引擎的正常行为，
> 不该算进对照里（低渲染距离下能观察到 1~2 个这样的残留）。

---

## 3. 原始数据

一次完整运行的摘录（`npm run test:experiment`，2026-11-20）：

| Arm | fps | calls | tris | prog | geo | renderMs | opaque | emissive | water | meshes | verts | buffer | pr | aa |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| main:A | 8.97 | 64 | 79,454 | 10 | 56 | 0.55 | 49 | 49 | 21 | 119 | 269,636 | 1280×760 | 1.0 | off |
| main:B | 8.93 | 47 | 79,580 | 10 | 39 | 0.44 | 49 | 0 | 21 | 70 | 269,636 | 1280×760 | 1.0 | off |
| main:C | 4.82 | 47 | 79,580 | 10 | 39 | 0.49 | 49 | 0 | 21 | 70 | 269,636 | 1920×1140 | 1.5 | off |
| main:D | 6.91 | 47 | 79,580 | 10 | 39 | 0.42 | 49 | 0 | 21 | 70 | 269,636 | 1280×760 | 1.0 | off |
| msaa:A | 6.66 | 64 | 79,454 | 10 | 56 | 0.76 | 49 | 49 | 21 | 119 | 269,636 | 1280×760 | 1.0 | msaa |
| msaa:B | 7.00 | 47 | 79,580 | 10 | 39 | 0.49 | 49 | 0 | 21 | 70 | 269,636 | 1280×760 | 1.0 | msaa |
| msaa:C | 3.35 | 47 | 79,580 | 10 | 39 | 0.51 | 49 | 0 | 21 | 70 | 269,636 | 1920×1140 | 1.5 | msaa |
| msaa:D | 5.33 | 47 | 79,580 | 10 | 39 | 0.50 | 49 | 0 | 21 | 70 | 269,636 | 1280×760 | 1.0 | msaa |

比对：

| 比对 | MAD | max | 变化采样 |
| --- | --- | --- | --- |
| E3（A→B，同页） | 0.000 | 0 | 0 / 15552 |
| SSAA（B→C，同页） | 2.429 | 236 | 970 / 15552 |
| MSAA（B→M，跨页） | 0.160 | 111 | 61 / 15552 |
| 噪声底（B→D，同页） | 0.000 | 0 | 0 / 15552 |

其它：`bytesPerVert = 44.0`，两页各摆放 49 个光源区块，两页都是 `gen=49` / `verts=269,636`，无运行时错误。

> 帧率是软件渲染下的单次采样，**跨次运行会浮动**（同一配置能差 1~2 fps）。
> 结论只依赖「同页翻转前后的差值」与「噪声底为零」，不依赖绝对帧率。

---

## 4. 有效性检查（脚本自带，失败即 exit 1）

`test/experiment-3d.mjs` 在写出 JSON 后跑一轮闸门，任何一项不满足就非零退出：

- E3 同页翻转**必须零画面差异**；打开后派发半径内**不得有** emissive mesh；对照路径必须有；
  draw call 必须下降；program 数必须不变；翻转前后几何体量必须一致。
- SSAA 必须产生像素差异、必须降低帧率、必须提高渲染分辨率。
- MSAA 页必须先通过**场景一致性闸门**（`gen` / 顶点数 / opaque mesh 数 / 分辨率 / 摆放数
  与主场景相同：两页都必须是 49 / 269,636），且 `antialias === true`、有像素差异、帧率下降。
- 噪声底必须为零，否则上面的「零差异」结论不可信。
- 每顶点字节必须是 44；两个页面都不得出现运行时错误。

---

## 5. 复现

```bash
npm run build
npm run test:experiment        # 默认渲染距离 3
MC_RD=2 npm run test:experiment  # 换渲染距离
MC_URL=http://localhost:8080/index.html npm run test:experiment  # 换宿主
```

产物：`test/artifacts/experiment-3d.json`（完整指标 + 像素签名）、
`test/artifacts/exp-main.png` 与 `exp-msaa.png`（整页截图）。

## 6. 后续

- 区块边界的光照 1 格光晕接缝仍未解决（修它会把重网格化成本成倍放大），本轮刻意不动。
- E1 的 44 B 布局已是最小；再压需要把 `aLight` 量化成 1 字节，会牺牲平滑光照的角点精度，
  在 E1 的实测收益（显存 / 带宽）与观感之间不做这个交易。
- E2 的 MSAA 默认关闭：软件渲染下帧率代价明显，真 GPU 上是否默认开启需要真机数据。

---

## 7. 新一轮受控实验（第 3 轮）

环境说明：本机无可用浏览器（playwright 的 chromium 启动时 SIGBUS，puppeteer 的 chrome 归档
是损坏的 zip），`npm run test:experiment` 在本环境无法执行 —— 以下是完整的受控实验**设置**
（假设 / 对照 / 翻转方式 / 判据，同页翻转原则见 §1.1）；执行环境：`npm run build && npm run test:experiment`。

### E4：区块边界光晕接缝的修复尝试

**假设**：区块边界上 `aLight` 的接缝（§6 第一条）来源于角点光照的跨边界采样：一侧区块读到
的是另一侧已更新而本侧未重网格化的补丁格，手工挖一道光井后边界段的暗纹明显。

**对照**：现状 —— `computeCornerLightInto`（mesher.ts）只对本区块算 9 格补丁；边界上方的两行
（偏移落在 [0, CS) 外）读的是邻区块当前 `sky/block` 值，`World.setBlock` 改动时才标脏邻区块。

**翻转方式**：`computeCornerLightInto` 的角点采样时，若偏移落在边界外，直接读
`world.getSkyLight/getBlockLight` 的邻区块位置（同页、仅该变量翻转）。

**判据**：
- 同页 A→B 像素签名差异在噪声底内（或为 0）；
- draw calls / programs / 顶点数不变；
- 截图检查：接缝处暗纹消失。
不满足即回滚，实验作废。

### E5：aLight 量化为 1 字节

**假设**：`aLight`（2B/顶点）可量化为 1B（取值仍为整数 0~15），在实测收益（显存 / 带宽）
与观感之间做权衡（§6 第二条前提）。

**对照**：现状 —— `chunkManager.buildGeo` 用 `aLight` 2 字节，E1 实测 44 B/顶点。

**翻转方式**：`mesher.ts` 的 `quadSky/quadBlock` 改为 8 位存储；`chunkManager.buildGeo`
改为 `new THREE.BufferAttribute(p.lights, 1)`；`test/mesher` 逐顶点等价断言在实验分支放宽为定量等价。

**判据**：
- `test/mesher` 全绿；
- 实测 bytesPerVert = 43（E1 实测 44.0，预期 -1B）；
- 同页 A→B 像素差在量化误差内（实测 ≤ 1 档位），噪声底 B→D = 0。

### E6：云透明度下调（lowerCloudOpacity —— tuning-tweaks.json 待实验项）

**假设**：云材质透明度降低（`sky.ts` L202-205 云 MeshBasicMaterial opacity 0.82 → 约 0.6）
提升可读性，且在软件渲染下不显著回收帧率（§2 帧率噪声下云未独立报告，真机数据待评）。

**对照**：当前云材质 opacity（`Sky` 的 `this.clouds.material`）。

**翻转方式**：改云材质 opacity，同页 B→C 翻转测量（`npm run test:experiment` 的 main:B→main:C arm）。

**判据**：
- 像素差 MAD > 0（云可见性变化，达成可读性目标）；
- 噪声底 B→D = 0（说明差异可信）；
- fps 无明显下降；若明显下降则记录「可读性换了帧率」的决策点。

### E7：setBlock 跳过脏标记（reduceDirtyOnSetBlock —— tuning-tweaks.json 待实验项）

**假设**：`World.setBlock` 的 `dirty.add`（本块 + 8 邻/对角块，`World.setBlock` L228-238）
是热路径上的高频 Set 操作；跳过后，ChunkManager 第 0 步「已生成但无网格、无在途 → 重新入队」
自愈网格，正确性仍成立。

**对照**：现状 —— `setBlock` 每次写记录 1（本块）+ 8（邻/对角）dirty key。

**翻转方式**：移除 `setBlock` 中的 `dirty.add` 调用（保留 `recordEdit` 与 `light.updateBlock`）；
`npm run test:edits` + `npm run test:logic` 必须全绿。

**判据**：
- `test:edits` / `test:logic` 全绿；
- 实景实验：fps 无显著回报；若有（快速在线编辑场景）则记录；
- 若发现渲染过期（自愈滞后）则回滚翻转。

### E8：网格化 Worker 池扩容（increaseWorkerPool —— tuning-tweaks.json 待实验项）

**假设**：`ChunkManager.decidePoolSize` 默认上限 4（hc-1）在 8+ 核机上可扩；网格吞吐
（`MAX_DISPATCH_PER_FRAME=6`）可能成为瓶颈，worker 池扩容能提升 fps。

**对照**：现状 —— 默认池 `min(hc - 1, 4)`，`setWorkerPoolSize` 上限 8。

**翻转方式**：本地实验性改为 `Math.min(hc - 1, 8)`；`npm run test:mesher`（网格结构等价）；
实景实验：fps。

**判据**：
- `test:mesher` 全绿（网格结构不变）；
- 实景 fps 有明显提升（≥5%）或无回报；
- 若 busy 队列排水更差则回滚。

---

## 8. 玩法/生存机制实验（node 实景）

环境说明：本机浏览器不可用，但以下模块全为纯逻辑，`SurvivalState` / `Botany` / `Entity` /
`rollDrops` / `resolvePenetration` / `World.raycast` 都可直接在 node 跑（compiled snapshot，
`npm run test:snapshot` 之后即可运行）。脚本：`test/experiment-gameplay.cjs`
（`npm run test:experiment-gameplay`），不挂 `verify`，运行于 2026-11-21。

### E9：生存状态机经济与死亡阈值

**假设**：饥饿消耗率按 `SurvivalState.tick` 的常量：walk 0.06/s、sprint 0.20/s、mining 0.09/s
（带宽换算：每 4s 扣 1 点）；饱食回血在 `hunger >= 18 && health < 20` 时 1HP/4s 且附赠
`exhaustion += 3`；饥饿掉血为 `damage(1, '饥饿')` 每 4s；`damage` 在 iframes（0.32s）内无效。

**对照**：`src/player/survival.ts` — `drain += ctx.sprinting ? 0.2 : 0.06` / `0.09`（mining）；
`while (exhaustion >= 4) { exhaustion -= 4; hunger = max(0, hunger - 1); }`；
`if (hunger >= 18 && health < MAX_HEALTH) { regenAcc >= 4 → exhaustion += 3; heal(1); }`；
`starveAcc >= 4 → damage(1, '饥饿', false)`；`iframes = 0.32`。

**翻转方式**：纯测量（无翻转）；若要翻转：把 `hunger >= 18` 改为更低阈值重跑 E9。

**判据**：
- 运动消耗：walk rate ∈ [0.008, 0.03]，sprint ∈ [0.028, 0.072]，mining ∈ [0.012, 0.033]；无死亡副作用。
- 饱食回血：heals ≥ 1，health ∈ [10,16]，hunger ∈ [12,20]。
- 饥饿掉血：damage=1/4s，死亡（health=0, dead=true）。
- 伤害免疫：免疫 0.32s 内返回 false。

**原始数据（实测，T=200s/40s）**：
- walk rate=0.0100/s，sprint rate=0.0500/s，mining rate=0.0200/s，healthLost 0/0/0。
- regen: heals=3，health=13，hunger=17。
- starve: damages=5，health=0，dead=true。
- iframes: d1=true, d2=false, d3=false, d4=true, health=9。

### E10：生态随机刻节奏（Botany.setTickSpeed 0/1/2/3）

**假设**：`setTickSpeed(tier)` → `attempts = round(baseAttempts × scale[tier])`，
`scale = [0, 0.35, 1, 2.2]`；`update()` 每秒对应 `attempts` 次 `randomAttempt`；tier 0 → 0 次（暂停）。

**对照**：`src/world/botany.ts` — `setTickSpeed` 与 `update` 的 attempts 循环；实验量度
`world.getBlock` 调用次数（`randomAttempt` 每次恰好 1 次 getBlock）。

**翻转方式**：纯测量；若要翻转：scale 表 [0, 0.35, 1, 2.2] → [0, 0.5, 1, 3.0]，
tier3/tier2 比例应变为 ≈3.0。

**判据**：
- tier 0 → 0 calls；
- tier3/tier2 比例 ∈ [1.85, 2.75]；
- tier2 > tier1（标准 56 > 慢档 round(56×0.35)=20）。

**原始数据（实测，300 updates × 0.1s/tick）**：
- c0=0（tier 0），c1=510（tier 1），c2=1450（tier 2），c3=3168（tier 3）
- ratio = c3/c2 = 2.18（理论 123/56 = 2.196）。

### E11：实体攻击 + 弹道射线

**假设**：僵尸 `attackCooldown = 1.05` → 敌对攻击节奏 ≈ 1/1.05s；`hurt(amount, fromX, fromZ)` 语义：
`hp = max(0, hp - amount)`，hp→0 时 `dead=true`；`Entity.update` 的 `burnInDay` 在
`daylight > 0.55` 时每秒扣 `dt*2.2`（实验里用 `daylight=0`）；`World.raycast(origin, dir, maxDist)`
弹道均值 < 1ms/call。

**对照**：`src/entity/entity.ts` — `hurt` / `update` 的 attack 分支；`src/world/world.ts` — `raycast`。

**翻转方式**：纯测量；可翻转 `attackCooldown 1.05 → 0.525`，预期节奏翻倍。

**判据**：
- 10s 内攻击次数 ∈ [8, 13]（预期 ≈ 10，≈1/1.1s）；
- 攻击伤害 = 僵尸 `damage=3`；
- 弹道命中石墙（hit.x=8，dist=4）；弹道均值 < 1ms。

**原始数据（实测）**：
- 敌对节奏：hits=10（攻击间隔约 1.1s）。
- `hurt`：hp=14 → hurt(3,20,10) → hp=11 → hurt(3) → hp=8 → hurt(100) → hp=0, dead → hurt(1) → hp=0；hurtCooldown=0.35。
- 弹道：hit.x=8, dist=4；0.0067 ms/call。

### E13：脱困解算

**假设**：pos(10.5, 10.5, 10.5) 嵌入石柱（AABB 重叠 3 个 block）→ `resolvePenetration` ≤ 10 轮解算，
`resolved=true`，位移有界；解算均值 < 1ms。

**对照**：`src/player/unstuck.ts` - `resolvePenetration(pos, width, height, isSolid, maxIterations=10, maxDisplacement=128)`。

**翻转方式**：纯测量。

**判据**：resolved=true，moved=true，iterations ≤ 10，位移 ∈ (0, 4]；解算均值 < 1ms。

**原始数据（实测）**：resolved=true, moved=true, dx=0, dy=0, dz=0.801, iterations=1；
解算均值 0.1158 ms/call。

### E12：确定性掉落判定

**假设**：僵尸掉落率 ≈ 配表 chance（apple 0.35、iron_ingot 0.15、iron_sword 0.04），5σ 内；
`rollDrops` 同参数确定、按 source 稳定但分布随 source；`nightOnly` 按 `daylight < 0.3` 生效；
biome 过滤生效；`min/max` 控制 count ∈ [min,max]。

**对照**：`src/world/drops.ts` - `rollDrops(specs, {seed, source, daylight, biome})`；
`src/entity/entity.ts` 僵尸 drops 表。

**翻转方式**：纯测量。

**判据**：
- 掉落率：apple ≈ 0.35、iron_ingot ≈ 0.15、iron_sword ≈ 0.04（5σ 内）；
- 同参数两次相同，有源变化；
- nightOnly：daylight=0.1 → 100 掉落；daylight=0.5 → 0；
- biome：desert → 50；plains → 0；
- min~max：count ∈ [2,5] 且不全相同。

**原始数据（实测，N=20000）**：
- apple 0.3534（expected 0.35，|Δ|=0.0034）；iron_ingot 0.1505（0.15）；iron_sword 0.0416（0.04）。
- 确定性：两次结果相同；不同 source 有分布变化 ✓。
- nightOnly：0.1→100，0.5→0；biome：desert→50，plains→0。
- min~max：count=4,2,5,3,5,2（前 6 次）。

---

## 9. mesher 热点：标量化 Greedy 内层循环（E14，2026-11-22）

本机浏览器不可用（见 §7），本实验是 **Node 快照基准 + 逐字节输出护栏**（不挂 `verify`，
脚本 `test/mesher-hotspot-check.cjs`，命令 `npm run test:mesher-hotspot`）。基线数据先于任何
优化记录并提交在 `test/mesher-hotspot-baseline.json`。

**假设**：`meshChunk` 占 CPU 采样 90.6%，是玩家移动 / 传送时的主要开销；其 Greedy 内层循环里
的可变坐标数组 `bb`、循环内可选调用 `src.isKnown?.()`、以及 `FACE_GEOMS` 未预存法线分量
是可去除的常数成本。把这些成本标量 / 提升 / 预计算后，`meshChunk` 可提速 ≥1.5×，且输出不变。

**对照**：优化前的生产路径（seed 2026，`cx=0..5, cz=0..3` 共 24 区块，`SnapshotMeshSource`
+ 与 `test/mesher-check.cjs::makeConfig` 相同的确定性 UV 替身，`greedy=true`，`mergeEmissive=true`，
8 轮预热 + 8 轮计时），完整输出缓冲按固定通道 / 属性顺序拼成 Buffer 后取 SHA-256。

**翻转方式**：三个独立子项，逐项跑护栏（hash 变化即回滚该子项）：
1. `meshTypes.ts` 的 `GeoArrays` 放宽为 typed array，`packMesh` 用 `subarray(0,length)` 只打包已用前缀；
   `newGeo()` 改为带容量倍增的 typed array。
2. `mesher.ts` 的 `blockAt` 用局部标量 `bx/by/bz` 替代可变数组；`FACE_GEOMS` 预存 `nx/ny/nz`；
   `isKnown` 提升到循环外。AO / 角点光 / mask key / `emitFace` 数学一字不改。
3. 合并两次全量扫描（B.3）**未执行**——目标已超额达成，且该子项会改变特殊方块发射顺序、威胁逐字节一致。

**判据**：
- 输出 SHA-256 与基线完全一致（quad 顺序 + 全部顶点属性）；
- `msPerChunk <= baseline.msPerChunk / 1.5`；
- `test:mesher` 61 项、`test:mobile` 四项、`verify:node` 全绿。

**原始数据（实测，本机口径）**：
- 基线：`msPerChunk = 142.561`，hash `816ba4ba6eb4c6a5b0ef381077fe4ab191fa7e2d1e3154537998bfdbd8e8a5eb`。
- 优化后：`msPerChunk = 20.505`，**6.95×**（阈值 ≤95.04 / 1.5×，超额达成），hash 不变。
- 硬件 / 机器与 tuning 副本文档记录的 87.27 ms/区块不同，倍数按本机基线计算。

**待验证目标**：用户关心的 `p95 帧时 < 33ms @ 默认移动设置` 是浏览器实景指标，本环境无可用浏览器
无法测量；已降级为记录目标，留给 CI / 真机环境用 `test:smoke` + 帧时采样验证。Node 基准（6.95×）
只是代理指标，不等价于帧时结论。

**总门验证结果（集成分支，2026-11-22）**：
- `python3 docs/agent/validate.py --strict`：exit 0，26 张卡 FAIL 0 / WARN 0。
- `npm run verify:node`：exit 0，全绿（含 18 群系可达性 / botany spawn 权重 / mesher 61 项 / mobile 四项）。
- `npm run verify`：exit 1——但失败点是 `test:logic` 里 `test/terrain-check.cjs:301` 的机器性能断言
  （`单区块平均生成耗时 < 40ms` 实测 133.8ms），非功能回归；该断言在 base commit 即以同样方式失败
  （两条线均复现），属本机负载 / 性能限制。
- `npm run test:smoke` 单独执行：exit 1，`Command '/usr/bin/chromium-browser' requires the chromium snap to be installed.`
  ——浏览器步骤的环境阻塞与 §7 记录一致，属 CI-only 项。

**已知限制**：frost_bloom 在 snowy_tundra / snowy_taiga 的 spawn 权重被 `botanyContent.ts` 既有的
frostline 规则衰减（spawn 后即枯死）——该规则属既有生态逻辑，本轮按范围锁定未改；若日后希望霜花
在雪原存活，需单独一轮改规则。
