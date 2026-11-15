import type { PluginDefinition } from '../../services/plugins';
import { autosavePlugin } from './autosave';
import { hudFeedbackPlugin } from './hudFeedback';
import { botanyExpansionPlugin } from './botanyExpansion';

/** 组装根默认启用的一等公民插件；顺序即注册顺序 */
export const builtinPlugins: PluginDefinition[] = [
  autosavePlugin,
  hudFeedbackPlugin,
  botanyExpansionPlugin,
];
