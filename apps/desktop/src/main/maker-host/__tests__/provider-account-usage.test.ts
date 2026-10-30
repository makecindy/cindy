import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentKind, Provider } from '@cindy/model-providers';

import {
  invalidateKimiAccountUsage,
  setAccountUsageOAuthReader,
  readKimiCodingAccountUsage,
  isZhipuCodingPlanProvider,
  parseDeepSeekAccountUsage,
  parseZhipuCodingPlanQuota,
  readProviderAccountUsage,
  resetProviderAccountUsageForTest,
  resolveProviderAccountUsage,
  setAccountUsageFetch,
  setAccountUsageKeyReader,
  setAccountUsageNow,
  setAccountUsageOwnerStampReader,
  setAccountUsageProviderReader,
} from '../provider-account-usage.js';

function mkProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    source: 'user',
    agents: ['claude-code', 'codex', 'pi'],
    auth: { method: 'apiKey' },
    routing: {
      'claude-code': { upstream: 'https://api.deepseek.com/anthropic', authStrategy: 'api-key-header' as const },
      codex: { upstream: 'https://api.deepseek.com', authStrategy: 'api-key-header' as const },
      pi: { upstream: 'https://api.deepseek.com', authStrategy: 'api-key-header' as const },
    },
    models: {},
    ...overrides,
  } as Provider;
}

const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '194.06',
      granted_balance: '0.00',
      topped_up_balance: '194.06',
    },
  ],
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

let nowMs = 1_000_000;

describe('parseDeepSeekAccountUsage', () => {
  it('keeps all documented balance fields and currencies', () => {
    const snapshot = parseDeepSeekAccountUsage(
      {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
          { currency: 'USD', total_balance: '1.25', granted_balance: '0.25', topped_up_balance: '1.00' },
        ],
      },
      42,
    );
    expect(snapshot).toEqual({
      kind: 'deepseek-balance',
      isAvailable: true,
      fetchedAt: 42,
      balances: [
        { currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.00', toppedUpBalance: '10.34' },
        { currency: 'USD', totalBalance: '1.25', grantedBalance: '0.25', toppedUpBalance: '1.00' },
      ],
    });
  });

  it('rejects malformed payloads', () => {
    expect(() => parseDeepSeekAccountUsage({ is_available: true }, 1)).toThrow(/invalid/);
    expect(() =>
      parseDeepSeekAccountUsage({ is_available: true, balance_infos: [{}] }, 1),
    ).toThrow(/invalid/);
    expect(() =>
      parseDeepSeekAccountUsage(
        { is_available: 'yes', balance_infos: [] },
        1,
      ),
    ).toThrow(/invalid/);
    // 非十进制字符串（如科学计数 / 注入）不得进入展示层。
    expect(() =>
      parseDeepSeekAccountUsage(
        {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '1e3', granted_balance: '0', topped_up_balance: '0' }],
        },
        1,
      ),
    ).toThrow(/invalid/);
  });
});

const ZHIPU_QUOTA = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    limits: [
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000, percentage: 0, nextResetTime: 1793129464999 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: 1792786868808 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 2, percentage: 44, nextResetTime: 1793129464999 },
    ],
    level: 'pro',
  },
};

