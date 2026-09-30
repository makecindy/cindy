import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';

import {
  MOBILE_REMOTE_RESOURCE_PRIMITIVES,
  getRemoteResource,
  invokeRemoteResourceAction,
  listRemoteCollection,
  loadRemoteResourceManifest,
  discoverRemoteHomeCollections,
  remoteResourceDiscoveryTargets,
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
  it('omits desktop routines from live discovery and offline fallback while keeping other collections', async () => {
    const collections = [
      { id: 'routines', title: '例行任务', resourceKind: 'routine', placement: 'home-scope', targets },
      { id: 'teammates', title: 'Companions', resourceKind: 'bot', placement: 'home-scope', targets },
      { id: 'future-module', title: 'Future', resourceKind: 'future', placement: 'home-scope', targets },
    ];
    const invoke = vi.fn(async () => ({ protocolVersion: 1, collections })) as RemoteInvoke;
    const manifest = await loadRemoteResourceManifest(invoke, targets[0]);
    expect(manifest?.collections.map((item) => item.id)).toEqual(['teammates', 'future-module']);
    const live = await discoverRemoteHomeCollections(invoke, targets);
    expect(live.map((item) => item.id)).toEqual(['teammates', 'future-module']);
    const offline = vi.fn(async () => { throw new Error('offline'); }) as RemoteInvoke;
    const restored = await discoverRemoteHomeCollections(offline, targets, 'en', collections);
    expect(restored.map((item) => item.id)).toEqual(['teammates', 'future-module']);
  });

  it('does not send routine reads or actions from stale mobile links', async () => {
    const invoke = vi.fn() as RemoteInvoke;
    const ref = { collectionId: 'routines', kind: 'routine', id: 'daily' };
    await expect(listRemoteCollection(invoke, targets[0], 'routines')).rejects.toThrow('Unsupported mobile resource collection');
    await expect(getRemoteResource(invoke, targets[0], ref)).rejects.toThrow('Unsupported mobile resource collection');
    await expect(invokeRemoteResourceAction(invoke, targets[0], {
      collectionId: 'routines', actionId: 'run-now', resourceRef: ref,
    })).rejects.toThrow('Unsupported mobile resource collection');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps a discovered offline host while excluding revoked and disabled hosts', async () => {
    const previous = [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', targets }];
    const selected = remoteResourceDiscoveryTargets([
      { deviceId: 'mac-1', name: 'Studio', canOpen: false, state: 'offline' },
      { deviceId: 'mac-2', name: 'Laptop', canOpen: false, state: 'access_revoked' },
      { deviceId: 'mac-3', name: 'Disabled', canOpen: false, state: 'remote_disabled' },
    ], previous);
    expect(selected).toEqual([{ ...targets[0], offline: true }]);
    const invoke = vi.fn(async () => { throw new Error('offline'); }) as RemoteInvoke;
    const collections = await discoverRemoteHomeCollections(invoke, selected, 'en', previous);
    expect(collections[0]?.targets).toEqual([targets[0]]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refreshes an offline cached host when it comes online and removes an empty manifest', async () => {
    const previous = [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', targets }];
    const selected = remoteResourceDiscoveryTargets([
      { deviceId: 'mac-1', name: 'Studio', canOpen: true, state: 'online' },
      { deviceId: 'mac-2', name: 'Laptop', canOpen: false, state: 'offline' },
    ], previous);
    const invoke = vi.fn(async () => ({ protocolVersion: 1, collections: [] })) as RemoteInvoke;
    const collections = await discoverRemoteHomeCollections(invoke, selected, 'en', previous);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('mac-1', 'maker:remote-resources:manifest', expect.any(Array));
    expect(collections).toEqual([{ ...previous[0], iconName: undefined, targets: [targets[1]] }]);
  });

  it('advertises only primitives implemented by the current mobile shell', () => {
    expect(MOBILE_REMOTE_RESOURCE_PRIMITIVES).toEqual(['status', 'session-link', 'session-controls']);
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

describe('portable task controls', () => {
  it('preserves only bounded actions and known primitive data, keeping unknown blocks readable', async () => {
    const ref = { collectionId: 'workflow', kind: 'session', id: 'task' };
    const invoke = vi.fn(async () => ({
      ref, revision: '2', display: { title: 'Test' }, links: [],
      actions: [
        { id: 'start', label: 'Start' }, { id: 'continue', label: 'Continue', disabled: true },
        { id: 'form', label: 'Form', fields: [{ id: 'secret' }] },
        { id: 'confirm', label: 'Confirm', confirmation: { title: 'Sure?' } },
        { id: 'bad-confirm', label: 'Bad', confirmation: { title: '' } },
        { id: 'bad-body', label: 'Bad', confirmation: { title: 'Sure?', body: 42 } },
        { id: 'null-confirm', label: 'Bad', confirmation: null },
        { id: 'x'.repeat(161), label: 'Too long' },
      ],
      blocks: [
        { id: 'workflow', primitive: 'session-controls', fallbackMarkdown: 'Installing dependencies', data: { input: 'blocked', busy: true, path: '/private' } },
        { id: 'future', primitive: 'future-widget', fallbackMarkdown: 'Readable fallback', data: { html: '<script>' } },
      ],
    })) as RemoteInvoke;
    const card = await getRemoteResource(invoke, targets[0], ref);
    expect(card.actions).toEqual([{ id: 'start', label: 'Start', disabled: false }, { id: 'continue', label: 'Continue', disabled: true }, { id: 'confirm', label: 'Confirm', disabled: false, confirmation: { title: 'Sure?' } }]);
    expect(card.blocks?.[0].data).toEqual({ input: 'blocked', busy: true });
    expect(card.blocks?.[1]).toEqual({ id: 'future', primitive: 'future-widget', fallbackMarkdown: 'Readable fallback' });
    expect(JSON.stringify(card)).not.toContain('/private');
  });
});

it('preserves additive public generation state without interpreting unknown future phases', () => {
  const input = (generation?: unknown) => ({ items: [{ ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' },
    display: { title: 'Cindy', generation }, links: [], revision: '1' }] });
  expect(normalizeRemoteCollectionItems(input({ phase: 'replying', startedAt: 123 }), 'teammates')[0].display.generation)
    .toEqual({ phase: 'replying', startedAt: 123 });
  expect(normalizeRemoteCollectionItems(input(), 'teammates')[0].display.generation).toBeUndefined();
  expect(normalizeRemoteCollectionItems(input({ phase: {}, startedAt: Infinity }), 'teammates')[0].display.generation).toBeUndefined();
});

describe('bot group chat block', () => {
  const ref = { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' };
  const response = {
    ref, revision: '1', display: { title: '官网介绍页' }, links: [],
    blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '**阿布**: 写好了', data: { id: 'g1', messages: [{ id: 'm1' }] } }],
  };

  it('keeps the structured group data only for the screen that declared the primitive', async () => {
    const invoke = vi.fn(async () => response) as RemoteInvoke;
    const resource = await getRemoteResource(invoke, targets[0], ref, 'zh-CN', ['bot-group-chat']);
    expect(resource.blocks?.[0]).toEqual(response.blocks[0]);
    const request = (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![2] as [{ client: { primitives: string[] } }];
    expect(request[0].client.primitives).toEqual([...MOBILE_REMOTE_RESOURCE_PRIMITIVES, 'bot-group-chat']);
  });

  it('never hands the group data to an ordinary resource view', async () => {
    const invoke = vi.fn(async () => response) as RemoteInvoke;
    const resource = await getRemoteResource(invoke, targets[0], ref);
    expect(resource.blocks?.[0]).toEqual({ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '**阿布**: 写好了' });
  });
});
