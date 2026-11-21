# Minecraft TS — A TypeScript Voxel Engine Replica

<p align="center">
  <a href="https://qwerrrtttyyy.github.io/minecraft-web-replica/">Play online</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/TESTING.md">Testing</a> ·
  <a href="docs/HISTORY.md">History</a> ·
  简体中文
</p>

<p align="center">
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml"><img alt="verify CI" src="https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/qwerrrtttyyy/minecraft-web-replica/tags"><img alt="version" src="https://img.shields.io/github/v/tag/qwerrrtttyyy/minecraft-web-replica?label=version"></a>
  <img alt="TypeScript 5.6" src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white">
  <img alt="three.js 0.170" src="https://img.shields.io/badge/three.js-0.170-049ef4?logo=threedotjs&logoColor=white">
  <img alt="runtime deps: three.js only" src="https://img.shields.io/badge/runtime%20deps-three.js%20only-2ea44f">
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> 🤖 **Entirely AI-generated** (source, tests, docs); humans only set the direction. Not production-ready.
> [简体中文](README.md) | **English**

A lightweight Minecraft replica for the web. The only runtime dependency is **three.js** —
everything else is hand-written: voxel world, chunk streaming, greedy meshing with AO,
three-channel light BFS, procedural pixel textures, day/night sky, physics, entity AI,
plant ecology, crafting and saves. The build is a **single self-contained HTML** — offline,
runs from `file://`; every texture is drawn pixel-by-pixel in code, **no original assets**.

Current release: milestone `v1` | iteration `1.5.0` (dual-track, single source
[`src/core/version.ts`](src/core/version.ts)).

## Highlights

- **Voxel engine** — chunk streaming with back-pressure & self-healing; data / sky-light /
  block-light three-channel mesh; Greedy Meshing on a Worker pool (~40% fewer quads)
- **Lighting** — dual-channel BFS (0–15), incremental updates, baked into vertex attributes
  (zero extra draw calls)
- **Terrain** — 4-stage pipeline `columns → ores → trees → decorate`; domain warping,
  `ridged fBm` mountains & rivers, temperature × humidity biomes, fading caves, layered ores,
  cross-chunk trees
- **Survival loop** — health / hunger / breath / mining hardness / drops / hostile mobs /
  death & respawn / 3×3 crafting
- **Plant ecology** — random-tick engine + intrinsic energy system (solar / hydro / fungal
  metabolism, root sharing, bloom feedback)
- **91+ blocks** — all data-driven via `BlockRegistry`, procedural 16×16 atlas (256 slots)
- **Plugins** — service container + namespaced events + hot-pluggable plugins
  (js / wasm:module / wasm:host carriers), `window.CraftAPI` facade
- **Engineering** — `npm run verify`: version consistency → typecheck → build → full
  regression → browser smoke, 100% PASS required

