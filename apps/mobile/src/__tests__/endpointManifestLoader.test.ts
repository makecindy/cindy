import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBundledEndpointManifest } from '@cindy/maker-shared/client-endpoints';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
  },
}));
const cnBase = 'https://hotfix.cindy.com.cn/cindy';
const globalBase = 'https://hotfix.cindy.app/cindy';
const cnText = getBundledEndpointManifest('cn', `${cnBase}/endpoint.json`)!;
const globalText = getBundledEndpointManifest(
  'global',
  `${globalBase}/endpoint.json`,
)!;

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', 'global');
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL', globalBase);
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL', cnBase);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('mobile endpoint startup and recovery', () => {
  it.each(['cn', 'global'] as const)('uses the compiled GitHub backup for %s when hotfix fails', async (region) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith('https://raw.githubusercontent.com/')) throw new TypeError('hotfix unavailable');
      return { ok: true, text: async () => region === 'cn' ? cnText : globalText };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolveMobileEndpointManifest } = await import('@/config/endpointManifestLoader');
    const result = await resolveMobileEndpointManifest(region, region === 'cn' ? cnBase : globalBase);
    expect(result).toMatchObject({ ok: true, source: 'mirror', text: region === 'cn' ? cnText : globalText });
    const filename = region === 'cn' ? 'endpoint.json' : 'endpoint.global.json';
    expect(fetchMock.mock.calls[1][0]).toContain(
      `https://raw.githubusercontent.com/makecindy/cindy/main/config/${filename}?`,
    );
    expect(storage.size).toBe(1);
  });

  it('persists both regions, survives module reload, and restores CN endpoints without changing the Global update identity', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      text: async () => (url.startsWith(cnBase) ? cnText : globalText),
    }));
    vi.stubGlobal('fetch', fetchMock);
    let startup = await import('@/config/clientEndpointStartup');
    let env = await import('@/config/env');
    expect(await startup.runStartupEndpointResolve()).toEqual({
      ok: true,
      source: 'cdn',
    });
    await env.loadMobileEndpointsForRealm('cn');
    expect(storage.size).toBe(2);
    vi.resetModules();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    startup = await import('@/config/clientEndpointStartup');
    env = await import('@/config/env');
    expect(await startup.runStartupEndpointResolve()).toEqual({
      ok: true,
      source: 'cache',
    });
    await env.loadMobileEndpointsForRealm('cn');
    const updateEndpoint = env.OTA_SERVER_BASE_URL;
    env.activateMobileSessionRealm('cn');
    expect(env.AUTH_API_BASE_URL).toBe('https://auth.cindy.com.cn');
    expect(env.getActiveMobileSessionRealm()).toBe('cn');
    expect(env.BUILD_AUTH_REGION).toBe('global');
    expect(env.OTA_SERVER_BASE_URL).toBe(updateEndpoint);
    env.resetMobileSessionRealm();
    expect(env.AUTH_API_BASE_URL).toBe('https://auth.cindy.app');
  });

  it('first install can start and load the other region while hotfix is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const startup = await import('@/config/clientEndpointStartup');
    const env = await import('@/config/env');
    expect(await startup.runStartupEndpointResolve()).toEqual({
      ok: true,
      source: 'bundled',
    });
    expect(await env.loadMobileEndpointsForRealm('cn')).toMatchObject({
      authApiBaseUrl: 'https://auth.cindy.com.cn',
    });
    expect(storage.size).toBe(0);
  });

  it('aborts a stalled fetch before continuing with the bundled snapshot', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signals.push(options.signal);
        return new Promise(() => {});
      }),
    );
    const { resolveMobileEndpointManifest } =
      await import('@/config/endpointManifestLoader');
    const result = resolveMobileEndpointManifest('cn', cnBase);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ ok: true, source: 'bundled' });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
