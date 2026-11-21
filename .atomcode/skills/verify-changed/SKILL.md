# verify-changed

 按当前改动面选择最小测试集，避免每次跑全量 `npm run verify`（含浏览器实景，很重）。

## 步骤

1. `git status --short` + `git diff --name-only` 确定改动文件。
2. 按下表选最小集，依次执行（快照测试前置依赖 `npm run test:snapshot`，只要跑任何 CJS 快照测试就先跑它）：

| 改动面 | 最小验证集 |
|---|---|
| `src/world/mesher.ts` / 光照 | `test:snapshot` → `test:mesher` → `test:light` |
| `src/world/generator.ts` / blocks / plantTraits | `test:snapshot` → `test:terrain-system` → `test:botany` |
| `src/world/botany.ts` | `test:snapshot` → `test:botany` → `test:botany-rules` → `test:plant-energy` |
| `src/player/crafting.ts` | `test:snapshot` → `test:crafting` |
| `src/player/survival.ts` / physics | `test:snapshot` → `test:logic` → `test:unstuck` |
| `src/services/` / api / plugins | `test:snapshot` → `test:services` → `test:plugin-v2` → `test:plugin-carrier` |
| `src/diagnostics/` | `test:snapshot` → `test:diagnostics` |
| `src/world/workerPool` / wasm | `test:worker-pool` / `wasm:check` → `test:wasm` |
| `src/save/` | `test:snapshot` → `test:edits` → `test:services` |
| `src/ui/` / `src/input/` / `src/gfx/` | `test:snapshot` → `test:options` → `test:feel`；画面改动走 `test:experiment` 受控实验 |
| 版本号 / package.json | `check:version` |

3. 全部通过后提醒用户：提交前 CI 要求完整 `npm run verify` 100% PASS（可用 `bash_start` 后台跑）。
4. 浏览器相关测试在无 GPU 环境用：
   `xvfb-run -a -s "-screen 0 1280x760x24" env MC_HEADLESS=0 MC_GL=desktop npm run test:smoke`
