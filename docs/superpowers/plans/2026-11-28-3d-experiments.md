# 3D 实验功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为体素项目加入可开关的 3D 密度地形、8 位打包顶点光照和材质包加载器，并在设置页可见。

**Architecture:** 三个实验分别落在生成器、区块网格材质和纹理图集三个既有扩展点；设置项统一进入 `Options`，URL 参数优先覆盖。默认行为保持不变。

**Tech Stack:** TypeScript、three.js、Vite、Vitest、Node CJS 测试快照。

## Global Constraints

- 不新增运行时依赖。
- 默认值：`densityTerrain=false`、`packedLighting=false`、`texturePack='classic'`。
- 方块 id 与既有图集 tile 索引不变。
- 地形生成必须同时兼容主线程与 Worker。
- 不修改历史存档结构，不提交 `dist/` 与测试产物。

---

### Task 1: 设置模型与 URL 参数

**Files:**

- Modify: `src/core/options.ts`
- Modify: `src/main.ts`
- Test: `test/options-check.mjs`

**Interfaces:**

- Produces: `TexturePackId = 'classic' | 'warm' | 'cool' | 'contrast'`
- Produces: `Options.densityTerrain: boolean`、`Options.packedLighting: boolean`、`Options.texturePack: TexturePackId`
- Produces: `TEXTURE_PACK_IDS: readonly TexturePackId[]`

- [ ] **Step 1: 写失败测试**

在 `test/options-check.mjs` 增加：

```js
assert.equal(loadOptions().densityTerrain, false);
assert.equal(loadOptions().packedLighting, false);
assert.equal(loadOptions().texturePack, 'classic');
assert.equal(normalizeOptions({ texturePack: 'bogus' }).texturePack, 'classic');
```

- [ ] **Step 2: 运行并确认失败**

Run: `node test/options-check.mjs`
Expected: FAIL，字段为 `undefined`。

- [ ] **Step 3: 实现设置字段**

在 `Options`、`DEFAULT_OPTIONS`、`loadOptions`、`normalizeOptions` 中加入三字段与 `TEXTURE_PACK_IDS` 校验。

- [ ] **Step 4: 运行测试**

Run: `node test/options-check.mjs`
Expected: PASS。

---

### Task 2: 3D 密度场地形

**Files:**

- Modify: `src/world/generator.ts`
- Modify: `src/main.ts`
- Test: `test/density-terrain-check.cjs`
- Modify: `scripts/build-test-snapshot.mjs`

**Interfaces:**

- Consumes: `TerrainOptions.densityTerrain`
- Produces: `DefaultGenerator` 在密度模式下生成悬挑 / 岩檐，同时保留每列顶面。
- Produces: URL `?terrain=density`。

- [ ] **Step 1: 写失败测试**

用固定 seed 生成 3×3 区块，断言：

```js
assert.equal(deterministic(seed), true);
assert.equal(everyColumnHasSurface(gen, data), true);
assert.ok(overhangCount(gen, data) > 0);
assert.equal(classicModeHasNoNewOverhang(seed), true);
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:snapshot && node test/density-terrain-check.cjs`
Expected: FAIL，未知 `densityTerrain` 或不满足悬挑断言。

- [ ] **Step 3: 实现密度雕刻**

在 `TerrainOptions` 与 `DEFAULT_TERRAIN` 加开关；构造两个 `Noise`；在 `stageColumns` 内按“保顶面 + 下方 3D 洞穴 + 陡坡上方岩檐”实现。水下禁用。

- [ ] **Step 4: 接入组装根**

`new DefaultGenerator(seed, registry, { densityTerrain: qs.get('terrain') === 'density' || settings.densityTerrain })`。

- [ ] **Step 5: 运行测试**

Run: `npm run test:snapshot && node test/density-terrain-check.cjs && npm run test:terrain-system`
Expected: 全部 PASS。

---

### Task 3: 8 位打包顶点光照

**Files:**

- Modify: `src/world/chunkManager.ts`
- Modify: `src/main.ts`
- Test: `test/packed-light-check.cjs`
- Modify: `scripts/build-test-snapshot.mjs`

**Interfaces:**

- Produces: `packLightVertex(sky: number, block: number): number`
- Produces: `unpackLightVertex(packed: number): [number, number]`
- Produces: `ChunkManager.setPackedLighting(v: boolean): void`
- Produces: `ChunkManager.lightingMode: 'float2' | 'packed8'`

- [ ] **Step 1: 写失败测试**

