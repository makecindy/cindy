import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    // env.ts 顶层引用 __DEV__(metro 全局);vitest node 环境按 prod 语义跑
    // (端点初值只看显式 env,不 require 仓内 endpoint.json)。
    __DEV__: false,
  },
  plugins: [
    {
      // scripts/*.mjs 带 shebang(#!/usr/bin/env node)。vite-node 内联执行这类
      // 模块时不剥 hashbang,包进函数体后成非法 token,ciFingerprintScript.test.ts /
      // releaseLib.test.ts 在本地(Windows + Node 25 实测)整文件 SyntaxError;
      // CI(ubuntu + Node 22)不复现。与 apps/desktop/vitest.config.ts 同款修复:
      // transform 前把首行 shebang 置空(保留换行,行号不漂移,无需 sourcemap)。
      name: 'strip-hashbang',
      enforce: 'pre' as const,
      transform(code: string) {
        if (code.startsWith('#!')) return { code: code.replace(/^#![^\n]*/, ''), map: null };
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      // fileURLToPath 而非 URL.pathname:后者会把路径里的空格等字符百分号编码
      // (checkout 路径含空格时 alias 指向不存在的 %20 路径,255 个测试文件整体
      // TEST_COLLECT_FAILED);无空格路径下两者逐字节一致,CI 行为零变化。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'expo-constants': fileURLToPath(new URL('./src/__tests__/expo-constants.mock.ts', import.meta.url)),
      // expo-localization 同款处理:真模块拖 react-native(Flow 语法)依赖链;
      // 需要控制语言的测试用 vi.mock 覆盖(优先于 alias)。
      'expo-localization': fileURLToPath(new URL('./src/__tests__/expo-localization.mock.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // The release-script tests spawn a real bash + shell script + curl/python
    // shims; on Windows (Git Bash) that process churn is slow and, under the
    // full suite's worker-pool contention, blows past vitest's 5s default. Give
    // Windows a wider default; keep the standard 5s on Linux/macOS/CI so real
    // hangs still surface promptly.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    env: {
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'https://relay.example.invalid',
      EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL: 'https://gateway.example.invalid',
    },
  },
});
