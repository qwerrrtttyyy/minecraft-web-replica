/**
 * 从「当前 TS 源码」现场编译出纯逻辑回归所需的 CommonJS 快照。
 *
 * v1.1.2 的 test/logic 与 test/terrain-logic 是手工同步的编译产物，
 * 审查报告 v1.1.0 就指出过这个风险，两轮都没落地。此脚本把它自动化：
 * 每次 verify 都先重建快照，测试永远跑在最新源码上，杜绝「测试通过但源码已改」。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.test-build');

// 入口覆盖：生存逻辑 / 事件服务与兼容垫片 / 服务容器 / 插件服务 / 存档校验 / 地形
const entries = [
  'src/vite-env.d.ts',
  'src/player/survival.ts',
  'src/player/smelting.ts',
  'src/player/equipment.ts',
  'src/player/equipmentState.ts',
  'src/player/unstuck.ts',
  'src/wasm/protocol.ts',
  'src/wasm/kernelBinary.ts',
  'src/wasm/kernel.ts',
  'src/wasm/runtime.ts',
  'src/services/plugins/extensions.ts',
  'src/services/plugins/saveBag.ts',
  'src/services/ui/PanelHost.ts',
  'src/player/playerHooks.ts',
  'src/services/plugins/loader.ts',
  'src/services/plugins/semver.ts',
  'src/services/plugins/storage.ts',
  'src/services/plugins/carriers/index.ts',
  'src/services/plugins/carriers/hostABI.ts',
  'src/services/plugins/carriers/types.ts',
  'src/plugins/builtin/wasmMonitor.ts',
  'src/plugins/example/wasmProbe.ts',
  'src/plugins/example/hostPluginFixtureBinary.ts',
  'src/world/noiseMath.ts',
  'src/core/events.ts',
  'src/services/ServiceContainer.ts',
  'src/services/plugins/PluginService.ts',
  'src/save/save.ts',
  'src/input/keybindings.ts',
  'src/input/input.ts',
  'src/world/generator.ts',
  'src/world/blocks.ts',
  'src/world/botany.ts',
  'src/world/plantTraits.ts',
  'src/world/plantStrains.ts',
  'src/world/plantRules.ts',
  'src/plugins/builtin/botanyContent.ts',
  // 四季与天候：纯天气历法 / 天候状态机 / 寒冷惩罚（零 three/DOM，测试直接 require）
  'src/world/ecology.ts',
  'src/world/weather.ts',
  'src/world/cold.ts',
  'src/world/trees.ts',
  'src/world/structures.ts',
  'src/world/light.ts',
  'src/world/world.ts',
  'src/world/workerPool.ts',
  'src/world/noise.ts',
  'src/world/faces.ts',
  'src/world/meshTypes.ts',
  'src/world/chunkRetention.ts',
  'src/world/mesher.ts',
  'src/world/lightPacking.ts',
  'src/world/meshSource.ts',
  'src/world/snapshotSource.ts',
  'src/core/types.ts',
  'src/core/options.ts',
  'src/core/version.ts',
  'src/diagnostics/RuntimeDiagnostics.ts',
  'src/entity/models.ts',
  'src/entity/basketball.ts',
  'src/entity/entity.ts',
  'src/entity/droppedItem.ts',
  'src/entity/falling.ts',
  'src/world/dropLogic.ts',
  'src/world/fire.ts',
  'src/ai/Node.ts',
  'src/ai/Blackboard.ts',
  'src/ai/AIContext.ts',
  'src/ai/composites.ts',
  'src/ai/decorators.ts',
  'src/ai/Perception.ts',
  'src/ai/conditions.ts',
  'src/ai/actions.ts',
  'src/ai/BehaviorTree.ts',
  'src/ai/registry.ts',
  'src/ai/AIComponent.ts',
  'src/ai/AIService.ts',
  // 内容更新：行为树配置与箭矢投射物（纯逻辑，不触碰 DOM）
  'src/ai/behaviors.ts',
  'src/entity/projectile.ts',
  'src/gfx/zipReader.ts',
  'src/gfx/texturePack.ts',
];

const tsc = path.join(root, 'node_modules', '.bin', 'tsgo');
const args = [
  '--ignoreConfig',
  '--module', 'commonjs',
  '--moduleResolution', 'bundler',
  '--target', 'ES2020',
  '--lib', 'ES2020,DOM,DOM.Iterable',
  '--strict',
  '--skipLibCheck',
  '--outDir', tmp,
  '--rootDir', 'src',
  '--noEmit', 'false',
  ...entries.map((e) => path.join(root, e)),
];

rmSync(tmp, { recursive: true, force: true });
try {
  execFileSync(tsc, args, { cwd: root, stdio: 'inherit' });
} catch {
  console.error('[snapshot] TypeScript 编译失败，快照未更新');
  process.exit(1);
}

for (const dir of ['test/logic', 'test/terrain-logic']) {
  const dest = path.join(root, dir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(tmp, dest, { recursive: true });
  // 项目根是 type: module，快照需要显式声明 CommonJS
  writeFileSync(path.join(dest, 'package.json'), '{"type":"commonjs"}\n');
}
rmSync(tmp, { recursive: true, force: true });
console.log('[snapshot] 测试快照已从当前 TS 源码重新生成（logic / terrain-logic）');