```js
const q = [0, 0.5, 1];
for (const v of q) {
  const [s, b] = unpackLightVertex(packLightVertex(v, v));
  assert.ok(Math.abs(s - v) <= 1 / 15);
  assert.ok(Math.abs(b - v) <= 1 / 15);
}
assert.equal(packLightVertex(1, 0), 240);
assert.equal(unpackLightVertex(240)[0], 1);
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm run test:snapshot && node test/packed-light-check.cjs`
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现打包与 shader 解码**

将纯函数放入 `meshTypes.ts` 或独立模块；`buildGeo` 按模式写 `aLight`；`injectLight` 声明不同的 attribute 类型；新增 `setPackedLighting`，原地转换几何属性并刷新材质。

- [ ] **Step 4: 接入设置与 URL**

`?lighting=packed` 优先于 `settings.packedLighting`；设置页切换调用 `chunks.setPackedLighting(v)`。

- [ ] **Step 5: 运行测试**

Run: `npm run test:snapshot && node test/packed-light-check.cjs && npm run test:mesher`
Expected: 全部 PASS。

---

### Task 4: 材质包加载器

**Files:**

- Create: `src/gfx/texturePack.ts`
- Create: `src/gfx/zipReader.ts`
- Modify: `src/gfx/atlas.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/hud.ts`
- Test: `test/texture-pack-check.cjs`

**Interfaces:**

- Produces: `TexturePackId`、`BUILTIN_PACKS`
- Produces: `applyBuiltinPack(atlas, id): void`
- Produces: `loadTexturePackFiles(files): Promise<TexturePackLoadResult>`
- Produces: `TexturePackLoadResult { applied: string[]; missed: string[]; errors: string[]; source: string }`
- Produces: `TextureAtlas.tileNames()`、`applyTileImages()`、`resetTiles()`

- [ ] **Step 1: 写失败测试**

```js
assert.equal(builtinPackIds().join(','), 'classic,warm,cool,contrast');
assert.equal(nameToTile('grass_top.png'), 'grass_top');
assert.equal(nameToTile('assets/minecraft/textures/block/stone.png'), 'stone');
assert.deepEqual(filterKnownTiles(['stone', 'nope'], names).missed, ['nope']);
```

- [ ] **Step 2: 运行并确认失败**

Run: `node test/texture-pack-check.cjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现图集热更新**

新增图集 tile 列举、读取、回写、重置方法；回写后 `texture.needsUpdate = true`。

- [ ] **Step 4: 实现内置包与 ZIP 导入**

内置包使用确定性颜色矩阵变换；ZIP 支持 stored / deflate、`pack.json` 映射和文件名直配；多 PNG 直接导入。

- [ ] **Step 5: 接入设置页**

新增“3D 实验”分组、包循环行、文件选择按钮和状态行；main 处理文件导入并 toast 结果。

- [ ] **Step 6: 运行测试**

Run: `node test/texture-pack-check.cjs && npm run typecheck`
Expected: PASS。

---

### Task 5: 前端状态与验收

**Files:**

- Modify: `src/ui/hud.ts`
- Modify: `src/main.ts`
- Modify: `src/world/world.ts`（如需要暴露实验状态）
- Test: `test/smoke` 或手工截图

**Interfaces:**

- Consumes: 三个实验的运行时状态。
- Produces: F3 实验状态行、设置页状态文本。

- [ ] **Step 1: 增加状态显示**

F3 追加：

```text
实验: 地形 classic|density · 光照 float2|packed8 · 材质 classic|imported
```

- [ ] **Step 2: 设置页联动**

三个控件与 `syncOptions` 双向同步；导入失败不可改变当前包。

- [ ] **Step 3: 工程验证**

Run: `npm run check:version && npm run lint && npm run typecheck && npm run build`
Expected: 全部 exit 0。

- [ ] **Step 4: 相关回归**

Run: `npm run test:snapshot && npm run test:terrain-system && npm run test:mesher && npm run test:options`
Expected: PASS。浏览器环境不可用时记录限制。

## 执行后修订（2026-11-28）

- Task 1 的 `packedLighting` / `texturePack` 字段已按评估删除；仅保留 `densityTerrain`。
- 光照压缩改为默认开启，`?lighting=float2` 作为唯一对照入口。
- 材质包预设相关 Task 撤销；导入器增强为原版路径、别名、动画首帧与 ZIP 限额。
- `test/3d-experiments-check.cjs` 已纳入 `verify` / `verify:node`。