## Quick Start

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + single-file dist/index.html
npm run verify   # full acceptance gate
```

## Controls

| Input | Action |
| --- | --- |
| WASD / Space / Shift | Move / jump (double-tap or F to fly, creative) / sneak |
| LMB / RMB / MMB | Break (hardness-timed) / place, eat, harvest / pick |
| Scroll / 1-9 / E | Hotbar / block library |
| F5 / F3 / F1 | Camera / debug panel / hide HUD |
| Esc | Pause menu → settings, crafting, key rebinding |

**Settings**: sound & volume, FOV, render distance, sensitivity, quality presets, particles,
auto-jump, touch sensitivity; a developer group exposes debug overlay, Greedy meshing, mesher
threads, autosave interval and settings import/export. Options use vanilla-style two-column
layout (single column on small screens), persisted in `localStorage`. An in-game **About**
page (title screen / menu / settings entry) shows versions and project info.

## Architecture

```
src/
├── core/       engine kernel: engine (renderer/scheduling), types, version (★ single source)
├── services/   ★ ServiceContainer / EventService (error isolation, waitFor, stats) / PluginService
├── api/        ★ thin CraftAPI facade (plugins / events / settings / survival namespaces)
├── plugins/    builtin plugins (autosave, hud-feedback) + example
├── world/      terrain / lighting / meshing / botany / block registry
├── gfx/  player/  entity/  input/  ui/  audio/  save/  diagnostics/
└── main.ts     ★ assembly root: build services → inject → enable plugins → run loop
```

Strict one-way dependencies: `main.ts → services → api (types) → modules`; plugins only touch
the service container and their `PluginContext`. Key design:

- **Service-based extension points** — events and plugins have identity, lifecycle,
  dependencies and permissions; disabling a plugin revokes subscriptions and cascades downstream
- **Permission allowlist** — undeclared write capabilities (`world:write`, `player:write`,
  `save:write`, `blocks:register`, …) are intercepted in plugin contexts; reads are open
- **Data-driven blocks** — rendering / collision / sound / drops look up `BlockRegistry`
- **Baked lighting** — directional shading + per-vertex AO + light channels in vertex
  attributes, `MeshBasicMaterial`, no real-time shadows
- **Saves** — edit diffs (player changes only, bucketed by chunkKey) + `validateSave()` full
  validation; corrupt saves fall back to no-save

## Extension API

All APIs live on `window.CraftAPI` (full contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

```js
CraftAPI.on('block:break', e => console.log(e));            // events
CraftAPI.registerTile('ruby_ore', (set, rng) => {...});      // procedural texture
CraftAPI.registerBlock({ name: 'ruby_ore', hardness: 3, tiles: {...} }); // data-driven block
CraftAPI.registerEntity({ id: 'cow', build() {...} });       // custom entity
CraftAPI.setGenerator({ generateChunk(cx, cz, data) {...} }); // replace terrain
CraftAPI.save.setProvider({ load, save, clear });             // cloud save backend
CraftAPI.engine.addSystem({ update(dt) {...} });             // per-frame system

// Plugins: id / version / dependencies / permissions / lifecycle
CraftAPI.plugins.register({
  manifest: { id: 'demo:mining-log', version: '1.0.0', permissions: ['api:emit'] },
  setup(ctx) { ctx.events.on('block:break', e => ctx.log(e.block)); },
});
await CraftAPI.plugins.enable('demo:mining-log');

// Botany extension (requires botany:register): plant traits + random-tick rules
CraftAPI.botany.registerPlant('my_flower', { metabolism: 'solar', bloom: 80, growthCost: 18 });
CraftAPI.botany.registerRule({ id: 'me:rule', owner: 'me:my-pack', tick: (ctx) => false });
```

Event contracts live in `src/services/events/GameEvents.ts`, extendable via TypeScript
declaration merging.

## Testing

```bash
npm run verify   # single acceptance entry, browser tests must be 100% PASS
```

Suites cover logic (31), lighting (21), mesher equivalence, services (38), diagnostics (20),
terrain system / botany / plant energy, crafting (43), WASM fallback, plugin v2 & carriers,
plus Chromium smoke and pixel-level visual regression (Xvfb software rendering). See
[docs/TESTING.md](docs/TESTING.md); benchmark numbers are authoritative only in
`test/artifacts/results.json`.

## Versioning

Dual-track, single source `src/core/version.ts` (mechanically checked by `check:version`):

- **Release** `vN` — milestone tags (currently `v1`)
- **Version** `X.Y.Z` — rolling iteration (currently `1.5.0`); pre-releases follow
  `alpha.N → beta.N → rc.N`

Change summary in [CHANGELOG.md](CHANGELOG.md); detailed v1.1.1 → v1.5.0 history in
[docs/HISTORY.md](docs/HISTORY.md).

## About

- **Generation** — all code, tests and docs produced by AI coding agents under human
  direction; every change gated by `npm run verify`
- **Quality boundary** — core logic and visuals are regression-tested; untested edge behavior
  may still appear. Not production-ready.
- Unofficial learning project, not affiliated with Mojang / Microsoft. [MIT](LICENSE).
  Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md); security issues go to
  [SECURITY.md](SECURITY.md), not public issues.
