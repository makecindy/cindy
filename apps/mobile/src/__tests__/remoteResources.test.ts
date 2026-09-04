import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';

import {
  MOBILE_REMOTE_RESOURCE_PRIMITIVES,
  discoverRemoteHomeCollections,
  isRemoteResourcesUnsupported,
  mergeRemoteCollectionHostShards,
  normalizeRemoteCollectionItems,
  parseRemoteResourceTargets,
  serializeRemoteResourceTargets,
} from '@/device-link/remoteResources';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';

const targets = [
  { deviceId: 'mac-1', deviceName: 'Studio' },
  { deviceId: 'mac-2', deviceName: 'Laptop' },
];

describe('remote resource discovery', () => {
  it('advertises only primitives implemented by the current mobile shell', () => {
    expect(MOBILE_REMOTE_RESOURCE_PRIMITIVES).toEqual(['status', 'session-link']);
  });

  it('merges host-advertised home collections without knowing their feature module', async () => {
    const invoke = vi.fn(async (deviceId: string) => ({
      protocolVersion: 1,
      collections: [{
        id: 'teammates',
        resourceKind: 'bot',
        placement: 'home-scope',
        title: {
          fallback: 'Teammates',
          translations: { 'zh-CN': '所有伙伴' },
        },
        futureField: deviceId,
      }],
    })) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'zh-CN')).resolves.toEqual([{
      id: 'teammates',
      title: '所有伙伴',
      resourceKind: 'bot',
      placement: 'home-scope',
      iconName: undefined,
      targets,
    }]);
  });

  it('surfaces an all-host transient failure so callers can retain their last manifest', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('temporarily offline');
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en'))
      .rejects.toThrow('temporarily offline');
  });

  it('treats an old host as unsupported while retaining collections from newer hosts', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old desktop');
      return {
        protocolVersion: 1,
        collections: [{
          id: 'future-module',
          resourceKind: 'future-resource',
          placement: 'home-scope',
          title: 'Future module',
        }],
      };
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en')).resolves.toMatchObject([{
      id: 'future-module',
      targets: [{ deviceId: 'mac-2' }],
    }]);
    expect(isRemoteResourcesUnsupported(
      Object.assign(new Error('wrapped'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
    )).toBe(true);
  });

  it('keeps the last manifest when unsupported hosts are mixed with a transient failure', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old desktop');
      throw new Error('temporarily offline');
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en'))
      .rejects.toThrow('temporarily offline');
  });

  it('retains a failed host manifest shard when another supported host returns empty', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new Error('temporarily offline');
      return { protocolVersion: 1, collections: [] };
    }) as RemoteInvoke;
    const previous = [{
      id: 'teammates',
      title: 'Teammates',
      resourceKind: 'bot',
      placement: 'home-scope',
      targets: [targets[0]],
    }];

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en', previous))
      .resolves.toEqual(previous);
  });
});

describe('remote resource response boundaries', () => {
  it('keeps valid additive items and drops malformed or cross-collection items', () => {
    expect(normalizeRemoteCollectionItems({ items: [
      {
        ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
        display: { title: 'Cindy', futureDisplay: true },
        links: [],
        revision: '1',
        futureField: true,
      },
      {
        ref: { collectionId: 'other', kind: 'bot', id: 'bot-2' },
        display: { title: 'Wrong scope' },
        links: [],
        revision: '1',
      },
      { display: null },
    ] }, 'teammates')).toHaveLength(1);
  });

  it('normalizes hostile optional display and link fields before rendering', () => {
    const [item] = normalizeRemoteCollectionItems({ items: [{
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
      display: {
        title: 'Cindy',
        timestamp: 9e15,
        avatar: { kind: 'emoji', value: { boom: true }, fallbackText: 'C' },
        status: { label: 42 },
      },
      links: [
        { rel: 'conversation', target: { kind: 'session', sessionId: 42 } },
        { rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } },
      ],
      revision: '1',
    }] }, 'teammates');

    expect(item).toEqual({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
      display: { title: 'Cindy' },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
      revision: '1',
    });
  });

  it('replaces only successful host shards and preserves provider order', () => {
    const item = (deviceId: string, id: string) => ({
      key: `${deviceId}:${id}`,
      host: targets.find((target) => target.deviceId === deviceId)!,
      item: {
        ref: { collectionId: 'teammates', kind: 'bot', id },
        display: { title: id },
        links: [],
        revision: '1',
      },
    });
    const current = [item('mac-1', 'stale-1'), item('mac-2', 'old-2')];
    const next = [item('mac-2', 'provider-first'), item('mac-2', 'provider-second')];

    expect(mergeRemoteCollectionHostShards(
      current,
      next,
      new Set(['mac-2']),
      targets,
    ).map((entry) => entry.item.ref.id)).toEqual([
      'stale-1',
      'provider-first',
      'provider-second',
    ]);
  });
});

describe('remote resource route targets', () => {
  it('round-trips bounded host identities and rejects malformed params', () => {
    expect(parseRemoteResourceTargets(serializeRemoteResourceTargets(targets))).toEqual(targets);
    expect(parseRemoteResourceTargets('{broken')).toEqual([]);
    expect(parseRemoteResourceTargets(JSON.stringify([{ deviceId: '', deviceName: 'Nope' }])))
      .toEqual([]);
  });
});
