import type { PluginDefinition } from '../../services/plugins';
import { armorPlugin } from './armor';
import { autosavePlugin } from './autosave';
import { botanyExpansionPlugin } from './botanyExpansion';
import { hudFeedbackPlugin } from './hudFeedback';
import { wasmMonitorPlugin } from './wasmMonitor';

/** 组装根默认启用的一等公民插件；实际启用顺序由 manifest.priority 决定 */
export const builtinPlugins: PluginDefinition[] = [
  autosavePlugin,
  hudFeedbackPlugin,
  armorPlugin,
  botanyExpansionPlugin,
  wasmMonitorPlugin,
];
