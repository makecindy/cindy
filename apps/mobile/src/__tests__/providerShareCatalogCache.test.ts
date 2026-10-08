import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllProviderShareCatalogs,
  evictProviderShareCatalogs,
  getCachedProviderShareCatalogs,
  parseProviderShareCatalogPayload,
  parseProviderShareCatalogs,
  refreshProviderShareCatalogs,
  subscribeProviderShareCatalogs,
} from '@/device-link/providerShareCatalogCache';

const anthropic = {
  id: 'anthropic',
  name: 'Anthropic',
  agents: ['claude-code', 'pi'],
  connected: true,
  remoteInvocationEnabled: true,
  models: {
    'claude-code': [
      { id: 'claude-x', name: 'Claude X', contextWindow: 200_000, efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: '', name: 'Broken', contextWindow: 1, efforts: [] },
    ],
  },
  routing: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
};
const other = { ...anthropic, id: 'other', name: 'Other' };

const rawShare = (patch: Record<string, unknown> = {}) => ({
  agentDeviceId: 'share:share-1',
  shareId: 'share-1',
  providerId: 'anthropic',
  providerLabel: 'Anthropic',
  deviceName: "Magi's Mac Mini",
  owner: { displayName: 'Magi', avatarUrl: null },
  status: 'active',
  hostOnline: true,
  catalog: {
    providers: [anthropic, other],
    providerOrder: ['anthropic'],
    modelVisibilityOverrides: { 'claude-code:anthropic:claude-x': true, junk: 'yes' },
  },
  ...patch,
});

afterEach(() => {
  clearAllProviderShareCatalogs();
});

describe('provider share catalog parsing', () => {
  it('keeps only the shared provider, drops invalid models and fills routing like Desktop', () => {
    const payload = parseProviderShareCatalogPayload(rawShare().catalog, 'anthropic');
    expect(payload?.providers.map((provider) => provider.id)).toEqual(['anthropic']);
    expect(payload?.providers[0].models['claude-code']?.map((model) => model.id)).toEqual(['claude-x']);
    expect(payload?.providers[0].routing).toEqual({
      'claude-code': { wireProtocol: 'anthropic-messages' },
      pi: {},
    });
    expect(payload?.modelVisibilityOverrides).toEqual({ 'claude-code:anthropic:claude-x': true });
    // 入参不被改写。
    expect(anthropic.models['claude-code']).toHaveLength(2);
  });

  it('treats unreadable catalogs as missing and readable ones without the shared provider as empty', () => {
    expect(parseProviderShareCatalogPayload(null, 'anthropic')).toBeNull();
    expect(parseProviderShareCatalogPayload({ providers: 'x' }, 'anthropic')).toBeNull();
    for (const providers of [
      [],
      [other],
      [{ ...anthropic, connected: 'yes' }],
      [{ ...anthropic, routing: { pi: { wireProtocol: 'smtp' } } }],
      [{ ...anthropic, models: { 'claude-code': 'x' } }],
    ]) {
      expect(parseProviderShareCatalogPayload({ providers }, 'anthropic')).toEqual({ providers: [] });
    }
  });

  it('parses the received list, skipping invalid shares and keeping only nickname identity', () => {
    const entries = parseProviderShareCatalogs({
      shares: [
        rawShare(),
        rawShare({ shareId: 'paused', agentDeviceId: 'share:paused', status: 'paused', catalog: null }),
        rawShare({ shareId: 'bad', agentDeviceId: 'share:other' }),
        rawShare({ shareId: 'nameless', agentDeviceId: 'share:nameless', owner: { displayName: '' } }),
      ],
    });
    expect(entries.map((entry) => [entry.agentDeviceId, entry.status, entry.payload ? 'catalog' : null])).toEqual([
      ['share:share-1', 'active', 'catalog'],
      ['share:paused', 'paused', null],
    ]);
    expect(entries[0]).toMatchObject({ deviceName: "Magi's Mac Mini", ownerName: 'Magi', providerId: 'anthropic' });
    expect(parseProviderShareCatalogs({ nope: true })).toEqual([]);
  });
});

describe('provider share catalog cache', () => {
  it('caches per controlled computer and notifies mounted pickers', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderShareCatalogs('controlled', listener);
    const entries = await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    expect(entries).toHaveLength(1);
    expect(getCachedProviderShareCatalogs('controlled')).toBe(entries);
    expect(getCachedProviderShareCatalogs('elsewhere')).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(entries);
    unsubscribe();
  });

  it('shares one in-flight read', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = refreshProviderShareCatalogs('controlled', fetcher);
    const second = refreshProviderShareCatalogs('controlled', fetcher);
    await Promise.resolve();
    resolve({ shares: [] });
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats an older Desktop without the channel as having no shares', async () => {
    await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    const entries = await refreshProviderShareCatalogs('controlled', async () => {
      throw Object.assign(new Error('not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });
    });
    expect(entries).toEqual([]);
    expect(getCachedProviderShareCatalogs('controlled')).toEqual([]);
  });

  it('keeps the last catalog when a read fails or a share is momentarily unreadable', async () => {
    const first = await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    await expect(refreshProviderShareCatalogs('controlled', async () => {
      throw Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' });
    })).rejects.toThrow('timeout');
    expect(getCachedProviderShareCatalogs('controlled')).toBe(first);
    const next = await refreshProviderShareCatalogs('controlled', async () => ({
      shares: [rawShare({ hostOnline: false, catalog: null })],
    }));
    expect(next[0].hostOnline).toBe(false);
    expect(next[0].payload).toBe(first[0].payload);
    // 读到了但对方关了「允许被远程调用」(分享者电脑过滤后为空):用空目录,不沿用旧的。
    const closed = await refreshProviderShareCatalogs('controlled', async () => ({
      shares: [rawShare({ catalog: { providers: [] } })],
    }));
    expect(closed[0].payload).toEqual({ providers: [] });
    // 分享被删除后不再带回旧目录。
    expect(await refreshProviderShareCatalogs('controlled', async () => ({ shares: [] }))).toEqual([]);
  });

  it('drops results that arrive after the controlled computer was evicted or the account changed', async () => {
    let resolve!: (value: unknown) => void;
    const pending = refreshProviderShareCatalogs('controlled', () => new Promise((done) => { resolve = done; }));
    evictProviderShareCatalogs('controlled');
    await Promise.resolve();
    resolve({ shares: [rawShare()] });
    await pending;
    expect(getCachedProviderShareCatalogs('controlled')).toBeUndefined();

    await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    clearAllProviderShareCatalogs();
    expect(getCachedProviderShareCatalogs('controlled')).toBeUndefined();
  });
});
