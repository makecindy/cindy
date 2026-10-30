import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyEndpointManifestFailure,
  getBundledEndpointManifest,
  getEndpointManifestMirrors,
  resolveResilientEndpointManifest,
  type ClientEndpointRegion,
  type EndpointManifestCacheEntry,
  type EndpointManifestFetchResult,
} from '../clientEndpoints';

const sourceUrl = (region: ClientEndpointRegion) =>
  `https://hotfix.cindy.${region === 'cn' ? 'com.cn' : 'app'}/cindy/endpoint.json`;
const manifest = (region: ClientEndpointRegion, extra = {}) =>
  JSON.stringify({
    ...JSON.parse(getBundledEndpointManifest(region, sourceUrl(region))!),
    ...extra,
  });
const fail = async (): Promise<EndpointManifestFetchResult> => ({
  ok: false,
  detail: 'timeout-2500ms',
});
const entry = (
  region: ClientEndpointRegion,
  extra = {},
): EndpointManifestCacheEntry => ({
  sourceUrl: sourceUrl(region),
  savedAt: '2026-09-19T00:00:00Z',
  manifestText: manifest(region, extra),
});

afterEach(() => vi.useRealTimers());

describe('regional endpoint resilience', () => {
  it.each(['cn', 'global'] as const)(
    'compiled %s mirrors are bounded HTTPS trust anchors',
    (region) => {
      const urls = getEndpointManifestMirrors(region, sourceUrl(region));
      expect(urls.length).toBeLessThanOrEqual(1);
      for (const raw of urls) {
        const url = new URL(raw);
        expect(url.protocol).toBe('https:');
        expect(url.username + url.password + url.hash).toBe('');
        expect(url.hostname).not.toBe(new URL(sourceUrl(region)).hostname);
      }
    },
  );

  it.each(['cn', 'global'] as const)(
    'boots %s without network or cache using its complete bundled snapshot',
    async (region) => {
      const writeCache = vi.fn();
      const result = await resolveResilientEndpointManifest({
        region,
        sourceUrl: sourceUrl(region),
        fetchText: fail,
        writeCache,
      });
      expect(result).toMatchObject({
        ok: true,
        source: 'bundled',
        text: manifest(region),
      });
      expect(writeCache).not.toHaveBeenCalled();
    },
  );

  it('persists the validated raw online document, including unknown fields, and restores it on the next launch', async () => {
    let persisted: unknown;
    const text = manifest('cn', {
      authApiBaseUrl: 'https://auth-next.cindy.com.cn',
      futureEndpoint: 'keep-me',
      voiceApiBaseUrl: '',
    });
    const deps = {
      region: 'cn' as const,
      sourceUrl: sourceUrl('cn'),
      readCache: () => persisted,
      writeCache: (value: unknown) => {
        persisted = value;
      },
    };
    expect(
      await resolveResilientEndpointManifest({
        ...deps,
        fetchText: async () => ({ ok: true, text }),
      }),
    ).toMatchObject({ ok: true, source: 'network' });
    expect(persisted).toMatchObject({ manifestText: text });
    expect(
      await resolveResilientEndpointManifest({ ...deps, fetchText: fail }),
    ).toMatchObject({
      ok: true,
      source: 'cache',
      text,
      parsed: {
        endpoints: {
          voiceApiBaseUrl: '',
          authApiBaseUrl: 'https://auth-next.cindy.com.cn',
        },
      },
    });
  });

  it.each([
    ['invalid-json', '{'],
    ['unsupported-schema-version:99', manifest('cn', { schemaVersion: 99 })],
    ['region-mismatch:cn:global', manifest('cn', { region: 'global' })],
    [
      'invalid-protocol:authApiBaseUrl',
      manifest('cn', { authApiBaseUrl: 'http://auth.cindy.com.cn' }),
    ],
  ])('does not hide online configuration errors: %s', async (reason, text) => {
    const readCache = vi.fn(() => entry('cn'));
    const fetchText = vi.fn(async () => ({ ok: true as const, text }));
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        readCache,
        fetchText,
        mirrorUrls: ['https://backup.example.com/cn/endpoint.json'],
      }),
    ).toEqual({ ok: false, reason });
    expect(readCache).not.toHaveBeenCalled();
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 301])('keeps HTTP %i blocking', async (status) => {
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText: async () => ({ ok: false, detail: `http-${status}` }),
      }),
    ).toEqual({ ok: false, reason: `fetch-failed:http-${status}` });
  });

  it.each([407, 408, 425, 429, 500, 503])(
    'allows fallback for transient HTTP %i',
    async (status) => {
      expect(
        classifyEndpointManifestFailure(`fetch-failed:http-${status}`),
      ).toBe('network');
    },
  );

  it.each([
    entry('global'),
    { ...entry('cn'), manifestText: manifest('global') },
    entry('cn', {
      authApiBaseUrl: 'https://auth.cindy.com.cn.attacker.example',
    }),
    { ...entry('cn'), sourceUrl: 'https://old.cindy.com.cn/endpoint.json' },
    { ...entry('cn'), savedAt: 'broken' },
    { ...entry('cn'), manifestText: '{' },
  ])(
    'rejects wrong-region, wrong-source and damaged caches',
    async (cached) => {
      expect(
        await resolveResilientEndpointManifest({
          region: 'cn',
          sourceUrl: sourceUrl('cn'),
          fetchText: fail,
          readCache: () => cached,
        }),
      ).toMatchObject({ ok: true, source: 'bundled', text: manifest('cn') });
    },
  );

  it('uses an independent mirror for the same region and persists against the primary identity', async () => {
    const text = manifest('cn', {
      authApiBaseUrl: 'https://auth-next.cindy.com.cn',
    });
    const fetchText = vi
      .fn()
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce({ ok: true, text });
    const writeCache = vi.fn();
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText,
        writeCache,
        mirrorUrls: ['https://backup.example.com/cn/endpoint.json'],
      }),
    ).toMatchObject({ ok: true, source: 'mirror', text });
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: sourceUrl('cn'),
        manifestText: text,
      }),
    );
  });

  it('does not accept region-less Global endpoints from a CN mirror', async () => {
    const fetchText = vi
      .fn()
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce({ ok: true, text: manifest('global') });
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText,
        mirrorUrls: ['https://backup.example.com/cn/endpoint.json'],
      }),
    ).toMatchObject({ ok: true, source: 'bundled', text: manifest('cn') });
  });

  it.each(['cn', 'global'] as const)(
    'only persists restorable %s snapshots from custom sources',
    async (region) => {
      const customSource = 'https://custom.example.com/endpoint.json';
      const text = manifest(region, {
        authApiBaseUrl: 'https://auth.custom.example.com',
      });
      const writeCache = vi.fn();
      expect(
        await resolveResilientEndpointManifest({
          region,
          sourceUrl: customSource,
          writeCache,
          fetchText: async () => ({ ok: true, text }),
        }),
      ).toMatchObject({ ok: true, source: 'network', text });
      expect(writeCache).not.toHaveBeenCalled();
      // Even a legacy entry must not make custom domains trusted offline.
      expect(
        await resolveResilientEndpointManifest({
          region,
          sourceUrl: customSource,
          fetchText: fail,
          readCache: () => ({
            ...entry(region),
            sourceUrl: customSource,
            manifestText: text,
          }),
        }),
      ).toMatchObject({ ok: false });
      const trustedText = manifest(region);
      await resolveResilientEndpointManifest({
        region,
        sourceUrl: customSource,
        writeCache,
        fetchText: async () => ({ ok: true, text: trustedText }),
      });
      expect(writeCache).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceUrl: customSource,
          manifestText: trustedText,
        }),
      );
      expect(
        await resolveResilientEndpointManifest({
          region,
          sourceUrl: customSource,
          fetchText: fail,
          readCache: () => writeCache.mock.calls[0][0],
        }),
      ).toMatchObject({ ok: true, source: 'cache', text: trustedText });
    },
  );

  it.each([
    ['JSON', { ok: true, text: '{' }],
    ['schema', { ok: true, text: manifest('cn', { schemaVersion: 99 }) }],
    ['region', { ok: true, text: manifest('cn', { region: 'global' }) }],
    [
      'domain',
      {
        ok: true,
        text: manifest('cn', { authApiBaseUrl: 'https://auth.future.example' }),
      },
    ],
    [
      'protocol',
      {
        ok: true,
        text: manifest('cn', { authApiBaseUrl: 'http://auth.cindy.com.cn' }),
      },
    ],
    ['404', { ok: false, detail: 'http-404' }],
  ] as const)(
    'skips incompatible mirror %s without caching it',
    async (_kind, response) => {
      for (const cached of [
        undefined,
        entry('cn', { authApiBaseUrl: 'https://cached.cindy.com.cn' }),
      ]) {
        const writeCache = vi.fn();
        const fetchText = vi
          .fn()
          .mockImplementationOnce(fail)
          .mockResolvedValueOnce(response);
        expect(
          await resolveResilientEndpointManifest({
            region: 'cn',
            sourceUrl: sourceUrl('cn'),
            fetchText,
            writeCache,
            readCache: () => cached,
          }),
        ).toMatchObject({
          ok: true,
          source: cached ? 'cache' : 'bundled',
          text: cached?.manifestText ?? manifest('cn'),
        });
        expect(fetchText).toHaveBeenCalledTimes(2);
        expect(writeCache).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    'invalid',
    'http://backup.example.com/endpoint.json',
    'https://user:pass@backup.example.com/endpoint.json',
  ])('skips invalid mirror URL %s without requesting it', async (url) => {
    const fetchText = vi.fn(fail);
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText,
        mirrorUrls: [url],
      }),
    ).toMatchObject({ ok: true, source: 'bundled' });
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: url,
        fetchText,
      }),
    ).toEqual({ ok: false, reason: 'invalid-manifest-url' });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('never switches a custom environment to official services', async () => {
    const url = 'https://custom.example.com/endpoint.json';
    expect(getEndpointManifestMirrors('cn', url)).toEqual([]);
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: url,
        fetchText: fail,
      }),
    ).toEqual({ ok: false, reason: 'fetch-failed:timeout-2500ms' });
  });

  it('bounds a hung transport and ignores a late response without persisting it', async () => {
    vi.useFakeTimers();
    let finish!: (value: EndpointManifestFetchResult) => void;
    const writeCache = vi.fn();
    const pending = resolveResilientEndpointManifest({
      region: 'cn',
      sourceUrl: sourceUrl('cn'),
      mirrorUrls: [],
      writeCache,
      fetchText: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toMatchObject({ ok: true, source: 'bundled' });
    finish({ ok: true, text: manifest('global') });
    await vi.runAllTimersAsync();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('storage failure cannot turn successful authentication discovery into a startup failure', async () => {
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText: fail,
        readCache: () => {
          throw new Error('disk unavailable');
        },
      }),
    ).toMatchObject({ ok: true, source: 'bundled' });
    expect(
      await resolveResilientEndpointManifest({
        region: 'cn',
        sourceUrl: sourceUrl('cn'),
        fetchText: async () => ({ ok: true, text: manifest('cn') }),
        writeCache: () => {
          throw new Error('disk full');
        },
      }),
    ).toMatchObject({ ok: true, source: 'network' });
  });
});
