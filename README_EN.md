# Minecraft TS — A TypeScript Voxel Engine Replica

> 🤖 **Entirely AI-generated** — all source code, tests and docs were produced by AI coding
> agents; humans only set the direction.
> ⚠️ **WARNING: aggressive development in progress** — APIs, save formats and gameplay may
> change at any time. Not production-ready.
> 📖 Honest disclosure (generation method & quality boundaries) in the Chinese README § 关于本项目.

**[▶ Play online (GitHub Pages)](https://qwerrrtttyyy.github.io/minecraft-web-replica/)** — no install, open and play

[![verify CI](https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml/badge.svg)](https://github.com/qwerrrtttyyy/minecraft-web-replica/actions/workflows/verify.yml)
[![latest tag](https://img.shields.io/github/v/tag/qwerrrtttyyy/minecraft-web-replica?label=version)](https://github.com/qwerrrtttyyy/minecraft-web-replica/tags)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript 5.6](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![three.js 0.170](https://img.shields.io/badge/three.js-0.170-049ef4?logo=threedotjs&logoColor=white)](https://threejs.org/)
[![Play Demo](https://img.shields.io/badge/%E2%96%B6%20play-demo%20online-2ea44f)](https://qwerrrtttyyy.github.io/minecraft-web-replica/)

[简体中文](README.md) | **English**

A lightweight, cleanly-architected Minecraft foundation replica for the web. The only runtime
dependency is **three.js** (rendering) — everything else is hand-written: voxel world, chunk
streaming, mesh generation with ambient occlusion, procedural pixel textures, day/night sky,
physics & collision, entity AI, touch support, save system and an extension API.

> Unofficial learning project, not affiliated with Mojang / Microsoft. Every texture is drawn
> pixel-by-pixel in code — **no original game assets are included**.

**▶ Play online (GitHub Pages)**: <https://qwerrrtttyyy.github.io/minecraft-web-replica/>

## Highlights

- **Voxel engine** — chunk streaming with back-pressure & self-healing, three-channel mesh
  (data / sky light / block light) with Greedy Meshing on a Web Worker pool (~40% fewer quads)
- **Lighting** — sky light + block light, dual-channel BFS propagation (0–15 levels),
  incremental updates, baked into vertex attributes (no extra draw calls)
- **Terrain** — explicit 4-stage pipeline (`columns → ores → trees → decorate`) with
  biome config tables, domain warping, ridge mountains, fading caves, layered ore veins,
  cross-chunk trees
- **Survival & creative modes** — health / hunger / breath / mining hardness / drops /
  inventory / hostile mobs / death & respawn; TNT with fuse & explosion
- **Botany ecosystem** — random-tick plant engine with an intrinsic energy system
  (solar / hydro / fungal metabolism, root sharing, flowering & harvesting)
- **91+ blocks** — all textures procedurally drawn in code (8×8 pixel-art atlas, 256 slots)
- **Mobile friendly** — virtual joystick, dynamic resolution scaling, haptic feedback,
  safe-area adaptation
- **Plugin & event architecture** — service container, hot-pluggable plugins, event error
  isolation, `window.CraftAPI` extension facade
- **Single-file build** — `npm run build` produces one self-contained `dist/index.html`
  (three.js inlined) that runs offline, even from `file://`

## Quick Start

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # typecheck + build single-file dist/index.html
```

Requires Node.js 20+. The build output is fully self-contained — no network needed at runtime.

## Controls

| Input | Action |
| --- | --- |
| WASD / Arrow keys | Move |
| Space | Jump / swim up / fly up |
| Double-SPACE or F | Toggle flight (Shift to descend, creative only) |
| Shift | Sneak |
| Ctrl / double-W | Sprint |
| Left mouse (hold) | Break block (timed by hardness) |
| Right mouse | Place block / eat / harvest flowering plant |
| Middle mouse | Pick block |
| Scroll / 1-9 | Switch hotbar slot |
| E | Block library |
| F5 | Toggle camera view |
| F3 | Debug panel (version, diagnostics) |
| Esc | Pause menu |
| Mobile | Virtual joystick + buttons |

## Testing & Quality

```bash
npm run verify   # full gate: version + typecheck + build + 16 test suites, 100% PASS required
```

Test suites cover: logic, terrain, lighting (21), mesher (43), services, runtime diagnostics,
worker pool, world edits, terrain system, botany, plant energy, survival smoke (100) and
**pixel-level visual regression** (headless Chromium under Xvfb in CI). Runtime invariants are
enforced by a diagnostics group (`CraftAPI.diagnostics.run()`), surfaced on the F3 panel.

## Architecture

```
main.ts → services (ServiceContainer / EventService / PluginService)
        → api (CraftAPI thin facade)
        → world / gfx / player / entity / input / ui / audio / save / diagnostics
```

Strict one-way dependencies; plugins only touch the service container and their plugin
context. Worker side is limited to pure data (`MeshSource` / `MeshSnapshot`) — no `three`
imports across the thread boundary. See `docs/ARCHITECTURE.md` for details.

## Versioning

Dual-track versioning, single source of truth in `src/core/version.ts`:

- **Release** `vN` — milestone releases (git tag `vN`, F3 panel)
- **Version** `X.Y.Z` — rolling iteration (`package.json`, CraftAPI)

Details in the Chinese README § 版本规范. Full history in [CHANGELOG.md](CHANGELOG.md).

## Known Limitations

- Transparent blocks are not distance-sorted yet (fix in review)
- 15-level hard-edged lighting (no smooth light interpolation)
- No AABB unstuck yet (fix in review)
- ~10 FPS under software rendering (llvmpipe); real GPUs run much faster

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — it lists the
hard rules (block ids are append-only, never bump version numbers in PRs, worker-side data
purity, …) derived from `docs/PROJECT-EXPERIENCE.md`. AI-assisted contributions are welcome
with human verification and proper `Co-authored-by` attribution.

- 🐛 [Bug report](../../issues/new?template=bug_report.yml) · [Feature request](../../issues/new?template=feature_request.yml)
- 🔒 Security issues: see [SECURITY.md](SECURITY.md) — do **not** file public issues
- 📜 [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)

---

*Content generated with AI assistance.*
