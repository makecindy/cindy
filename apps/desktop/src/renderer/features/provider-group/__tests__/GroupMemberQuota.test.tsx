// @vitest-environment jsdom
/**
 * 供应商组里展开一台电脑看它账号的剩余额度(provider-groups.md §10，2026-10-10 用户要求)：
 *   - 本机读本机账号；我的其他电脑按那台目录里的供应商读那台的账号；
 *   - 别人分享来的电脑、不在线的电脑不去读，直接说明；
 *   - 不是订阅类的供应商说明没有额度；一直读不到时不永远停在「正在读取」。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  local: [] as unknown[],
  byDevice: {} as Record<string, unknown[]>,
  deviceReads: [] as Array<string | undefined>,
  cardReads: [] as Array<[string | undefined, string | null]>,
  cards: {} as Record<string, { title: string }>,
}));

vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: mocks.local }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: (deviceId?: string) => {
    mocks.deviceReads.push(deviceId);
    return { providers: deviceId ? (mocks.byDevice[deviceId] ?? []) : [], loading: false, error: null, unsupported: false };
  },
}));
vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({
  useDeviceProviderSubscriptionCard: (provider: { id: string } | undefined, deviceId: string | null) => {
    mocks.cardReads.push([provider?.id, deviceId]);
    return provider ? (mocks.cards[`${deviceId ?? 'local'}:${provider.id}`] ?? null) : null;
  },
}));
vi.mock('@/components/status/QuotaHoverCard', () => ({
  QuotaHoverCard: ({ account, hideIdentity }: { account: { title: string }; hideIdentity?: boolean }) => (
    <div data-testid="quota-card" data-hide-identity={String(Boolean(hideIdentity))}>
      {account.title}
    </div>
  ),
}));

import { GroupMemberQuota, groupMemberQuotaTarget, type GroupMemberQuotaTarget } from '../GroupMemberQuota';

const claude = (id: string) => ({ id, name: 'Anthropic', source: 'builtin', connected: true, auth: { method: 'oauth', native: 'claude' } });
const apiKey = (id: string) => ({ id, name: 'OpenRouter', source: 'user', connected: true, auth: { method: 'api-key' } });

function show(target: GroupMemberQuotaTarget, offline = false) {
  render(<GroupMemberQuota id="quota" target={target} offline={offline} />);
}

beforeEach(() => {
  mocks.local = [claude('anthropic')];
  mocks.byDevice = { mini: [claude('anthropic-1a2b')], pc: [apiKey('openrouter')] };
  mocks.deviceReads.length = 0;
  mocks.cardReads.length = 0;
  mocks.cards = { 'local:anthropic': { title: 'This computer’s Claude' }, 'mini:anthropic-1a2b': { title: 'Mini’s Claude' } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GroupMemberQuota', () => {
  it('reads this computer’s account for this computer', () => {
    show({ kind: 'local', providerId: 'anthropic' });
    expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
    // 行本身已说明是哪台电脑：卡片不再出标题行。
    expect(screen.getByTestId('quota-card').getAttribute('data-hide-identity')).toBe('true');
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  it('reads my other computer’s own account through its directory', () => {
    show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.cardReads.at(-1)).toEqual(['anthropic-1a2b', 'mini']);
  });

  it('does not read a computer shared by someone else', () => {
    show({ kind: 'share' });
    expect(screen.getByText('providerGroup.member.quota.share')).toBeTruthy();
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
    expect(mocks.cardReads.every(([providerId]) => providerId === undefined)).toBe(true);
  });

  it('does not read an offline computer', () => {
    show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }, true);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  it('says a provider without a subscription quota has none', () => {
    show({ kind: 'device', deviceId: 'pc', providerId: 'openrouter' });
    expect(screen.getByText('providerGroup.member.quota.none')).toBeTruthy();
  });

  it('stops saying it is reading when the quota never arrives', () => {
    vi.useFakeTimers();
    mocks.cards = {};
    show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByText('providerGroup.member.quota.loading')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText('providerGroup.member.quota.unavailable')).toBeTruthy();
  });
});

describe('groupMemberQuotaTarget', () => {
  const member = (kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId = 'p') => ({ kind, agentDeviceId, providerId });

  it('reads the group computer for its own entry and this computer for itself', () => {
    // 本机的组。
    expect(groupMemberQuotaTarget(member('local', null), null, 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'mini'), null, 'self')).toEqual({ kind: 'device', deviceId: 'mini', providerId: 'p' });
    // 另一台电脑(studio)上的组：组所在电脑自己读 studio，组员就是本机时读本机。
    expect(groupMemberQuotaTarget(member('local', null), 'studio', 'self')).toEqual({ kind: 'device', deviceId: 'studio', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'self'), 'studio', 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('share', 'share:s1'), 'studio', 'self')).toEqual({ kind: 'share' });
  });
});
