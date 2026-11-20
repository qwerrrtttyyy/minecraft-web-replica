import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * 轻量静态门禁（v1.5.0）。
 *
 * 项目此前只靠 tsc --noEmit 兜底，没有 lint / format 配置。这里只开启
 * 「零误报、能机械执行」的规则，避免一次性引入大面积整改：
 * 语法级硬错误 + no-explicit-any + 未使用变量（下划线前缀豁免）。
 * 规则集随源码质量提升再逐步加严，不把 verify 变成一次性红灯墙。
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.test-build/**',
      'test/logic/**',
      'test/terrain-logic/**',
      'test/artifacts/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-var': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
