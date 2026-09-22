import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const babel = require('@babel/core') as {
  transformFileSync(filename: string, options: Record<string, unknown>): { code?: string };
};
const expoPreset = require('babel-preset-expo');

afterEach(() => vi.unstubAllEnvs());

describe('mobile endpoint overrides after Expo bundle transform', () => {
  it.each([false, true])('keeps explicit endpoints without a runtime shell env (production=%s)', (isProd) => {
    const env = {
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
      EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'http://localhost:3344',
      EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'http://localhost:3335',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const filename = resolve(process.cwd(), 'src/config/env.ts');
    const transformed = babel.transformFileSync(filename, {
      babelrc: false, configFile: false, filename,
      envName: isProd ? 'production' : 'development',
      caller: { name: 'metro', platform: 'android', isDev: !isProd },
      presets: [[expoPreset, { platform: 'android' }]],
    });
    expect(transformed.code).toBeTruthy();
    const exports: Record<string, unknown> = {};
    runInNewContext(transformed.code!, {
      exports, process: { env: {} }, __DEV__: false,
      require(id: string) {
        if (id.startsWith('@babel/runtime/')) return require(id);
        if (id === 'expo/virtual/env') return { env };
        if (id === 'expo-application') return {};
        if (id === 'expo-constants') return { expoConfig: { extra: { xdtProductionEnv: {
          EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
          EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://fallback.example.invalid',
        } } } };
        if (id === '@cindy/maker-shared/client-endpoints') return {};
        if (id === './endpointManifestLoader') return {
          resolveMobileEndpointManifest() {
            throw new Error('Importing endpoint overrides must not fetch a manifest');
          },
        };
        throw new Error(`Unexpected import: ${id}`);
      },
    });
    expect(exports.AUTH_REGION).toBe('global');
    expect(exports.AUTH_API_BASE_URL).toBe(env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL);
    expect(exports.DEVICE_LINK_API_BASE_URL).toBe(env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL);
  });
});
