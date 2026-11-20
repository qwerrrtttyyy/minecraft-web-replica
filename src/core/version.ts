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
export const VERSION = '1.6.0';
export const RELEASE = 'v1';
export const ENGINE_NAME = 'Minecraft TS';

/**
 * 插件 API 契约版本（v1.5.0 引入）。
 * 与项目 VERSION 解耦：日常迭代不动 API 契约，只有 PluginManifest / PluginContext
 * 发生不兼容变更时才推进主版本，插件通过 manifest.apiVersion 声明兼容范围。
 * 放在唯一版本源文件里，避免被 check-version 的「禁止硬编码版本字面量」扫描误伤。
 */
export const PLUGIN_API_VERSION = '2.1.0';

/** 插件未声明 version 时参与依赖范围比较的占位版本 */
export const UNSPECIFIED_PLUGIN_VERSION = '0.0.0';
