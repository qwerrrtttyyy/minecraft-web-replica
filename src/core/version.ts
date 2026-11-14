/**
 * 全项目唯一版本来源（v1.2.0 起）。
 *
 * package.json / CraftAPI.version / F3 调试面板 / README 都必须与这里一致，
 * `scripts/check-version.mjs` 会在 `npm run verify` 中做机械校验，
 * 杜绝 v1.1.2 曾出现的「包名 1.1.2、package.json 1.1.0、API 1.1.0、F3 1.1.0」四处漂移。
 */
export const VERSION = '1.3.0';
export const ENGINE_NAME = 'Minecraft TS';
