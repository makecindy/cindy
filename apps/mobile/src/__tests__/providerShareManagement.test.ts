/**
 * 手机经同账号管理通道管理分享(provider-sharing.md §7.6)时的请求与回包解析。
 *
 * 测试价值
 * - 生产入口与可观察结果：`providerShareManagement.ts` 的读写函数(界面只经它们访问供应商所在电脑)与
 *   `providerShareManagementPresentation.ts` 的判定；断言发出的协议结构、解析出的申请/额度，以及错误归类。
 * - 规则依据：协议记录 provider-group-same-account-management.md(动作名、`includeUsage:false`、缺 `linkId` 按需要
 *   更新、`respondedAt` 换算有效期)；provider-sharing.md §4.1 第 4 步(配对码、Claude 邮箱告知)与 §3(逐级开启)。
 * - 现有覆盖缺口：这些协议此前只有 Desktop 控制端在用(`managementClient.test.ts`)，手机是新的调用方，解析独立实现。
 * - 最小失败输入：见各用例(时钟相差一小时的链接回包、配对码不是 4 位数字的申请、旧电脑的 CHANNEL_NOT_ALLOWED 等)。
 * - tier：unit(纯函数与注入的 invoke，无网络、无计时器)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';

import {
  ShareManagementError,
  classifyShareManagementError,
  createShareLink,
  decideShareRequest,
  parseCreatedShareLink,
  parseShareGroupView,
  parseShareQuotaAccounts,
  readOwnedShares,
  type ShareGroupMember,
  type ShareManagementInvoke,
} from '@/provider-share/providerShareManagement';
import {
  shareLinkGate,
  shareMemberStatus,
  shareableProviders,
  sharedProviderRows,
  sharesClaudeLoginEmail,
} from '@/provider-share/providerShareManagementPresentation';

const LINK_ID = 'a'.repeat(64);
const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1',
  displayName: 'Mallory',
  avatarUrl: 'https://cdn.example.invalid/a.png',
  region: 'global',
  pairingCode: '4821',
  linkId: LINK_ID,
  createdAt: '2026-11-24T08:00:00.000Z',
  expiresAt: '2026-11-25T08:00:00.000Z',
  ...overrides,
});
const owned = (requests: unknown[], members: unknown[] = []) => ({
  result: {
    ready: true,
    shares: [{ shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', createdAt: '2026-11-01T00:00:00.000Z', members, requests }],
  },
  respondedAt: 1,
});
const replying = (reply: unknown) => vi.fn(async () => reply) as unknown as ShareManagementInvoke & ReturnType<typeof vi.fn>;
const failing = (error: unknown) => vi.fn(async () => { throw error; }) as unknown as ShareManagementInvoke;
const codeOf = (promise: Promise<unknown>) => promise.then(
  () => 'resolved',
  (error: unknown) => (error instanceof ShareManagementError ? error.code : `unexpected: ${String(error)}`),
);

describe('reading shares from the provider computer', () => {
  it('asks for the snapshot without usage and keeps requests in arrival order', async () => {
    const invoke = replying(owned(
      [request({ requestId: 'late', createdAt: '2026-11-24T09:00:00.000Z' }), request({ avatarUrl: 'http://insecure.example.invalid/a.png' })],
      [{ memberId: 'm-1', displayName: 'Bob', avatarUrl: null, region: 'global', status: 'paused', joinedAt: '2026-11-02T00:00:00.000Z', note: 'QA', runningTasks: 2 }],
    ));
    const [share] = await readOwnedShares(invoke, 'host-1');
    // 协议：沿用 manage-share 的 owned，显式不要用量(手机不显示，不让那台电脑为此查历史)。
    expect(invoke).toHaveBeenCalledWith('host-1', 'provider-group:remote', [
      { action: 'manage-share', command: { action: 'owned', range: '7d', includeUsage: false } },
    ], undefined);
    expect(share.requests.map((entry) => entry.requestId)).toEqual(['req-1', 'late']);
    // 头像只接受 https：其余按没有头像显示首字。
    expect(share.requests[0]).toMatchObject({ pairingCode: '4821', linkId: LINK_ID, avatarUrl: null });
    expect(share.members).toEqual([{ memberId: 'm-1', displayName: 'Bob', avatarUrl: null, status: 'paused', note: 'QA', runningTasks: 2 }]);
  });

  it.each([
    ['a pairing code that is not four digits', owned([request({ pairingCode: '48a1' })]), 'failed'],
    ['a link id that is not a digest', owned([request({ linkId: 'short' })]), 'failed'],
    ['a reply without the response time', { result: { ready: true, shares: [] } }, 'failed'],
    ['a sharing service that is not ready yet', { result: { ready: false, shares: [] }, respondedAt: 1 }, 'not-ready'],
  ])('rejects the whole snapshot for %s', async (_case, reply, code) => {
    // 半份名单不能显示：审批依据的是申请人与配对码，解析不了就当作没读到。
    expect(await codeOf(readOwnedShares(replying(reply), 'host-1'))).toBe(code);
  });

  it.each([
    [Object.assign(new Error("channel 'provider-group:remote' not allowed"), { code: 'CHANNEL_NOT_ALLOWED' }), 'needs-update'],
    [new Error('[INVALID_PARAMS] Unknown command'), 'needs-update'],
    [new Error('[INVALID_PARAMS] unknown provider group action'), 'needs-update'],
    [new Error('[UNSUPPORTED_CAPABILITY] Remote share links require an update to the provider share server'), 'needs-update'],
    [new Error('[NOT_FOUND] The share request or member is no longer on this computer'), 'not-found'],
    [new Error('[UNAVAILABLE] provider groups are not ready yet'), 'not-ready'],
    [Object.assign(new Error('device offline'), { code: 'DEVICE_OFFLINE' }), 'offline'],
    [Object.assign(new Error('timed out'), { code: 'INVOKE_TIMEOUT' }), 'offline'],
    [new Error('[PRECONDITION_FAILED] The account changed during provider management'), 'failed'],
  ])('classifies %s', (error, code) => {
    expect(classifyShareManagementError(error)).toBe(code);
  });
});

describe('creating a share link', () => {
  it('converts the expiry to the phone clock when the two clocks disagree', () => {
    // 那台电脑的时钟快一小时：直接用它的绝对时间，手机会显示成 65 分钟后过期。
    const hostNow = Date.parse('2026-11-24T09:00:00.000Z');
    const phoneNow = Date.parse('2026-11-24T08:00:00.000Z');
    const created = parseCreatedShareLink({
      result: { link: 'https://cindy.example.invalid/share#secret', linkId: LINK_ID, expiresAt: new Date(hostNow + 295_000).toISOString() },
      respondedAt: hostNow,
    }, phoneNow);
    expect(created).toEqual({ link: 'https://cindy.example.invalid/share#secret', linkId: LINK_ID, expiresAtMs: phoneNow + 295_000 });
  });

  it.each([
    // 旧电脑或旧分享服务不返回链接标识：认不出哪条申请是这条链接带来的，提示更新，不退回按供应商关注。
    ['no link id', { link: 'https://cindy.example.invalid/share#secret', expiresAt: '2026-11-24T08:05:00.000Z' }, 'needs-update'],
    ['an empty link', { link: '', linkId: LINK_ID, expiresAt: '2026-11-24T08:05:00.000Z' }, 'failed'],
    ['an unreadable expiry', { link: 'https://cindy.example.invalid/share#secret', linkId: LINK_ID, expiresAt: 'soon' }, 'failed'],
  ])('reports %s', async (_case, result, code) => {
    expect(await codeOf(createShareLink(replying({ result, respondedAt: Date.now() }), 'host-1', 'anthropic'))).toBe(code);
  });
});

describe('deciding a request', () => {
  it('sends the decision once, fenced right before sending', async () => {
    const invoke = replying({ result: { ok: true }, respondedAt: 1 });
    const preSend = vi.fn();
    await decideShareRequest(invoke, 'host-1', 'req-1', 'approve', preSend);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('host-1', 'provider-group:remote', [
      { action: 'manage-share', command: { action: 'approve', requestId: 'req-1' } },
    ], { preSend });
  });

  it('does not report success for a reply that is not an acknowledgement', async () => {
    expect(await codeOf(decideShareRequest(replying({ result: null, respondedAt: 1 }), 'host-1', 'req-1', 'reject'))).toBe('failed');
    expect(await codeOf(decideShareRequest(failing(new Error('[NOT_FOUND] gone')), 'host-1', 'req-1', 'reject'))).toBe('not-found');
  });
});

describe('group view and quota', () => {
  const status = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
    key, kind, label: `computer ${key}`, state: 'available', running: 0, limit: 4, weight: 1, paused: false, ...extra,
  });
  const member = (key: string, kind: string, agentDeviceId: string | null, providerId: string) => ({
    key, kind, agentDeviceId, providerId, limit: 4, weight: 1, paused: false,
  });

  it('reads each computer quota from where its account lives', () => {
    const view = parseShareGroupView({
      providerId: 'anthropic',
      config: {
        strategy: 'least',
        autoSwitch: true,
        members: [
          member('local', 'local', null, 'anthropic'),
          member('device:macbook:anthropic-2', 'device', 'macbook', 'anthropic-2'),
          member('share:s9:anthropic', 'share', 'share:s9', 'anthropic'),
        ],
      },
      members: [
        status('local', 'local', { state: 'full', running: 6 }),
        status('device:macbook:anthropic-2', 'device', { state: 'cooling', usageLimit: { resetAtMs: 9_000 } }),
        status('share:s9:anthropic', 'share', { ownerName: 'Taylor' }),
        status('device:removed:x', 'device'),
      ],
    }, 'studio');
    expect(view?.grouped).toBe(true);
    // 组所在电脑那一台读组所在电脑；其他电脑读各自；别人分享来的电脑不经手机读额度；刚移出组的不列。
    expect(view?.members.map((entry) => [entry.key, entry.quotaTarget])).toEqual([
      ['local', { deviceId: 'studio', providerId: 'anthropic' }],
      ['device:macbook:anthropic-2', { deviceId: 'macbook', providerId: 'anthropic-2' }],
      ['share:s9:anthropic', null],
    ]);
    expect(view?.members[1]).toMatchObject({ quotaExhausted: true, quotaResetAtMs: 9_000 });
  });

  it.each([
    ['a provider without a group', { providerId: 'anthropic', config: null, members: [] }, { grouped: false, members: [] }],
    ['a state this version does not know', {
      providerId: 'anthropic',
      config: { members: [member('local', 'local', null, 'anthropic')] },
      members: [status('local', 'local', { state: 'hibernating' })],
    }, null],
  ])('handles %s', (_case, raw, expected) => {
    expect(parseShareGroupView(raw, 'studio')).toEqual(expected);
  });

  it('lists every pooled account, or the single account an older computer returns', () => {
    const account = (remainingPercent: number) => ({
      state: 'ready', updatedAt: 1, balance: null,
      windows: [{ kind: 'week', label: null, remainingPercent, resetsAt: 5_000, windowMinutes: 10_080 }],
    });
    expect(parseShareQuotaAccounts({ ...account(40), accounts: [account(40), account(140)] })?.map((entry) => entry.windows[0].remainingPercent))
      .toEqual([40, 100]);
    expect(parseShareQuotaAccounts(account(12))).toHaveLength(1);
    // 没有读数的状态保留状态，不当成零额度。
    expect(parseShareQuotaAccounts({ state: 'offline', updatedAt: null, windows: [], balance: null }))
      .toEqual([{ state: 'offline', windows: [], balance: null }]);
    expect(parseShareQuotaAccounts({ state: 'plenty', windows: [] })).toBeNull();
  });
});

describe('what the phone lists and allows', () => {
  const provider = (overrides: Partial<ProviderView> = {}) => ({
    id: 'anthropic', name: 'Anthropic', source: 'builtin', connected: true, remoteInvocationEnabled: true,
    auth: { method: 'oauth' }, ...overrides,
  }) as unknown as ProviderView;
  const share = (providerId: string, members: number, requests: number) => ({
    shareId: `share-${providerId}`, providerId, providerLabel: providerId,
    members: Array.from({ length: members }, (_, index) => ({
      memberId: `m-${index}`, displayName: 'Bob', avatarUrl: null, status: 'active' as const, note: null, runningTasks: 0,
    })),
    requests: Array.from({ length: requests }, (_, index) => ({
      requestId: `r-${index}`, linkId: null, displayName: 'Eve', avatarUrl: null, pairingCode: '0000', createdAtMs: index,
    })),
  });

  it('lists shares that have people or pending requests, pending first, and leaves plugin providers to the computer', () => {
    expect(sharedProviderRows([
      share('openai', 2, 0),
      share('link-only', 0, 0),
      share('acp-plugin:demo:engine', 3, 1),
      share('anthropic', 0, 1),
    ]).map((entry) => entry.providerId)).toEqual(['anthropic', 'openai']);
  });

  it.each([
    [{ catalogReady: false, provider: provider() }, 'checking'],
    [{ catalogReady: true, provider: undefined }, 'missing'],
    [{ catalogReady: true, provider: provider({ connected: false }) }, 'disconnected'],
    [{ catalogReady: true, provider: provider({ suspended: true }) }, 'disconnected'],
    [{ catalogReady: true, provider: provider({ remoteInvocationEnabled: false }) }, 'invocation-off'],
    [{ catalogReady: true, provider: provider() }, 'ready'],
  ])('gates link creation %#', (input, gate) => {
    expect(shareLinkGate(input)).toBe(gate);
  });

  it('offers only providers that can be shared right now', () => {
    expect(shareableProviders([
      provider(),
      provider({ id: 'openai', remoteInvocationEnabled: false }),
      provider({ id: 'acp-plugin:demo:engine' }),
      provider({ id: 'legacy', subscriptionPoolAlias: true }),
    ]).map((entry) => entry.id)).toEqual(['anthropic']);
  });

  it('warns about the Claude sign-in email only for Claude subscription logins', () => {
    expect(sharesClaudeLoginEmail(provider())).toBe(true);
    // 另建的 Claude 订阅连接(id 不是内置的 anthropic)同样会把登录邮箱交给模型。
    expect(sharesClaudeLoginEmail(provider({ id: 'claude-second', auth: { method: 'oauth', native: 'claude' } } as unknown as Partial<ProviderView>))).toBe(true);
    expect(sharesClaudeLoginEmail(provider({ id: 'openai' }))).toBe(false);
    expect(sharesClaudeLoginEmail(provider({ auth: { method: 'apiKey' } } as unknown as Partial<ProviderView>))).toBe(false);
    expect(sharesClaudeLoginEmail(undefined)).toBe(false);
  });

  it.each([
    [{ state: 'available', running: 0 }, { key: 'status.idle', tone: 'ready' }],
    [{ state: 'available', running: 3 }, { key: 'runningCount', count: 3, tone: 'busy' }],
    [{ state: 'cooling', quotaExhausted: false }, { key: 'status.cooling', tone: 'muted' }],
    [{ state: 'cooling', quotaExhausted: true, quotaResetAtMs: 5_000 }, { key: 'status.quotaExhausted', resetAtMs: 5_000, tone: 'muted' }],
    // 重置时刻已过而状态还没刷新：只说已用完，不显示过去的时刻。
    [{ state: 'cooling', quotaExhausted: true, quotaResetAtMs: 500 }, { key: 'status.quotaExhausted', tone: 'muted' }],
    [{ state: 'unavailable', reason: 'provider-off' }, { key: 'status.unavailable.provider-off', tone: 'off' }],
  ])('words a computer status %#', (overrides, expected) => {
    const base: ShareGroupMember = {
      key: 'local', kind: 'local', label: 'studio', providerName: null, ownerName: null, state: 'available', reason: null,
      running: 0, coolingUntilMs: null, quotaExhausted: false, quotaResetAtMs: null, quotaTarget: null,
    };
    expect(shareMemberStatus({ ...base, ...overrides } as ShareGroupMember, 1_000)).toEqual(expected);
  });
});
