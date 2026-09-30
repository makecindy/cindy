import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBundledEndpointManifest,
  type EndpointManifestCacheEntry,
  type ClientEndpointRegion,
} from '@cindy/maker-shared/client-endpoints';
import { resolveDesktopEndpointManifest } from '../endpointManifestLoader';

const cache = vi.hoisted(() => new Map<string, EndpointManifestCacheEntry>());
vi.mock('../endpointManifestCache', () => ({
  readEndpointManifestCache: (_dir: string, region?: string) =>
    cache.get(region ?? 'legacy') ?? null,
  writeEndpointManifestCache: (
    _dir: string,
    entry: EndpointManifestCacheEntry,
    region?: string,
  ) => {
    cache.set(region ?? 'legacy', entry);
    return true;
  },
}));
const base = (region: ClientEndpointRegion) =>
  `https://hotfix.cindy.${region === 'cn' ? 'com.cn' : 'app'}/cindy`;
const text = (region: ClientEndpointRegion) =>
  getBundledEndpointManifest(region, `${base(region)}/endpoint.json`)!;
const offline = async () => ({ ok: false as const, detail: 'ERR_CONNECTION_TIMED_OUT' });
beforeEach(() => cache.clear());

describe('desktop persistent regional discovery', () => {
  it('migrates legacy cache by reading it only for its matching source and region', async () => {
    const manifestText = JSON.stringify({
      ...JSON.parse(text('cn')),
      authApiBaseUrl: 'https://auth-next.cindy.com.cn',
    });
    cache.set('legacy', {
      savedAt: new Date().toISOString(),
      sourceUrl: `${base('cn')}/endpoint.json`,
      manifestText,
    });
    expect(
      await resolveDesktopEndpointManifest('/fake-user-data', 'cn', base('cn'), offline),
    ).toMatchObject({ ok: true, source: 'cache', text: manifestText });
    expect(
      await resolveDesktopEndpointManifest('/fake-user-data', 'global', base('global'), offline),
    ).toMatchObject({ ok: true, source: 'bundled', text: text('global') });
  });

  it('writes separate files and recovers either region after process memory is lost', async () => {
    for (const region of ['cn', 'global'] as const) {
      expect(
        await resolveDesktopEndpointManifest('/fake-user-data', region, base(region), async () => ({
          ok: true,
          text: text(region),
        })),
      ).toMatchObject({ ok: true, source: 'network' });
    }
    expect([...cache.keys()].sort()).toEqual(['cn', 'global']);
    for (const region of ['cn', 'global'] as const) {
      expect(
        await resolveDesktopEndpointManifest('/fake-user-data', region, base(region), offline),
      ).toMatchObject({ ok: true, source: 'cache', text: text(region) });
    }
  });
});
