import { describe, expect, it, vi } from 'vitest';

import type { CustomProviderConfig } from '@cindy/model-providers';

import {
  createProviderAccountUsageService,
  parseDeepSeekAccountUsage,
  parseOpenRouterKeyUsage,
} from '../provider-account-usage.js';

function config(
  integrationId: 'deepseek-balance-v1' | 'openrouter-key-usage-v1',
  baseUrl: string,
): CustomProviderConfig {
  return {
    id: 'provider',
    name: 'Provider',
    runtimes: {
      codex: {
        baseUrl,
        models: [{ id: 'model', name: 'Model' }],
        accountUsage: { integrationId },
      },
    },
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('provider account usage parsers', () => {
  it('keeps every DeepSeek currency and all documented balance fields', () => {
    expect(parseDeepSeekAccountUsage({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '12.340000000',
          granted_balance: '2.000000000',
          topped_up_balance: '10.340000000',
        },
        {
          currency: 'USD',
          total_balance: '1.25',
          granted_balance: '0.25',
          topped_up_balance: '1.00',
        },
      ],
    }, 123)).toEqual({
      kind: 'deepseek-balance',
      isAvailable: true,
      balances: [
        {
          currency: 'CNY',
          totalBalance: '12.340000000',
          grantedBalance: '2.000000000',
          toppedUpBalance: '10.340000000',
        },
        {
          currency: 'USD',
          totalBalance: '1.25',
          grantedBalance: '0.25',
          toppedUpBalance: '1.00',
        },
      ],
      fetchedAt: 123,
    });
  });

  it('keeps OpenRouter key limit semantics without inventing account balance', () => {
    expect(parseOpenRouterKeyUsage({
      data: {
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        usage: 5,
        usage_daily: 1,
        usage_weekly: 3,
        usage_monthly: 4,
      },
    }, 456)).toEqual({
      kind: 'openrouter-key-usage',
      limit: null,
      limitRemaining: null,
      limitReset: null,
      usage: 5,
      usageDaily: 1,
      usageWeekly: 3,
      usageMonthly: 4,
      fetchedAt: 456,
    });
  });

  it('fails closed on missing or malformed documented fields', () => {
    expect(() => parseDeepSeekAccountUsage({ is_available: true, balance_infos: [{}] }, 1))
      .toThrow(/invalid DeepSeek balance response/);
    expect(() => parseOpenRouterKeyUsage({ data: { usage: 1 } }, 1))
      .toThrow(/invalid OpenRouter key response/);
  });
});

