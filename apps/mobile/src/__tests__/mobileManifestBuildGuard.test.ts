import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';

const require = createRequire(import.meta.url);
const baseKey = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL';
const peerKey = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL';
const regionKey = 'EXPO_PUBLIC_CINDY_AUTH_REGION';
const managedKeys = [baseKey, peerKey, regionKey, 'NODE_ENV',
  'EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL'];
let previousEnv: Record<string, string | undefined>;
let metro: ReturnType<typeof require>;

function loadMetroConfig() {
  const filename = require.resolve('../../metro.config.js');
  delete require.cache[filename];
  return require(filename);
}

beforeEach(() => {
  previousEnv = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, mobileClientBundleEnv({ authRegion: 'global' }));
  // 故意与实际生产 bundle 模式不同：export:embed 会保留 runner 的 NODE_ENV。
  process.env.NODE_ENV = 'development';
  metro = loadMetroConfig();
});

afterEach(() => {
  for (const key of managedKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function transform(dev = false, platform = 'android') {
  return metro.transformer.getTransformOptions([], { dev, hot: false, platform }, async () => []);
}

describe('Metro production manifest build guard', () => {
  it('preserves the default Metro cache version and app.config default CN bootstrap', async () => {
    const { getDefaultConfig } = require('expo/metro-config');
    const defaultVersion = getDefaultConfig(process.cwd()).cacheVersion;
    expect(metro.cacheVersion.startsWith(`${defaultVersion}:`)).toBe(true);
    expect(metro.cacheVersion).toMatch(/:cindy-mobile-manifest-v1:[a-f0-9]{64}$/);
    for (const key of [regionKey, baseKey, peerKey]) delete process.env[key];
    require('../../app.config.js')();
    metro = loadMetroConfig();
    expect(process.env[regionKey]).toBe('cn');
    await expect(transform()).resolves.toBeDefined();
  });

  it.each(['cn', 'global'])('preserves Expo transform options for valid %s bundles on both platforms', async (authRegion) => {
    Object.assign(process.env, mobileClientBundleEnv({ authRegion }));
    metro = loadMetroConfig();
    for (const platform of ['ios', 'android']) {
      await expect(transform(false, platform)).resolves.toMatchObject({
        transform: { experimentalImportSupport: true, inlineRequires: false },
      });
    }
  });

  it.each(['cn', 'global'])('rejects identical and swapped %s addresses at the actual bundle boundary', async (authRegion) => {
    const expected = mobileClientBundleEnv({ authRegion });
    Object.assign(process.env, expected);
    metro = loadMetroConfig();
    process.env[peerKey] = `${expected[baseKey]}/`;
    await expect(transform()).rejects.toThrow('规范化后不能相同');

    process.env[baseKey] = expected[peerKey];
    process.env[peerKey] = expected[baseKey];
    await expect(transform()).rejects.toThrow('仓内清单不一致');
  });

  it.each([baseKey, peerKey])('checks final %s rather than the initial config or expected values', async (key) => {
    await expect(transform()).resolves.toBeDefined();
    // 模拟 config 已求值后，外部发布入口又覆盖环境；每次 bundle 都要重新校验。
    delete process.env[key];
    await expect(transform()).rejects.toThrow(key);
    process.env[key] = ' ';
    await expect(transform()).rejects.toThrow(key);
    process.env[key] = 'https://wrong.example.invalid/app';
    await expect(transform()).rejects.toThrow('仓内清单不一致');
    process.env[key] = 'https://fake-user:fake-secret@example.invalid/app';
    await expect(transform()).rejects.toThrow(key);
    await expect(transform()).rejects.not.toThrow('fake-secret');
  });

  it('rejects a missing final region instead of silently choosing another build', async () => {
    delete process.env[regionKey];
    await expect(transform()).rejects.toThrow(regionKey);
    process.env[regionKey] = 'fake-secret-not-a-region';
    await expect(transform()).rejects.toThrow(regionKey);
    await expect(transform()).rejects.not.toThrow('fake-secret');
  });

  it('keeps development Metro overrides even if NODE_ENV says production', async () => {
    process.env.NODE_ENV = 'production';
    process.env[baseKey] = 'http://localhost:1234';
    process.env[peerKey] = 'http://localhost:5678';
    await expect(transform(true)).resolves.toBeDefined();
    expect(process.env[baseKey]).toBe('http://localhost:1234');
    expect(process.env[peerKey]).toBe('http://localhost:5678');
  });

  it('does not let a running production build bypass the snapshot guard by changing to CindyDev', async () => {
    process.env[regionKey] = 'dev';
    process.env[baseKey] = 'http://localhost:1234';
    process.env[peerKey] = 'http://localhost:5678';
    await expect(transform()).rejects.toThrow('重启 Metro');
  });

  it('rejects valid but changed production env after Metro and its worker snapshot have loaded', async () => {
    Object.assign(process.env, mobileClientBundleEnv({ authRegion: 'cn' }));
    await expect(transform()).rejects.toThrow('重启 Metro');
    Object.assign(process.env, mobileClientBundleEnv({ authRegion: 'global' }));
    process.env[peerKey] += '/';
    await expect(transform()).rejects.toThrow('重启 Metro');
  });

  it('isolates real cached production transforms across regions while retaining same-env cache hits', async () => {
    const Transformer = require(join(
      dirname(require.resolve('metro/package.json')), 'src/DeltaBundler/Transformer.js',
    )).default;
    const entries = new Map<string, unknown>();
    let cacheHits = 0;
    const cacheStore = {
      async get(key: Buffer) {
        const value = entries.get(key.toString('hex'));
        if (value) cacheHits += 1;
        return value ?? null;
      },
      async set(key: Buffer, value: unknown) { entries.set(key.toString('hex'), value); },
      async clear() { entries.clear(); },
    };
    // 直接给真实 Metro / Expo Babel 传 Buffer，既不写文件，也不使用开发者的磁盘缓存。
    const source = Buffer.from(
      'module.exports = process.env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL;',
    );
    process.env.NODE_ENV = 'production';
    for (const [authRegion, suffix] of [
      ['cn', ''], ['global', ''], ['global', ''], ['cn', ''], ['global', '/'],
    ]) {
      const expected = mobileClientBundleEnv({ authRegion });
      expected[peerKey] += suffix;
      Object.assign(process.env, expected);
      metro = loadMetroConfig();
      const { transform: options } = await transform();
      const transformer = new Transformer({ ...metro, maxWorkers: 1, cacheStores: [cacheStore] }, {
        getOrComputeSha1: async () => { throw new Error('Unexpected filesystem read'); },
      });
      try {
        const result = await transformer.transformFile(join(metro.projectRoot, 'manifest-memory-probe.js'), {
          ...options, customTransformOptions: { engine: 'hermes' },
          dev: false, minify: false, platform: 'android', type: 'module', inlinePlatform: true,
          unstable_transformProfile: 'hermes-stable',
        }, source);
        expect(result.output[0].data.code).toContain(JSON.stringify(expected[peerKey]));
      } finally {
        await transformer.end();
      }
    }
    expect(cacheHits).toBe(2);
  });
});
