import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES, type ProviderShareOwned } from '@cindy/device-link';
import type { ProviderUsageHistoryView } from '../../../shared/providerShare';
import { parseProviderShareInsights } from '../../../shared/providerShareInsights';
import { createProviderShareInsightsReader } from '../providerShareInsights';

/* 测试价值：通过新只读 reader 验证四种能力组合、匿名投影、独立失败和撤权时序。
 * 依据：provider-sharing 的最小范围及账号隔离；旧 dispatch/management 测试没有新 reader。
 * 最小失败输入：一项查询失败、在途关闭后重开、同 providerId 换账号、转来的一行用量。
 * 缓存回归：PR #6482 P1；旧覆盖仅单供应商，补 A→B→A、过期和旧失败晚于新读取的时序。
 * 回包预算：#4316096976，旧覆盖未包含昵称/头像膨胀；用大名单加已有预算内账本触发最终帧超限。
 * 成员索引：#4316198438，扩展原投影用例验证不同成员及分享不会串账；复杂度另用诊断输入实测。
 * tier: unit；依赖注入，无 Electron/外网/真实等待。单文件耗时见执行报告。 */
const day = {
  day: '2026-10-19',
  kind: 'codex',
  model: 'model',
  providerId: 'private-provider',
  memberKey: 'private-device',
  turns: 1,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount: 1, currency: 'USD' as const },
};
function fixture() {
  const state = {
    owner: 'a',
    revision: 0,
    visibility: { quota: true, usage: true, revision: 0 },
    active: true,
  };
  const access = { shareId: 'share', memberId: 'member', providerId: 'provider' };
  const share: ProviderShareOwned = {
    shareId: 'share',
    providerId: 'provider',
    hostDeviceId: 'private-host',
    providerLabel: 'Provider',
    createdAt: '',
    requests: [],
    members: [
      {
        memberId: 'member',
        displayName: 'Alice',
        avatarUrl: null,
        region: 'global',
        status: 'active',
        joinedAt: '',
      },
    ],
  };
  const history: ProviderUsageHistoryView = {
    providerId: 'provider',
    todayKey: '2026-10-19',
    coverageStart: null,
    self: { lastUsedAt: 1, days: [day] },
    members: [
      { shareId: 'share', memberId: 'member', lastUsedAt: 2, days: [day] },
      { shareId: 'share', memberId: 'deleted', lastUsedAt: 3, days: [day] },
    ],
    relays: [
      { deviceId: 'private-device', deviceName: 'Secret Computer', lastUsedAt: 3, days: [day] },
      { deviceId: 'other-device', deviceName: 'Other Computer', lastUsedAt: 4, days: [day] },
    ],
  };
  const deps = {
    captureScope: () => {
      const owner = state.owner;
      return () => {
        if (owner !== state.owner) throw new Error('account changed');
      };
    },
    scopeKey: () => state.owner,
    access: () => (state.active ? access : null),
    revision: () => state.revision,
    visibility: () => ({ ...state.visibility }),
    shares: () => [share],
    owner: () => ({ displayName: 'Owner', avatarUrl: null }),
    history: vi.fn(async () => history),
    quota: vi.fn(async () => ({
      group: false,
      partial: false,
      accounts: [
        {
          state: 'ready' as const,
          updatedAt: 1,
          windows: [],
          balance: {
            remaining: 0,
            total: 100,
            currency: 'USD' as const,
            resetsAt: null,
            pools: [],
          },
        },
      ],
    })),
  };
  return { state, deps, history, read: createProviderShareInsightsReader(deps) };
}
const request = { version: 1, includeUsage: true };
describe('provider share insights', () => {
  afterEach(() => vi.restoreAllMocks());
  // Member policy remains visible while the owner keeps aggregate account usage private.
  it('projects only the authenticated member budget independently of quota visibility', async () => {
    const { state, deps } = fixture();
    state.visibility = { quota: false, usage: false, revision: 0 };
    const budget = vi.fn(async () => ({ state: 'recorded' as const, enabled: true, windowStart: '2026-10-22', windowEnd: '2026-10-28', nextWindowAt: 2000, totalTokens: 100, recommendedModel: 'terra',
      rules: [{ id: 'premium', models: ['provider-model'], tokens: 20, usedPercent: 20, limitPercent: 30, wouldBlock: false, blocked: false }] }));
    const read = createProviderShareInsightsReader({ ...deps, budget });
    const result = parseProviderShareInsights(await read('peer', { version: 1, includeUsage: false }));
    expect(budget).toHaveBeenCalledWith('provider', 'member');
    expect(result?.memberBudget?.rules[0].usedPercent).toBe(20);
    expect(result?.quota).toBeNull();
    expect(result?.usage).toBeNull();
    expect(deps.quota).not.toHaveBeenCalled();
    expect(deps.history).not.toHaveBeenCalled();
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('honors quota=%s usage=%s independently', async (quota, usage) => {
    const { state, deps, read } = fixture();
    state.visibility = { quota, usage, revision: 0 };
    const view = await read('peer', request);
    expect(view.capabilities).toEqual({ quota, usage });
    expect(view.quota !== null).toBe(quota);
    expect(view.usage !== null).toBe(usage);
    expect(deps.quota).toHaveBeenCalledTimes(Number(quota));
    expect(deps.history).toHaveBeenCalledTimes(Number(usage));
  });
  // 默认折叠曾读取全部历史；通过真实 reader 验证未请求不会读账本、投影或发送缓存。
  it('returns permissions and quota without touching usage until explicitly requested', async () => {
    const { read, deps } = fixture();
    const owner = vi.spyOn(deps, 'owner');
    const collapsed = { version: 1, includeUsage: false };
    const initial = await read('peer', collapsed);
    expect(initial).toMatchObject({
      capabilities: { usage: true },
      status: { usage: 'not-requested' },
      usage: null,
    });
    expect(initial.quota).not.toBeNull();
    expect(deps.history).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
    expect((await read('peer', request)).usage?.parties.length).toBe(3);
    expect(deps.history).toHaveBeenCalledTimes(1);
    owner.mockClear();
    expect(await read('peer', collapsed)).toMatchObject({
      status: { usage: 'not-requested' },
      usage: null,
    });
    expect(owner).not.toHaveBeenCalled();
    expect(deps.history).toHaveBeenCalledTimes(1);
    await expect(read('peer', { version: 1 })).rejects.toThrow('INVALID_PARAMS');
    await expect(read('peer', { version: 1, includeUsage: 'true' })).rejects.toThrow(
      'INVALID_PARAMS',
    );
  });
  it('includes relayed totals without topology, private notes, or deleted members', async () => {
    const { read, deps, history } = fixture();
    deps
      .shares()[0]
      .members.push({ ...deps.shares()[0].members[0], memberId: 'bob', displayName: 'Bob' });
    history.members.unshift({
      shareId: 'other-share',
      memberId: 'member',
      lastUsedAt: 3,
      days: [{ ...day, inputTokens: 999 }],
    });
    history.members.push({
      shareId: 'share',
      memberId: 'bob',
      lastUsedAt: 3,
      days: [{ ...day, inputTokens: 77 }],
    });
    const view = await read('peer', request);
    expect(
      view.usage?.parties.map((p) => [
        p.key === 'relay' ? 'relay' : p.displayName,
        p.days[0]?.inputTokens,
      ]),
    ).toEqual([
      ['Owner', 10],
      ['Alice', 10],
      ['Bob', 77],
      ['relay', 20],
    ]);
    expect(view.usage?.parties[1].isYou).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /private-|Secret Computer|Other Computer|deleted|memberId|deviceId|memberKey|providerId/,
    );
    expect(parseProviderShareInsights(view)).toEqual(view);
  });
  it.each(['quota', 'usage'] as const)('keeps the other capability when %s fails', async (key) => {
    const { deps, read } = fixture();
    if (key === 'quota') deps.quota.mockRejectedValue(new Error('upstream failed'));
    else deps.history.mockRejectedValue(new Error('ledger failed'));
    const view = await read('peer', request);
    expect(view.status[key]).toBe('unavailable');
    expect(view[key]).toBeNull();
    expect(view[key === 'quota' ? 'usage' : 'quota']).not.toBeNull();
  });
  it.each(['visibility', 'membership', 'owner'] as const)(
    'rejects in-flight results after %s changes',
    async (change) => {
      const { state, deps, read } = fixture();
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const history = await deps.history();
      deps.history.mockImplementation(async () => {
        await wait;
        return history;
      });
      const pending = read('peer', request);
      if (change === 'visibility') state.visibility.revision += 2;
      if (change === 'membership') state.revision += 2;
      if (change === 'owner') state.owner = 'b';
      finish();
      await expect(pending).rejects.toThrow();
    },
  );
  it('invalidates completed results after closing/reopening and never trusts foreign objects', async () => {
    const { read, state } = fixture();
    const view = await read('peer', request);
    expect(read.isCurrent('peer', view)).toBe(true);
    expect(read.isCurrent('other-peer', view)).toBe(false);
    expect(read.isCurrent('peer', { ...view })).toBe(false);
    state.visibility.revision += 2;
    expect(read.isCurrent('peer', view)).toBe(false);
  });
  it('shares cached history within an owner but reloads for another owner with the same provider id', async () => {
    const { read, deps, state } = fixture();
    await read('peer', request);
    await read('peer', request);
    expect(deps.history).toHaveBeenCalledTimes(1);
    state.owner = 'b';
    await read('peer', request);
    expect(deps.history).toHaveBeenCalledTimes(2);
  });
  it('retains each provider history and coalesces only that provider while reads are in flight', async () => {
    const { deps, history } = fixture();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const load = vi.fn(async (providerId: string) => {
      await wait;
      return { ...history, self: { ...history.self, days: [{ ...day, model: providerId }] } };
    });
    const read = createProviderShareInsightsReader({
      ...deps,
      access: (peer) => ({ ...deps.access()!, providerId: peer, shareId: peer }),
      shares: () => ['a', 'b'].map((id) => ({ ...deps.shares()[0], providerId: id, shareId: id })),
      history: load,
    });
    const pending = ['a', 'b', 'a', 'b'].map((peer) => read(peer, request));
    finish();
    const views = await Promise.all(pending);
    expect(views.map((view) => view.usage?.parties[0].days[0].model)).toEqual(['a', 'b', 'a', 'b']);
    await read('a', request);
    await read('b', request);
    expect(load.mock.calls).toEqual([['a'], ['b']]);
    // A failing retry must not remove B's still-current history.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);
    await read('b', request);
    load.mockRejectedValueOnce(new Error('ledger failed'));
    expect((await read('a', request)).status.usage).toBe('unavailable');
    await read('a', request);
    await read('b', request);
    expect(load.mock.calls).toEqual([['a'], ['b'], ['b'], ['a'], ['a']]);
  });
  it.each(['expiry', 'membership', 'visibility'] as const)(
    'reloads cached history after %s changes',
    async (change) => {
      const { read, deps, state } = fixture();
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      await read('peer', request);
      if (change === 'expiry') now.mockReturnValue(16_000);
      if (change === 'membership') state.revision += 1;
      if (change === 'visibility') state.visibility.revision += 2;
      await read('peer', request);
      await read('peer', request);
      expect(deps.history).toHaveBeenCalledTimes(2);
    },
  );
  it('does not let an expired in-flight failure evict its successful replacement', async () => {
    const { read, deps } = fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    let fail!: (error: Error) => void;
    deps.history.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const old = read('peer', request);
    now.mockReturnValue(16_000);
    expect((await read('peer', request)).status.usage).toBe('ready');
    fail(new Error('old failure'));
    expect((await old).status.usage).toBe('unavailable');
    expect((await read('peer', request)).status.usage).toBe('ready');
    expect(deps.history).toHaveBeenCalledTimes(2);
  });
  it('budgets final member metadata and quota together with newest usage rows', async () => {
    const { deps, history } = fixture();
    const share = deps.shares()[0];
    share.members = Array.from({ length: 1_200 }, (_, index) => ({
      ...share.members[0],
      memberId: String(index),
      displayName: '名字'.repeat(40),
      avatarUrl: 'https://example.com/' + 'a'.repeat(600),
    }));
    history.self.days = Array.from({ length: 750 }, (_, index) => ({
      ...day,
      day: index < 375 ? '2026-10-18' : '2026-10-19',
      model: '模型'.repeat(300) + index,
    }));
    history.members = [];
    history.relays = [];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
    const read = createProviderShareInsightsReader({ ...deps, shares: () => [share] });
    const result = await read('peer', request);
    const frame = {
      v: 1,
      kind: 'invoke-result',
      id: 'request',
      dst: 'peer',
      payload: { ok: true, result },
    };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_FRAME_BYTES);
    expect(result.status).toEqual({ quota: 'ready', usage: 'ready' });
    expect(result.usage?.parties).toHaveLength(1_201);
    const kept = result.usage!.parties[0].days;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(750);
    expect(kept.map((row) => row.model)).toEqual(
      [...history.self.days]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, kept.length)
        .map((row) => row.model),
    );
    expect(result.usage?.coverageStart).toBe(kept.at(-1)?.day);
    expect(parseProviderShareInsights(result)).toEqual(result);
    expect(read.isCurrent('peer', result)).toBe(true);
  });
  it('keeps quota available when member metadata alone exceeds the frame budget', async () => {
    const { deps } = fixture();
    const share = deps.shares()[0];
    share.members = Array.from({ length: 10_000 }, (_, index) => ({
      ...share.members[0],
      memberId: String(index),
      displayName: '名字'.repeat(40),
    }));
    const read = createProviderShareInsightsReader({ ...deps, shares: () => [share] });
    const result = await read('peer', request);
    expect(result.status).toEqual({ quota: 'ready', usage: 'unavailable' });
    expect(result.usage).toBeNull();
    expect(result.quota?.accounts[0].balance?.remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
  });
  it('keeps usage available when the quota projection alone exceeds the frame budget', async () => {
    const { deps } = fixture();
    const quota = await deps.quota();
    const read = createProviderShareInsightsReader({
      ...deps,
      quota: async () => ({
        ...quota,
        accounts: Array.from({ length: 512 }, () => ({
          ...quota.accounts[0],
          windows: Array.from({ length: 32 }, () => ({
            kind: 'scoped' as const,
            label: '窗口'.repeat(64),
            remainingPercent: 50,
            resetsAt: null,
            windowMinutes: null,
          })),
        })),
      }),
    });
    const result = await read('peer', request);
    expect(result.status).toEqual({ quota: 'unavailable', usage: 'ready' });
    expect(result.quota).toBeNull();
    expect(result.usage?.parties[0].days[0].inputTokens).toBe(10);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
  });
  it('rejects unauthorized members and a guest-supplied provider id', async () => {
    const { read, state } = fixture();
    await expect(read('peer', { ...request, providerId: 'other' })).rejects.toThrow(
      'INVALID_PARAMS',
    );
    state.active = false;
    await expect(read('peer', request)).rejects.toThrow('PERMISSION_DENIED');
  });
  // #4317443934：原边界只验证有限数，1e300 会让 Intl 日期格式化崩溃。
  // 通过真实 reader→接收解析入口覆盖四类时间字段；既有测试仅有正常毫秒值。tier: unit。
  it.each(['updatedAt', 'windowReset', 'balanceReset', 'lastUsedAt'] as const)(
    'rejects invalid Date values in %s before displaying a host response',
    async (field) => {
      const { read } = fixture();
      const view = await read('peer', request);
      const account = view.quota!.accounts[0];
      account.windows = [{
        kind: 'week', label: null, remainingPercent: 15, resetsAt: null, windowMinutes: null,
      }];
      const setTime = (value: number | null) => {
        if (field === 'updatedAt') account.updatedAt = value;
        else if (field === 'windowReset') account.windows[0].resetsAt = value;
        else if (field === 'balanceReset') account.balance!.resetsAt = value;
        else view.usage!.parties[0].lastUsedAt = value;
      };
      for (const invalid of [1e300, -1e300, 8_640_000_000_000_001, -8_640_000_000_000_001]) {
        setTime(invalid);
        expect(parseProviderShareInsights(view)).toBeNull();
      }
      for (const valid of [null, 0, 1_792_425_600_000, 8_640_000_000_000_000, -8_640_000_000_000_000]) {
        setTime(valid);
        expect(parseProviderShareInsights(view)).toEqual(view);
      }
    },
  );
  // #4317583971：任意字符串曾进入日期格式化；现有数值时间回归不覆盖日期键。tier: unit。
  it.each(['todayKey', 'coverageStart', 'day'] as const)(
    'requires a real calendar date for usage %s',
    async (field) => {
      const { read } = fixture();
      const view = await read('peer', request);
      const setDay = (value: string) => {
        if (field === 'day') view.usage!.parties[0].days[0].day = value;
        else view.usage![field] = value;
      };
      for (const invalid of ['2026-99-99', '2026-02-29', '2026-04-31', '', '2026-1-1']) {
        setDay(invalid);
        expect(parseProviderShareInsights(view)).toBeNull();
      }
      for (const valid of ['2024-02-29', '2026-10-19']) {
        setDay(valid);
        expect(parseProviderShareInsights(view)).toEqual(view);
      }
    },
  );
  it('strips unknown fields and ignores data for disabled capabilities on the receiving boundary', async () => {
    const { read } = fixture();
    const view = await read('peer', request);
    expect(parseProviderShareInsights({ ...view, version: 2 })).toBeNull();
    expect(parseProviderShareInsights({ version: 1, capabilities: view.capabilities })).toBeNull();
    // #4317520064：ready+null 曾让已展开明细永久加载，原覆盖没有状态/数据矛盾。
    for (const capability of ['quota', 'usage'] as const) {
      expect(parseProviderShareInsights({ ...view, [capability]: null })).toBeNull();
      // #4318099606：开启能力却标 disabled 同样会使展开明细永久加载。
      expect(parseProviderShareInsights({
        ...view,
        status: { ...view.status, [capability]: 'disabled' },
        [capability]: null,
      })).toBeNull();
    }
    const parsed = parseProviderShareInsights({
      ...view,
      secret: 'no',
      capabilities: { quota: false, usage: false },
    });
    expect(parsed).toMatchObject({
      quota: null,
      usage: null,
      status: { quota: 'disabled', usage: 'disabled' },
    });
    expect(parsed).not.toHaveProperty('secret');
  });
});
