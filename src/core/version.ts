/**
 * 全项目唯一版本来源（v1.2.0 起），v1 起采用「双轨版本号」：
 *
 * - VERSION：非正式迭代版，格式 X.Y.Z。package.json / README / CraftAPI.version 必须与它一致，
 *   `scripts/check-version.mjs` 会在 `npm run verify` 中机械校验。
 * - RELEASE：正式里程碑版，格式 vN（N 为整数，只增不减）。日常迭代不动它，只在发布正式版时
 *   由维护者手动推进，并在对应提交打同名 Git 标签 `vN`。
 *
 * 二者互不覆盖：一个正式版 vN 可以覆盖多个 X.Y.Z 迭代。因此历史迭代标签一律不带 v 前缀
 * （1.3.0 / 1.3.1），只有 v1 / v2 这类标签表示正式版。
 */
export const VERSION = '1.4.4';
export const RELEASE = 'v1';
export const ENGINE_NAME = 'Minecraft TS';