describe('parseZhipuCodingPlanQuota', () => {
  it('maps unit 3 to the 5-hour window and unit 6 to weekly, keeping level', () => {
    const snapshot = parseZhipuCodingPlanQuota(ZHIPU_QUOTA, 7);
    expect(snapshot).toEqual({
      kind: 'zhipu-coding-plan-quota',
      noPlan: false,
      level: 'pro',
      fiveHour: { usedPercent: 18, resetsAt: 1792786868808 },
      weekly: { usedPercent: 44, resetsAt: 1793129464999 },
      fetchedAt: 7,
    });
  });

  it('recognizes pay-as-you-go accounts (200 + business error mentioning coding plan)', () => {
    const snapshot = parseZhipuCodingPlanQuota(
      { code: 500, msg: '当前用户不存在coding plan', success: false },
      7,
    );
    expect(snapshot).toMatchObject({ kind: 'zhipu-coding-plan-quota', noPlan: true, level: null });
  });

  it('rejects unrelated business errors and malformed payloads', () => {
    expect(() => parseZhipuCodingPlanQuota({ success: false, msg: 'server busy' }, 1)).toThrow(/invalid/);
    expect(() => parseZhipuCodingPlanQuota({ success: true }, 1)).toThrow(/invalid/);
    expect(() => parseZhipuCodingPlanQuota(null, 1)).toThrow(/invalid/);
  });

  it('classifies unit-less limits by reset order (new plan variant), ignoring TIME_LIMIT', () => {
    // 新套餐 unit 缺失变体：两条 TOKENS_LIMIT，nextResetTime 较近的归 5 小时、
    // 较远的归周限；故意把周限放数组前面，验证不依赖输入顺序。
    const snapshot = parseZhipuCodingPlanQuota(
      {
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 53, nextResetTime: 2_000_000_000_000 },
            { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: 1_000_000_000_000 },
            { type: 'TIME_LIMIT', percentage: 7 },
          ],
          level: 'pro',
        },
      },
      7,
    );
    expect(snapshot.fiveHour).toEqual({ usedPercent: 44, resetsAt: 1_000_000_000_000 });
    expect(snapshot.weekly).toEqual({ usedPercent: 53, resetsAt: 2_000_000_000_000 });
  });

  it('falls back to five-hour for a single unit-less limit (old plan)', () => {
    const snapshot = parseZhipuCodingPlanQuota(
      {
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 2, nextResetTime: 1_774_967_594_803 },
            { type: 'TIME_LIMIT', percentage: 0 },
          ],
        },
      },
      7,
    );
    expect(snapshot.fiveHour).toEqual({ usedPercent: 2, resetsAt: 1_774_967_594_803 });
    expect(snapshot.weekly).toBeNull();
  });
});

describe('resolveProviderAccountUsage', () => {
  beforeEach(() => {
    resetProviderAccountUsageForTest();
  });

  it('claims official deepseek origin api-key providers with any runtime key', () => {
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((providerId, agent) =>
      providerId === 'deepseek' && agent === 'claude-code' ? 'sk-test' : null,
    );
    expect(resolveProviderAccountUsage('deepseek')).toMatchObject({
      integrationId: 'deepseek-balance-v1',
      endpoint: 'https://api.deepseek.com/user/balance',
      agent: 'claude-code',
      key: 'sk-test',
    });
  });

  it('falls through to a later runtime when the first has no key', () => {
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((_id, agent) => (agent === 'pi' ? 'sk-pi' : null));
    expect(resolveProviderAccountUsage('deepseek')?.agent).toBe('pi');
  });

  it('claims zhipu coding-plan routes with the monitor endpoint, not pay-as-you-go', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        id: 'glm-coding-plan',
        routing: {
          'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' as const },
          codex: { upstream: 'https://open.bigmodel.cn/api/coding/paas/v4', authStrategy: 'api-key-header' as const },
        },
      }),
    );
    setAccountUsageKeyReader(() => 'glm-key');
    expect(resolveProviderAccountUsage('glm-coding-plan')).toMatchObject({
      integrationId: 'zhipu-coding-plan-quota-v1',
      endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    });
    // 按量付费（/api/paas）同域不认领。
    setAccountUsageProviderReader(() =>
      mkProvider({
        id: 'zhipu-glm',
        routing: { codex: { upstream: 'https://open.bigmodel.cn/api/paas/v4', authStrategy: 'api-key-header' as const } },
      }),
    );
    expect(resolveProviderAccountUsage('zhipu-glm')).toBeNull();
  });

  it('routes the global coding plan to the z.ai monitor endpoint', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        id: 'zai-coding',
        routing: { pi: { upstream: 'https://api.z.ai/api/coding/paas/v4', authStrategy: 'api-key-header' as const } },
      }),
    );
    setAccountUsageKeyReader(() => 'zai-key');
    expect(resolveProviderAccountUsage('zai-coding')).toMatchObject({
      endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit',
    });
  });

  it('never claims proxied base URLs or oauth providers', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        routing: { 'claude-code': { upstream: 'https://proxy.example/v1', authStrategy: 'api-key-header' as const } },
      }),
    );
    setAccountUsageKeyReader(() => 'sk-test');
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();

    setAccountUsageProviderReader(() =>
      mkProvider({ auth: { method: 'oauth' as const } }),
    );
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();
  });

  it('rejects lookalike hosts (exact origin match only)', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        routing: { 'claude-code': { upstream: 'https://api.deepseek.com.evil.com/anthropic', authStrategy: 'api-key-header' as const } },
      }),
    );
    setAccountUsageKeyReader(() => 'sk-test');
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();
  });
});

