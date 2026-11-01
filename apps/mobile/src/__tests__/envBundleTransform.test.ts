import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { CustomResolutionContext } from '@expo/metro/metro-resolver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import metroConfig from '../../metro.config.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core') as typeof import('@babel/core');
const expoPreset = require('babel-preset-expo');
const collectDependencies =
  require('@expo/metro/metro/ModuleGraph/worker/collectDependencies')
    .default as typeof import('@expo/metro/metro/ModuleGraph/worker/collectDependencies').default;
const { resolve: metroResolve } =
  require('@expo/metro/metro-resolver') as typeof import('@expo/metro/metro-resolver');
const resolveMobileModule = metroConfig.resolver.resolveRequest!;
const filename = resolve(process.cwd(), 'src/config/env.ts');

function transformEnv(isProd: boolean) {
  const caller = { name: 'metro', platform: 'android', isDev: !isProd };
  return babel.transformFileSync(filename, {
    ast: true,
    babelrc: false,
    configFile: false,
    filename,
    envName: isProd ? 'production' : 'development',
    caller,
    presets: [[expoPreset, { platform: 'android' }]],
  })!;
}

function endpointResolutionContext(
  isProd: boolean,
  privateManifestPresent: boolean,
): CustomResolutionContext {
  const files = new Set([
    resolve(process.cwd(), '../../config/endpoint.json'),
    resolve(process.cwd(), '../../config/endpoint.global.json'),
    ...(privateManifestPresent
      ? [resolve(process.cwd(), '../../config/endpoint.dev.json')]
      : []),
  ]);
  return {
    originModulePath: filename,
    dev: !isProd,
    resolveRequest: metroResolve,
    fileSystemLookup: (filePath) =>
      files.has(filePath)
        ? { exists: true, type: 'f', realPath: filePath }
        : { exists: false },
    doesFileExist: (filePath) => files.has(filePath),
    getPackage: () => null,
    getPackageForModule: () => null,
    assetExts: new Set(),
    sourceExts: ['json'],
    mainFields: [],
    allowHaste: false,
    customResolverOptions: {},
    disableHierarchicalLookup: true,
    extraNodeModules: {},
    nodeModulesPaths: [],
    preferNativePlatform: false,
    resolveAsset: () => null,
    redirectModulePath: (modulePath) => modulePath,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    unstable_conditionNames: [],
    unstable_conditionsByPlatform: {},
    unstable_enablePackageExports: false,
    unstable_incrementalResolution: false,
    unstable_logWarning: () => {},
  };
}

afterEach(() => vi.unstubAllEnvs());

// Unit regression: opening the current iOS app failed on plugin-protocol's
// ./manifest.js export. Exercise Metro's real resolver against that TS source.
it.each(['ios', 'android'])('resolves shared plugin protocol TS exports on %s', (platform) => {
  const originModulePath = resolve(process.cwd(), '../../packages/plugin-protocol/src/index.ts');
  const context = {
    ...endpointResolutionContext(false, false),
    originModulePath,
    sourceExts: ['ts', 'js', 'json'],
    fileSystemLookup: (filePath: string) => existsSync(filePath)
      ? { exists: true as const, type: 'f' as const, realPath: filePath }
      : { exists: false as const },
    doesFileExist: existsSync,
  };
  expect(resolveMobileModule(context, './manifest.js', platform)).toEqual({
    type: 'sourceFile',
    filePath: resolve(process.cwd(), '../../packages/plugin-protocol/src/manifest.ts'),
  });
});

describe('mobile endpoint overrides after Expo bundle transform', () => {
  it.each([false, true])(
    'keeps explicit endpoints without a runtime shell env (production=%s)',
    (isProd) => {
      const env = {
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'http://localhost:3344',
        EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL: 'http://localhost:3335',
      };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const transformed = transformEnv(isProd);
      expect(transformed.code).toBeTruthy();
      const exports: Record<string, unknown> = {};
      runInNewContext(transformed.code!, {
        exports,
        process: { env: {} },
        __DEV__: false,
        require(id: string) {
          if (id.startsWith('@babel/runtime/')) return require(id);
          if (id === 'expo/virtual/env') return { env };
          if (id === 'expo-application') return {};
          if (id === 'expo-constants')
            return {
              expoConfig: {
                extra: {
                  xdtProductionEnv: {
                    EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
                    EXPO_PUBLIC_CINDY_AUTH_BASE_URL:
                      'https://fallback.example.invalid',
                  },
                },
              },
            };
          if (id === '@cindy/maker-shared/client-endpoints') return {};
          if (id === './endpointManifestLoader')
            return {
              resolveMobileEndpointManifest() {
                throw new Error(
                  'Importing endpoint overrides must not fetch a manifest',
                );
              },
            };
          throw new Error(`Unexpected import: ${id}`);
        },
      });
      expect(exports.AUTH_REGION).toBe('global');
      expect(exports.AUTH_API_BASE_URL).toBe(
        env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
      );
      expect(exports.DEVICE_LINK_API_BASE_URL).toBe(
        env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL,
      );
    },
  );

  // Regression: clean worktrees have no private endpoint.dev.json. Runtime-only
  // env tests miss Metro collecting every static require, even in inactive branches.
  // Unit: use the real Expo transform, Metro collector and app resolver with an
  // in-memory filesystem; no Metro server, private configuration or device required.
  it.each([
    ['global', false],
    ['cn', false],
    ['global', true],
    ['cn', true],
  ] as const)(
    'bundles %s without requiring or embedding private dev endpoints (production=%s)',
    (region, isProd) => {
      vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', region);
      const { dependencies } = collectDependencies(transformEnv(isProd).ast!, {
        asyncRequireModulePath: 'metro-runtime/src/modules/asyncRequire',
        dependencyMapName: null,
        dynamicRequires: 'reject',
        inlineableCalls: [],
        keepRequireNames: true,
        allowOptionalDependencies: false,
        unstable_allowRequireContext: false,
      });
      const manifests = dependencies.filter(({ name }) =>
        name.includes('/config/endpoint'),
      );
      expect(manifests).toHaveLength(3);
      for (const privateManifestPresent of [false, true]) {
        const context = endpointResolutionContext(
          isProd,
          privateManifestPresent,
        );
        const resolutions = manifests.map(({ name }) =>
          resolveMobileModule(context, name, 'android'),
        );
        expect(
          resolutions
            .filter((result) => result.type === 'sourceFile')
            .map((result) => result.filePath)
            .sort(),
        ).toEqual(
          [
            resolve(process.cwd(), '../../config/endpoint.global.json'),
            resolve(process.cwd(), '../../config/endpoint.json'),
          ].sort(),
        );
        expect(
          resolutions.filter((result) => result.type === 'empty'),
        ).toHaveLength(1);
      }
    },
  );

  it('keeps explicit dev builds on their private manifest and fails if it is missing', () => {
    vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', 'dev');
    const moduleName = '../../../../config/endpoint.dev.json';
    expect(
      resolveMobileModule(
        endpointResolutionContext(false, true),
        moduleName,
        'ios',
      ),
    ).toEqual({
      type: 'sourceFile',
      filePath: resolve(process.cwd(), '../../config/endpoint.dev.json'),
    });
    expect(() =>
      resolveMobileModule(
        endpointResolutionContext(false, false),
        moduleName,
        'ios',
      ),
    ).toThrow(/endpoint\.dev\.json/);
  });
});
