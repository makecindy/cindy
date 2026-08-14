import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ['out/', '.vite/', 'dist/', 'src/main/third_party/', 'src/renderer/vendor/'],
  },
  {
    files: ['src/main/**/*.{ts,tsx}'],
    // watcher-host、workdir-probe-host、Review PDF 与 Ghost Node broker 是受测的
    // utilityProcess 宿主，和 localDb 一样属于“进程边界基建”，只对精确入口
    // 豁免导入限制。
    ignores: [
      'src/main/localDb/**/*.{ts,tsx}',
      'src/main/watcher-host/**/*.{ts,tsx}',
      'src/main/workdir-probe-host/**/*.{ts,tsx}',
      'src/main/mcp-integrations/forgeIconConversionHost.ts',
      'src/main/reviewer/reviewPdfProcess.ts',
      'src/main/cindy-brain/nodeRuntimeBroker.ts',
      'src/main/__spike__/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'node:worker_threads',
            message: 'Use DbClient instead. Direct worker_threads breaks escape hatch.',
          },
          {
            name: 'worker_threads',
            message: 'Use DbClient instead. Direct worker_threads breaks escape hatch.',
          },
          {
            name: 'electron',
            importNames: ['utilityProcess'],
            message: 'Use DbClient instead. Direct utilityProcess breaks escape hatch.',
          },
        ],
      }],
    },
  },
);