describe('provider account usage service', () => {
  function harness(initialConfig: CustomProviderConfig) {
    const configs = new Map<string, CustomProviderConfig | null>([['provider', initialConfig]]);
    const keys = new Map<string, string | null>([['provider', 'secret-key']]);
    const routeGenerations = new Map<string, number>();
    const mutationsInProgress = new Set<string>();
    let configReadCount = 0;
    let failConfigReadsFrom = Number.POSITIVE_INFINITY;
    let owner = { dataOwnerId: 'owner-a' as string | null, generation: 1 };
    let ownerStampReadCount = 0;
    let scheduledOwnerSwitch: {
      afterRead: number;
      owner: typeof owner;
      key: string | null;
    } | null = null;
    let now = 10_000;
    const fetchImpl = vi.fn<typeof fetch>();
    const service = createProviderAccountUsageService({
      getConfig: async (providerId) => {
        configReadCount += 1;
        if (configReadCount >= failConfigReadsFrom) {
          throw new Error('local provider read failed with secret-key');
        }
        return configs.get(providerId) ?? null;
      },
      readKey: (providerId) => keys.get(providerId) ?? null,
      getOwnerStamp: () => {
        ownerStampReadCount += 1;
        const stamp = { ...owner };
        if (scheduledOwnerSwitch?.afterRead === ownerStampReadCount) {
          const next = scheduledOwnerSwitch;
          scheduledOwnerSwitch = null;
          queueMicrotask(() => {
            owner = next.owner;
            keys.set('provider', next.key);
          });
        }
        return stamp;
      },
      getDeviceId: () => 'device-a',
      getRouteMutationGeneration: (providerId) => routeGenerations.get(providerId) ?? 0,
      isRouteMutationInProgress: (providerId) => mutationsInProgress.has(providerId),
      fetchImpl,
      now: () => now,
    });
    return {
      service,
      fetchImpl,
      setConfig(value: CustomProviderConfig | null, providerId = 'provider') {
        configs.set(providerId, value);
      },
      failConfigReadsStartingAt(readNumber: number) { failConfigReadsFrom = readNumber; },
      setKey(value: string | null, providerId = 'provider') { keys.set(providerId, value); },
      setOwner(value: typeof owner) { owner = value; },
      switchOwnerAfterStampReads(reads: number, value: typeof owner, nextKey: string | null) {
        scheduledOwnerSwitch = {
          afterRead: ownerStampReadCount + reads,
          owner: value,
          key: nextKey,
        };
      },
      setRouteGeneration(value: number, providerId = 'provider') {
        routeGenerations.set(providerId, value);
      },
      setMutationInProgress(value: boolean, providerId = 'provider') {
        if (value) mutationsInProgress.add(providerId);
        else mutationsInProgress.delete(providerId);
      },
      advance(ms: number) { now += ms; },
    };
  }

  it('uses the fixed DeepSeek endpoint and sends no custom runtime headers', async () => {
    const h = harness(config('deepseek-balance-v1', 'https://api.deepseek.com/anthropic'));
    h.fetchImpl.mockResolvedValue(jsonResponse({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '2',
        granted_balance: '1',
        topped_up_balance: '1',
      }],
    }));

    const result = await h.service.read({ providerId: 'provider', agent: 'codex' });

    expect(result.status).toBe('ready');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/user/balance');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-key');
    expect([...new Headers(init?.headers).keys()].sort()).toEqual(['accept', 'authorization']);
  });

  it('does not infer integrations and rejects a marked runtime on another origin', async () => {
    const unmarked = config('deepseek-balance-v1', 'https://api.deepseek.com');
    delete unmarked.runtimes.codex!.accountUsage;
    const h = harness(unmarked);
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toEqual({ status: 'unsupported' });

    h.setConfig(config('deepseek-balance-v1', 'https://proxy.example/v1'));
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toEqual({ status: 'unsupported' });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('singleflights identical reads and serves the successful TTL cache', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    let release!: (value: Response) => void;
    h.fetchImpl.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const first = h.service.read({ providerId: 'provider', agent: 'codex' });
    const second = h.service.read({ providerId: 'provider', agent: 'codex' });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1));
    release(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));
    expect(await first).toEqual(await second);
    await h.service.read({ providerId: 'provider', agent: 'codex' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a cached snapshot after the data owner changes', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockImplementation(async () => jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));

    await h.service.read({ providerId: 'provider', agent: 'codex' });
    h.setOwner({ dataOwnerId: 'owner-b', generation: 2 });
    h.setKey('owner-b-key');
    await h.service.read({ providerId: 'provider', agent: 'codex' });
    h.setOwner({ dataOwnerId: 'owner-a', generation: 1 });
    h.setKey('secret-key');
    await h.service.read({ providerId: 'provider', agent: 'codex' });

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not return a cached snapshot when the owner switches after identity resolution', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockResolvedValue(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));
    await h.service.read({ providerId: 'provider', agent: 'codex' });
    h.switchOwnerAfterStampReads(
      2,
      { dataOwnerId: 'owner-b', generation: 2 },
      'owner-b-key',
    );

    await expect(h.service.read({ providerId: 'provider', agent: 'codex' }))
      .resolves.toEqual({ status: 'unavailable', error: 'superseded' });
  });

  it('does not cache or return a fetch when the owner switches after post-fetch validation', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockResolvedValue(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));
    h.switchOwnerAfterStampReads(
      6,
      { dataOwnerId: 'owner-b', generation: 2 },
      'owner-b-key',
    );

    await expect(h.service.read({ providerId: 'provider', agent: 'codex' }))
      .resolves.toEqual({ status: 'unavailable', error: 'superseded' });
  });

  it('evicts the oldest cached identity after 64 entries', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockImplementation(async () => jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));

    for (let index = 0; index < 65; index += 1) {
      h.setKey(`key-${index}`);
      await h.service.read({ providerId: 'provider', agent: 'codex' });
    }
    h.setKey('key-0');
    await h.service.read({ providerId: 'provider', agent: 'codex' });

    expect(h.fetchImpl).toHaveBeenCalledTimes(66);
  });

  it('keeps a prior snapshot stale after a rate limit and respects Retry-After', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockResolvedValueOnce(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));
    await h.service.read({ providerId: 'provider', agent: 'codex' });
    h.advance(20_000);
    h.fetchImpl.mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'retry-after': '120' },
    }));
    const stale = await h.service.read({
      providerId: 'provider',
      agent: 'codex',
      forceRefresh: true,
    });
    expect(stale).toMatchObject({ status: 'ready', stale: true, error: 'rate-limited' });
    await h.service.read({ providerId: 'provider', agent: 'codex', forceRefresh: true });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps exponential backoff when Retry-After is shorter', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockResolvedValue(new Response('', {
      status: 429,
      headers: { 'retry-after': '0' },
    }));

    await h.service.read({ providerId: 'provider', agent: 'codex', forceRefresh: true });
    h.advance(20_000);
    await h.service.read({ providerId: 'provider', agent: 'codex', forceRefresh: true });

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drops a late response when owner, key, config or route generation changes', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    let release!: (value: Response) => void;
    h.fetchImpl.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const pending = h.service.read({ providerId: 'provider', agent: 'codex' });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1));
    h.setOwner({ dataOwnerId: 'owner-b', generation: 2 });
    h.setKey('new-key');
    h.setRouteGeneration(2);
    release(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 9,
        limit_reset: 'monthly',
        usage: 1,
        usage_daily: 1,
        usage_weekly: 1,
        usage_monthly: 1,
      },
    }));
    expect(await pending).toEqual({ status: 'unavailable', error: 'superseded' });
  });

  it('keeps the cache and in-flight reads of a provider across an unrelated mutation', async () => {
    // 供应商 B 是另一个 providerId，有自己的配置/key/世代——它的 mutation 不得误伤 A。
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.setConfig(config('deepseek-balance-v1', 'https://api.deepseek.com'), 'provider-b');
    h.setKey('b-key', 'provider-b');
    let release!: (value: Response) => void;
    h.fetchImpl.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const pending = h.service.read({ providerId: 'provider', agent: 'codex' });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1));

    // B 的 mutation 进行中（in-progress + 世代推进）：A 的在途读取不得判 superseded。
    h.setMutationInProgress(true, 'provider-b');
    h.setRouteGeneration(1, 'provider-b');
    release(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 9,
        limit_reset: 'monthly',
        usage: 1,
        usage_daily: 1,
        usage_weekly: 1,
        usage_monthly: 1,
      },
    }));
    expect(await pending).toMatchObject({ status: 'ready', stale: false });

    // B 的 mutation 结束后，A 的五分钟缓存仍命中，不再请求上游。
    h.setMutationInProgress(false, 'provider-b');
    h.setRouteGeneration(2, 'provider-b');
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toMatchObject({ status: 'ready', stale: false });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached snapshot when only the runtime model list changes', async () => {
    const h = harness(config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1'));
    h.fetchImpl.mockResolvedValue(jsonResponse({
      data: {
        limit: 10,
        limit_remaining: 8,
        limit_reset: 'monthly',
        usage: 2,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 2,
      },
    }));
    await h.service.read({ providerId: 'provider', agent: 'codex' });

    // 模型清单编辑不影响账户查询端点，不得把已缓存的余额作废。
    const updated = config('openrouter-key-usage-v1', 'https://openrouter.ai/api/v1');
    updated.runtimes.codex!.models = [
      { id: 'model', name: 'Model' },
      { id: 'model-2', name: 'Model 2' },
    ];
    h.setConfig(updated);

    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toMatchObject({ status: 'ready', stale: false });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized bodies and reports credential/mutation states without fetching', async () => {
    const h = harness(config('deepseek-balance-v1', 'https://api.deepseek.com'));
    h.setKey(null);
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toEqual({ status: 'unavailable', error: 'no-credentials' });
    h.setKey('secret-key');
    h.setMutationInProgress(true);
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toEqual({ status: 'unavailable', error: 'updating' });
    h.setMutationInProgress(false);
    h.fetchImpl.mockResolvedValue(new Response('x'.repeat(65_537), { status: 200 }));
    expect(await h.service.read({ providerId: 'provider', agent: 'codex' }))
      .toMatchObject({ status: 'unavailable', error: 'invalid-response' });
  });

  it('fails closed without leaking local identity-resolution errors', async () => {
    const beforeFetch = harness(config('deepseek-balance-v1', 'https://api.deepseek.com'));
    beforeFetch.failConfigReadsStartingAt(1);
    await expect(beforeFetch.service.read({ providerId: 'provider', agent: 'codex' }))
      .resolves.toEqual({ status: 'unavailable', error: 'unknown' });
    expect(beforeFetch.fetchImpl).not.toHaveBeenCalled();

    const afterFetch = harness(config('deepseek-balance-v1', 'https://api.deepseek.com'));
    afterFetch.fetchImpl.mockResolvedValue(jsonResponse({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '2',
        granted_balance: '1',
        topped_up_balance: '1',
      }],
    }));
    afterFetch.failConfigReadsStartingAt(2);
    await expect(afterFetch.service.read({ providerId: 'provider', agent: 'codex' }))
      .resolves.toEqual({ status: 'unavailable', error: 'unknown' });
  });

  it('keeps the request timeout active while reading a slow response body', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(config('deepseek-balance-v1', 'https://api.deepseek.com'));
      let requestSignal: AbortSignal | undefined;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      h.fetchImpl.mockImplementation(async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            requestSignal?.addEventListener('abort', () => {
              controller.error(new Error('request aborted'));
            }, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      });

      const pending = h.service.read({ providerId: 'provider', agent: 'codex' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetchImpl).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      const timedOut = requestSignal?.aborted === true;
      if (!timedOut) bodyController?.error(new Error('test cleanup'));

      await expect(pending).resolves.toMatchObject({
        status: 'unavailable',
        error: 'network',
      });
      expect(timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