describe('isZhipuCodingPlanProvider', () => {
  beforeEach(() => resetProviderAccountUsageForTest());

  it('detects coding-plan endpoints and the builtin preset id, not pay-as-you-go', () => {
    const coding = mkProvider({
      id: 'glm-coding-plan',
      routing: {
        'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' as const },
        codex: { upstream: 'https://open.bigmodel.cn/api/coding/paas/v4', authStrategy: 'api-key-header' as const },
      },
    });
    expect(isZhipuCodingPlanProvider(coding)).toBe(true);
    expect(isZhipuCodingPlanProvider(mkProvider({ id: 'zhipu-coding-plan-cn' }))).toBe(true);
    const payg = mkProvider({
      id: 'zhipu-glm',
      routing: { codex: { upstream: 'https://open.bigmodel.cn/api/paas/v4', authStrategy: 'api-key-header' as const } },
    });
    expect(isZhipuCodingPlanProvider(payg)).toBe(false);
    expect(isZhipuCodingPlanProvider(undefined)).toBe(false);
  });
});

describe('readProviderAccountUsage', () => {
  beforeEach(() => {
    resetProviderAccountUsageForTest();
    nowMs = 1_000_000;
    setAccountUsageNow(() => nowMs);
    setAccountUsageOwnerStampReader(() => ({ dataOwnerId: 'owner-a', generation: 1 }));
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader(() => 'sk-test');
  });

  afterEach(() => {
    resetProviderAccountUsageForTest();
    vi.restoreAllMocks();
  });

  it('returns unsupported when no official route exists', async () => {
    setAccountUsageProviderReader(() =>
      mkProvider({ routing: { 'claude-code': { upstream: 'https://proxy.example/v1', authStrategy: 'api-key-header' as const } } }),
    );
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toEqual({ status: 'unsupported' });
  });

  it('reports no-credentials when the official route exists without a key', async () => {
    setAccountUsageKeyReader(() => null);
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toEqual({ status: 'unavailable', error: 'no-credentials' });
  });

  it('fetches with bearer auth and returns a ready snapshot', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.deepseek.com/user/balance');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
      return jsonRes(DEEPSEEK_BALANCE);
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(result).toEqual({
      status: 'ready',
      stale: false,
      agent: 'claude-code',
      dashboardUrl: 'https://platform.deepseek.com/usage',
      snapshot: {
        kind: 'deepseek-balance',
        isAvailable: true,
        balances: [
          { currency: 'CNY', totalBalance: '194.06', grantedBalance: '0.00', toppedUpBalance: '194.06' },
        ],
        fetchedAt: nowMs,
      },
    });
  });

  it('pins the requested agent and never falls back to another engine key', async () => {
    setAccountUsageProviderReader(() => mkProvider());
    const seen: AgentKind[] = [];
    setAccountUsageKeyReader((_id, agent) => {
      seen.push(agent);
      return agent === 'codex' ? 'sk-codex' : null;
    });
    // Pi 会话指定 pi：即使 claude-code/codex 有密钥也不借用，查不到就是 no-credentials。
    const resolution = resolveProviderAccountUsage('deepseek', 'pi');
    expect(resolution).toBeNull();
    expect(seen).toEqual(['pi']);
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek', agent: 'pi' }),
    ).resolves.toEqual({ status: 'unavailable', error: 'no-credentials' });
  });

  // PR #7031: CN and Global share an integration id, not an account/cache namespace.
  // Unit: changing only the upstream must fetch the new endpoint, never return old quota.
  it('isolates CN and Global snapshots even when the stored key is unchanged', async () => {
    let upstream = 'https://open.bigmodel.cn/api/anthropic';
    setAccountUsageProviderReader(() => mkProvider({
      routing: { 'claude-code': { upstream, authStrategy: 'api-key-header' } },
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('api.z.ai')
        ? jsonRes({}, 401)
        : jsonRes(ZHIPU_QUOTA),
    );
    setAccountUsageFetch(fetchMock as typeof fetch);
    expect((await readProviderAccountUsage({ providerId: 'deepseek' })).status).toBe('ready');
    upstream = 'https://api.z.ai/api/anthropic';
    await expect(readProviderAccountUsage({ providerId: 'deepseek' })).resolves.toEqual({
      status: 'unavailable', error: 'auth',
      dashboardUrl: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit', expect.anything(),
    );
  });

  // PR #7031 review: a delayed failure must neither replace a concurrent success
  // nor discard its TTL/Retry-After state. Unit, promises control ordering without waits.
  it.each([false, true])('retains a concurrent fresh balance after a late failure (prior cache: %s)', async (seedCache) => {
    if (seedCache) {
      setAccountUsageFetch((async () => jsonRes(DEEPSEEK_BALANCE)) as typeof fetch);
      await readProviderAccountUsage({ providerId: 'deepseek' });
      nowMs += 6 * 60_000;
    }
    let finishLate!: (response: Response) => void;
    const updated = { ...DEEPSEEK_BALANCE, balance_infos: [{ ...DEEPSEEK_BALANCE.balance_infos[0], total_balance: '99.00' }] };
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishLate = resolve; }))
      .mockResolvedValueOnce(jsonRes(updated));
    setAccountUsageFetch(fetchMock as typeof fetch);
    const late = readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    const fresh = await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    finishLate(jsonRes({}, 503));
    await expect(late).resolves.toEqual(fresh);
    await expect(readProviderAccountUsage({ providerId: 'deepseek' })).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // PR #7031: failure settlement preserves the latest snapshot/TTL and the longest
  // active Retry-After, in either completion order. Unit; controlled promises, no I/O.
  it.each([
    { firstWait: 0, lateWait: 600 },
    { firstWait: 600, lateWait: 0 },
    { firstWait: 600, lateWait: 60 },
    { firstWait: 60, lateWait: 600 },
  ].flatMap(row => [false, true].map(seedCache => ({ ...row, seedCache }))))(
    'keeps the longer backoff after parallel failures ($firstWait / $lateWait, prior cache: $seedCache)',
    async ({ firstWait, lateWait, seedCache }) => {
      if (seedCache) {
        setAccountUsageFetch((async () => jsonRes(DEEPSEEK_BALANCE)) as typeof fetch);
        await readProviderAccountUsage({ providerId: 'deepseek' });
        nowMs += 6 * 60_000;
      }
      const failure = (wait: number) => wait
        ? jsonRes({}, 429, { 'retry-after': String(wait) })
        : jsonRes({}, 503);
      let finishLate!: (response: Response) => void;
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finishLate = resolve; }))
        .mockResolvedValueOnce(failure(firstWait));
      setAccountUsageFetch(fetchMock as typeof fetch);
      const late = readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
      await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
      finishLate(failure(lateWait));
      const result = await late;
      const retryAt = nowMs + Math.max(firstWait, lateWait) * 1000;
      expect(result).toMatchObject({ retryAt });
      if (seedCache) {
        expect(result).toMatchObject({ status: 'ready', stale: true, error: 'rate-limited', snapshot: { balances: [{ totalBalance: '194.06' }] } });
      } else {
        expect(result).toMatchObject({ status: 'unavailable', error: 'throttled' });
      }
      nowMs = retryAt - 1;
      for (const forceRefresh of [false, true]) {
        await expect(readProviderAccountUsage({ providerId: 'deepseek', forceRefresh })).resolves.toMatchObject({ retryAt });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves a parallel success and its TTL while applying a late Retry-After', async () => {
    let finishLate!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishLate = resolve; }))
      .mockResolvedValueOnce(jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as typeof fetch);
    const late = readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    const fresh = await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    finishLate(jsonRes({}, 429, { 'retry-after': '60' }));
    await expect(late).resolves.toMatchObject({ status: 'ready', stale: true, error: 'rate-limited', retryAt: nowMs + 60_000 });
    nowMs += 1_000;
    await expect(readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true })).resolves.toMatchObject({ stale: true, error: 'rate-limited' });
    nowMs += 60_000;
    await expect(readProviderAccountUsage({ providerId: 'deepseek' })).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([503, 429])('clears a parallel HTTP %s failure after a successful response', async (status) => {
    let finishSuccess!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishSuccess = resolve; }))
      .mockResolvedValueOnce(jsonRes({}, status, { 'retry-after': '600' }));
    setAccountUsageFetch(fetchMock as typeof fetch);
    const success = readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    finishSuccess(jsonRes(DEEPSEEK_BALANCE));
    const fresh = await success;
    expect(fresh).toMatchObject({ status: 'ready', stale: false });
    await expect(readProviderAccountUsage({ providerId: 'deepseek' })).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The settings page may use a later engine's key; metadata follows the endpoint
  // actually queried, including unavailable results, rather than the first route.
  it.each([200, 401])('returns the Global dashboard for the resolved engine (HTTP %s)', async (status) => {
    setAccountUsageProviderReader(() => mkProvider({ routing: {
      'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' },
      pi: { upstream: 'https://api.z.ai/api/coding/paas/v4', authStrategy: 'api-key-header' },
    } }));
    setAccountUsageKeyReader((_id, agent) => agent === 'pi' ? 'test-key' : null);
    setAccountUsageFetch((async () => jsonRes(ZHIPU_QUOTA, status)) as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(result).toMatchObject({ dashboardUrl: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan' });
  });

  it('treats a swapped key as a different account (cache key includes key fingerprint)', async () => {
    const fetchMock = vi.fn(async () => jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    setAccountUsageKeyReader(() => 'sk-other-account');
    await readProviderAccountUsage({ providerId: 'deepseek' });
    // 换 key = 换账户：不得命中旧账户缓存。
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves stale snapshot without network while inside the Retry-After window', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonRes(DEEPSEEK_BALANCE);
      return jsonRes({}, 429, { 'retry-after': '60' });
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(calls).toBe(1);
    nowMs += 6 * 60_000; // TTL 过期，触发第二次拉取 → 429 + Retry-After。
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(calls).toBe(2);
    // 429 失败后重置时间未到：不再发请求，回 stale 快照。
    const third = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(calls).toBe(2);
    expect(third).toMatchObject({ status: 'ready', stale: true, error: 'rate-limited' });
  });

  it('serves the cached snapshot inside the TTL and refetches after expiry', async () => {
    const fetchMock = vi.fn(async () => jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    nowMs += 6 * 60_000;
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps upstream failures to error codes and keeps stale snapshots', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonRes(DEEPSEEK_BALANCE);
      return jsonRes({ error: 'bad key' }, 401);
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const first = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(first.status).toBe('ready');
    nowMs += 6 * 60_000;
    const second = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(second).toMatchObject({ status: 'ready', stale: true, error: 'auth' });
    expect((second as { snapshot: { balances: unknown[] } }).snapshot.balances).toHaveLength(1);
  });

  it('rate-limited manual refresh reports throttled', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}, 429, { 'retry-after': '30' }));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    expect(result).toMatchObject({ status: 'unavailable', error: 'throttled' });
  });

  it('invalidates the cache when the owner stamp changes', async () => {
    const fetchMock = vi.fn(async () => jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    setAccountUsageOwnerStampReader(() => ({ dataOwnerId: 'owner-b', generation: 2 }));
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches zhipu quota with raw-key authorization', async () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        id: 'glm-coding-plan',
        routing: {
          'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' as const },
        },
      }),
    );
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
      // 智谱不加 Bearer 前缀。
      expect((init?.headers as Record<string, string>).Authorization).toBe('sk-test');
      return jsonRes(ZHIPU_QUOTA);
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'glm-coding-plan' });
    expect(result).toMatchObject({
      status: 'ready',
      snapshot: {
        kind: 'zhipu-coding-plan-quota',
        level: 'pro',
        fiveHour: { usedPercent: 18 },
        weekly: { usedPercent: 44 },
      },
    });
  });

  it('classifies invalid JSON as invalid-response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>gateway login</html>', { status: 200 }),
    );
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toMatchObject({ status: 'unavailable', error: 'invalid-response' });
  });
});

