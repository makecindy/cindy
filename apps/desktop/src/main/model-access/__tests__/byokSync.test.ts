import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createByokSync,
  PENDING_RETRY_DELAY_MS,
  PENDING_RETRY_LIMIT,
  type ByokConnection,
} from '../byokSync.js';

function provider(id = 'byok-a', connectionRevision = 1) {
  return {
    id,
    name: id,
    connectionRevision,
    models: [
      {
        id: 'byok/a/chat',
        name: 'Chat',
        mode: 'chat',
        agents: ['pi'],
        currency: 'CNY',
        contextWindow: 128000,
        perAgent: { pi: { wireProtocol: 'openai-completions' } },
      },
    ],
  };
}
function directory(providers = [provider()], revision = '1') {
  return { schemaVersion: 1, organizationId: 'org-a', revision, providers };
}
function credentials(ids = ['byok-a'], connectionRevision = 1) {
  return {
    schemaVersion: 1,
    organizationId: 'org-a',
    credentials: ids.map((providerId) => ({
      providerId,
      connectionRevision,
      status: 'ready',
      apiKey: 'invalid-test-key-' + providerId,
      endpoint: 'https://gateway.example.invalid/v1',
    })),
  };
}
function setup() {
  let active: readonly ByokConnection[] = [];
  const fetch = vi.fn();
  const replace = vi.fn((_owner, connections) => {
    active = connections;
  });
  const sync = createByokSync({ fetch, replace });
  sync.setOwner({ scope: 'membership-a:cn:1', organizationId: 'org-a' });
  return { sync, fetch, replace, active: () => active };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('enterprise BYOK sync', () => {
  it('fetches directory then batch credentials once and never exposes keys in status', async () => {
    const h = setup();
    h.fetch
      .mockResolvedValueOnce(directory([provider(), provider('byok-b')]))
      .mockResolvedValueOnce(credentials(['byok-a', 'byok-b']));
    const first = h.sync.sync();
    expect(h.sync.sync()).toBe(first);
    await first;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.active()).toHaveLength(2);
    expect(JSON.stringify(h.sync.getStatus())).not.toContain('invalid-test-key');
    expect(h.fetch.mock.calls.every(([, options]) => options.cache === 'no-store')).toBe(true);
  });

  it('retains valid routes on a network failure but removes them on a successful empty directory', async () => {
    const h = setup();
    h.fetch.mockResolvedValueOnce(directory()).mockResolvedValueOnce(credentials());
    await h.sync.sync();
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    await h.sync.sync();
    expect(h.active()).toHaveLength(1);
    expect(h.sync.getStatus().state).toBe('failed');
    h.fetch.mockResolvedValueOnce(directory([], '2'));
    await h.sync.sync();
    expect(h.active()).toEqual([]);
    expect(h.sync.getStatus().state).toBe('ready');
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('never combines a new connection revision with an old key', async () => {
    const h = setup();
    h.fetch.mockResolvedValueOnce(directory()).mockResolvedValueOnce(credentials());
    await h.sync.sync();
    h.fetch
      .mockResolvedValueOnce(directory([provider('byok-a', 2)], '2'))
      .mockResolvedValueOnce(credentials());
    await h.sync.sync();
    expect(h.active()).toEqual([]);
  });

  it('persists only the current directory revision during a refresh', async () => {
    const cache = { load: vi.fn(() => null), save: vi.fn() };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(directory())
      .mockResolvedValueOnce(credentials())
      .mockResolvedValueOnce(directory([provider()], '2'))
      .mockResolvedValueOnce(credentials());
    const sync = createByokSync({ fetch, replace: vi.fn(), cache });
    sync.setOwner({
      scope: 'membership-a:cn:1',
      cacheScope: 'membership-a:cn:org-a',
      organizationId: 'org-a',
    });
    await sync.sync();
    cache.save.mockClear();

    await sync.sync();

    expect(cache.save).toHaveBeenCalledTimes(2);
    expect(cache.save.mock.calls.map(([, catalog]) => catalog.revision)).toEqual(['2', '2']);
  });

  it('discards a late old-account response without blocking the new account', async () => {
    const h = setup();
    const late = deferred<unknown>();
    h.fetch.mockReturnValueOnce(late.promise);
    const old = h.sync.sync();
    await Promise.resolve();
    h.sync.setOwner({ scope: 'membership-b:cn:2', organizationId: 'org-a' });
    h.fetch.mockResolvedValueOnce(directory([], '2'));
    await h.sync.sync();
    late.resolve(directory());
    await old;
    expect(h.active()).toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('isolates pending/revoked providers and rejects cross-organization credentials', async () => {
    const h = setup();
    h.fetch
      .mockResolvedValueOnce(directory([provider(), provider('byok-b')]))
      .mockResolvedValueOnce({
        ...credentials(),
        credentials: [
          ...credentials().credentials,
          { providerId: 'byok-b', connectionRevision: 1, status: 'pending' },
        ],
      });
    await h.sync.sync();
    expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a']);
    expect(h.sync.getStatus().providers[1].state).toBe('pending');
    h.fetch
      .mockResolvedValueOnce(directory())
      .mockResolvedValueOnce({ ...credentials(), organizationId: 'org-b' });
    await h.sync.sync();
    expect(h.sync.getStatus().state).toBe('failed');
    expect(h.active()).toHaveLength(1);
  });

  it('refuses conflicting same-revision snapshots and never writes credentials to xd', async () => {
    const h = setup();
    h.fetch.mockResolvedValueOnce(directory()).mockResolvedValueOnce(credentials());
    await h.sync.sync();
    h.fetch.mockResolvedValueOnce(directory([provider('byok-b')]));
    await h.sync.sync();
    expect(h.sync.getStatus().state).toBe('failed');
    expect(h.active()[0].provider.id).toBe('byok-a');
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  describe('pending self-heal', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** 第一轮目录 + pending 凭据;之后每次凭据重读由 `next` 决定。 */
    function pendingHarness(next: () => unknown) {
      vi.useFakeTimers();
      const h = setup();
      h.fetch
        .mockResolvedValueOnce(directory([provider(), provider('byok-b')]))
        .mockResolvedValueOnce({
          ...credentials(['byok-a']),
          credentials: [
            credentials(['byok-a']).credentials[0],
            { providerId: 'byok-b', connectionRevision: 1, status: 'pending' },
          ],
        });
      h.fetch.mockImplementation(async (path: string) =>
        path === '/api/model-access/byok/providers?schemaVersion=1'
          ? directory([provider(), provider('byok-b')])
          : next(),
      );
      return h;
    }
    const readyBoth = () => credentials(['byok-a', 'byok-b']);

    it('retries the credentials endpoint only, and converges without a directory refetch', async () => {
      const h = pendingHarness(readyBoth);
      await h.sync.sync();
      // 间隔必须大于服务端 20 秒的签发宽限期,否则 recover 分支会白白空转一次。
      expect(PENDING_RETRY_DELAY_MS).toBeGreaterThan(20_000);
      expect(h.sync.getStatus().providers[1].state).toBe('pending');
      expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a']);
      const callsAfterFirstSync = h.fetch.mock.calls.length;

      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS);

      expect(h.sync.getStatus().providers[1].state).toBe('ready');
      expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a', 'byok-b']);
      // 目录此时已发布且未变,重试只允许再读凭据端点。
      const retryCalls = h.fetch.mock.calls.slice(callsAfterFirstSync);
      expect(retryCalls).toHaveLength(1);
      expect(retryCalls[0]![0]).toBe('/api/model-access/byok/credentials?schemaVersion=1');
    });

    it('stops after three attempts while the server keeps answering pending', async () => {
      const pendingOnly = () => ({
        ...credentials(['byok-a']),
        credentials: [
          credentials(['byok-a']).credentials[0],
          { providerId: 'byok-b', connectionRevision: 1, status: 'pending' },
        ],
      });
      const h = pendingHarness(pendingOnly);
      await h.sync.sync();
      const callsAfterFirstSync = h.fetch.mock.calls.length;

      // 远超 3 个重试间隔;有界重试不应演变成常驻轮询。
      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS * 10);

      // 字面量而非常量:上限是产品契约,常量漂移必须让这条用例失败。
      expect(PENDING_RETRY_LIMIT).toBe(3);
      expect(h.fetch.mock.calls.length - callsAfterFirstSync).toBe(3);
      expect(h.sync.getStatus().providers[1].state).toBe('pending');
    });

    it('schedules nothing when every provider is ready', async () => {
      vi.useFakeTimers();
      const h = setup();
      h.fetch.mockResolvedValueOnce(directory()).mockResolvedValueOnce(credentials());
      await h.sync.sync();
      const callsAfterFirstSync = h.fetch.mock.calls.length;

      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS * 4);

      expect(h.fetch.mock.calls.length).toBe(callsAfterFirstSync);
    });

    it('cancels the pending retry when the account changes', async () => {
      const h = pendingHarness(readyBoth);
      await h.sync.sync();
      const callsAfterFirstSync = h.fetch.mock.calls.length;

      h.sync.setOwner({ scope: 'membership-b:cn:2', organizationId: 'org-b' });
      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS * 4);

      // 旧世代的重试不得以新身份继续打网络。
      expect(h.fetch.mock.calls.length).toBe(callsAfterFirstSync);
    });

    it('keeps the pending overlay after a mid-retry fetch failure and still converges', async () => {
      let retries = 0;
      const h = pendingHarness(() => {
        retries += 1;
        if (retries === 1) throw new Error('BYOK_SYNC_TIMEOUT');
        return readyBoth();
      });
      await h.sync.sync();
      const callsAfterFirstSync = h.fetch.mock.calls.length;
      expect(h.sync.getStatus().providers[1].state).toBe('pending');
      expect(h.sync.getStatus().state).toBe('ready');

      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS);

      expect(h.fetch.mock.calls.length - callsAfterFirstSync).toBe(1);
      expect(h.sync.getStatus().providers[1].state).toBe('pending');
      expect(h.sync.getStatus().state).toBe('ready');
      expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a']);

      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS);

      expect(h.fetch.mock.calls.length - callsAfterFirstSync).toBe(2);
      expect(h.sync.getStatus().providers[1].state).toBe('ready');
      expect(h.sync.getStatus().state).toBe('ready');
      expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a', 'byok-b']);
    });

    it('counts fetch failures toward the retry budget without marking the provider unavailable', async () => {
      const h = pendingHarness(() => {
        throw new Error('offline');
      });
      await h.sync.sync();
      const callsAfterFirstSync = h.fetch.mock.calls.length;

      await vi.advanceTimersByTimeAsync(PENDING_RETRY_DELAY_MS * 10);

      expect(h.fetch.mock.calls.length - callsAfterFirstSync).toBe(3);
      expect(h.sync.getStatus().providers[1].state).toBe('pending');
      expect(h.sync.getStatus().state).toBe('ready');
      expect(h.active().map((entry) => entry.provider.id)).toEqual(['byok-a']);
    });
  });
});