describe('provider runtime key order', () => {
  it('queries claude-code before codex before pi', async () => {
    resetProviderAccountUsageForTest();
    const seen: AgentKind[] = [];
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((_id, agent) => {
      seen.push(agent);
      return agent === 'codex' ? 'sk-codex' : null;
    });
    expect(resolveProviderAccountUsage('deepseek')?.agent).toBe('codex');
    expect(seen).toEqual(['claude-code', 'codex']);
  });
});

// Kimi subscription request: unit tier. Existing balance tests do not cover OAuth,
// optional rolling windows, or logout while a quota request is pending (#4287).
describe('Kimi Code subscription quota', () => {
  let current: Provider;
  let key: string | null;
  let owner: number;
  const payload = { usages: { limit_5h: { used_ratio: '0.23', reset_time: '2026-10-28T12:00:00Z' } } };
  const fetcher = vi.fn<typeof fetch>();
  beforeEach(() => {
    resetProviderAccountUsageForTest();
    nowMs = 1_000_000;
    owner = 1;
    key = 'synthetic-key';
    current = mkProvider({ id: 'kimi-custom', routing: { pi: { upstream: 'https://api.kimi.com/coding/v1', authStrategy: 'oauth-passthrough' } } } as Partial<Provider>);
    setAccountUsageProviderReader(() => current);
    setAccountUsageOwnerStampReader(() => ({ dataOwnerId: 'fixture', generation: owner }));
    setAccountUsageKeyReader(() => key);
    setAccountUsageNow(() => nowMs);
    fetcher.mockReset().mockResolvedValue(jsonRes(payload));
    setAccountUsageFetch(fetcher);
  });
  afterEach(resetProviderAccountUsageForTest);
  const read = (forceRefresh = false) => readKimiCodingAccountUsage({ providerId: 'kimi-custom', forceRefresh });

  // PR #7721: the dedicated remote/menu-bar reader must not return another
  // integration when a mixed provider's earlier runtime points to DeepSeek.
  it('pins implicit reads to Kimi and preserves explicit runtime selection', async () => {
    current.routing['claude-code'] = mkProvider().routing['claude-code'];
    const readKey = vi.fn((_id: string, agent: AgentKind) => agent === 'pi' ? key : 'synthetic-deepseek');
    setAccountUsageKeyReader(readKey);
    expect(await read()).toMatchObject({ status: 'ready', agent: 'pi', snapshot: { kind: 'kimi-coding-quota' } });
    expect(fetcher).toHaveBeenCalledWith('https://api.kimi.com/coding/v1/usages', expect.objectContaining({ headers: { Authorization: 'Bearer synthetic-key' } }));
    expect(readKey.mock.calls.every(([, agent]) => agent === 'pi')).toBe(true);
    expect(await readKimiCodingAccountUsage({ providerId: 'kimi-custom', agent: 'claude-code' })).toEqual({ status: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the official key endpoint, deduplicates concurrent views and caches only returned windows', async () => {
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'ready', stale: false, snapshot: { kind: 'kimi-coding-quota', windows: [{ id: 'limit_5h', usedPercent: 23, resetsAt: Date.parse('2026-10-28T12:00:00Z') }] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://api.kimi.com/coding/v1/usages', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-key' }) }));
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes OAuth through the host before reading its token, without using an API key', async () => {
    current.auth = { method: 'oauth', oauth: { tokenUrl: 'https://auth.kimi.com/api/oauth/token' } } as Provider['auth'];
    let refreshed = false;
    setAccountUsageOAuthReader(() => refreshed ? 'synthetic-oauth' : null, async () => { refreshed = true; });
    expect(await read()).toMatchObject({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic-oauth' }) }));
  });

  it.each(['https://proxy.example/coding/v1', 'https://api.kimi.com/v1', 'http://api.kimi.com/coding', 'https://api.kimi.com/coding/fake', 'https://api.kimi.com/coding?token=fixture'])('does not query credentials outside the product scope: %s', async upstream => {
    current.routing.pi!.upstream = upstream;
    expect(await read()).toEqual({ status: 'unsupported' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps missing, zero-use and fully-used windows distinct, without inventing totals or dates', async () => {
    fetcher.mockResolvedValueOnce(jsonRes({ usages: { limit_5h: null, limit_7d: { used_ratio: 0 }, limit_month_code: { used_ratio: 1.2, reset_time: 'bad' } } }));
    expect(await read()).toMatchObject({ snapshot: { windows: [{ id: 'limit_7d', usedPercent: 0, resetsAt: null }, { id: 'limit_month_code', usedPercent: 100, resetsAt: null }] } });
    nowMs += 300_001;
    fetcher.mockResolvedValueOnce(jsonRes({ usages: {} }));
    expect(await read()).toMatchObject({ snapshot: { windows: [] } });
  });

  it.each([null, { usages: [] }, { usages: { limit_5h: {} } }, { usages: { limit_5h: { used_ratio: -1 } } }, { usages: { limit_5h: { used_ratio: 'NaN' } } }])('rejects malformed responses without reporting exhaustion', async body => {
    fetcher.mockResolvedValueOnce(jsonRes(body));
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'invalid-response' });
  });

  it.each([401, 403])('revokes a cached quota on HTTP %s', async status => {
    await read();
    nowMs += 300_001;
    fetcher.mockResolvedValueOnce(jsonRes({}, status));
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'auth' });
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'auth' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([500, 503])('marks last known data stale on HTTP %s, instead of zero remaining', async status => {
    await read();
    nowMs += 300_001;
    fetcher.mockResolvedValueOnce(jsonRes({}, status));
    expect(await read()).toMatchObject({ status: 'ready', stale: true, error: 'server', snapshot: { windows: [{ usedPercent: 23 }] } });
  });

  it('throttles on Retry-After and resumes after the deadline', async () => {
    fetcher.mockResolvedValueOnce(jsonRes({}, 429, { 'retry-after': '120' }));
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'rate-limited' });
    nowMs += 20_000;
    expect(await read(true)).toMatchObject({ status: 'unavailable', error: 'throttled', retryAt: 1_120_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    nowMs += 100_001;
    expect(await read()).toMatchObject({ status: 'ready' });
  });

  it.each(['logout', 'owner', 'key'] as const)('discards a late result after %s and queries the next identity', async change => {
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = read();
    if (change === 'logout') invalidateKimiAccountUsage();
    if (change === 'owner') owner++;
    if (change === 'key') key = 'synthetic-second-key';
    release(jsonRes(payload));
    expect(await pending).toEqual({ status: 'unavailable', error: 'updating' });
    expect(await read()).toMatchObject({ status: 'ready' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a reported reset instead of retaining the five-minute cache', async () => {
    fetcher.mockResolvedValueOnce(jsonRes({ usages: { limit_5h: { used_ratio: 1, reset_time: new Date(nowMs + 20_000).toISOString() } } }));
    expect(await read()).toMatchObject({ snapshot: { windows: [{ usedPercent: 100 }] } });
    nowMs += 20_001;
    expect(await read()).toMatchObject({ snapshot: { windows: [{ usedPercent: 23 }] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transport timeout or oversized body as quota', async () => {
    fetcher.mockRejectedValueOnce(new DOMException('fixture', 'TimeoutError'));
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'network' });
    nowMs += 15_001;
    fetcher.mockResolvedValueOnce(new Response(' '.repeat(65_537)));
    expect(await read()).toMatchObject({ status: 'unavailable', error: 'invalid-response' });
  });
});
