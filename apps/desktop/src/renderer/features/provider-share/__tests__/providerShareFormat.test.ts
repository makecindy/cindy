import { describe, expect, it } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';

import type { ProviderShareModelUsageView, ProviderShareOwnedView } from '../../../../shared/providerShare';
import {
  diffReceivedShares,
  formatShareCountdown,
  formatShareMoney,
  formatShareTokens,
  pendingRequestCountByProvider,
  pendingRequestsFromOwned,
  providerShareAgentDeviceId,
  providerShareGate,
  providerShareJoinErrorKind,
  shareAvatarInitial,
  shareLinkRemainingMs,
  summarizeShareUsage,
} from '../providerShareFormat';
import { PROVIDER_SHARE_MANAGE_PARAM, providerShareManagePath } from '../providerShareNavigation';

function usage(partial: Partial<ProviderShareModelUsageView>): ProviderShareModelUsageView {
  return {
    kind: 'claude-code',
    providerId: 'xd',
    model: 'claude-opus-5-5',
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    amount: null,
    ...partial,
  };
}

function received(partial: Partial<ProviderShareReceived>): ProviderShareReceived {
  return {
    shareId: 's1',
    memberId: 'm1',
    providerId: 'xd',
    providerLabel: 'Cindy AI',
    hostDeviceId: 'host-1',
    deviceName: "Magi's Mac Mini",
    owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
    status: 'active',
    hostOnline: true,
    hostCapable: true,
    ...partial,
  };
}

describe('providerShareFormat', () => {
  it('gates sharing step by step: remote control → remote use → share', () => {
    expect(providerShareGate({ remoteControlEnabled: false, invocationEnabled: true })).toBe('remote-off');
    expect(providerShareGate({ remoteControlEnabled: false, invocationEnabled: false })).toBe('remote-off');
    expect(providerShareGate({ remoteControlEnabled: true, invocationEnabled: false })).toBe('invocation-off');
    expect(providerShareGate({ remoteControlEnabled: true, invocationEnabled: true })).toBe('on');
    // 远程控制状态还没读到时不提示「未开启」。
    expect(providerShareGate({ remoteControlEnabled: null, invocationEnabled: true })).toBe('on');
    expect(providerShareGate({ remoteControlEnabled: null, invocationEnabled: false })).toBe('invocation-off');
  });

  it('formats the link countdown as m:ss without showing 0:00 early', () => {
    expect(formatShareCountdown(300_000)).toBe('5:00');
    expect(formatShareCountdown(299_001)).toBe('5:00');
    expect(formatShareCountdown(65_000)).toBe('1:05');
    expect(formatShareCountdown(500)).toBe('0:01');
    expect(formatShareCountdown(0)).toBe('0:00');
    expect(formatShareCountdown(-5_000)).toBe('0:00');
  });

  it('computes remaining link time and treats unparsable times as expired', () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    expect(shareLinkRemainingMs('2026-10-07T10:05:00Z', now)).toBe(300_000);
    expect(shareLinkRemainingMs('2026-10-07T09:59:00Z', now)).toBe(0);
    expect(shareLinkRemainingMs('not a time', now)).toBe(0);
  });

  it('sums input + output tokens and same-currency amounts', () => {
    const totals = summarizeShareUsage([
      usage({ inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 9_999, amount: { amount: 1.25, currency: 'USD' } }),
      usage({ inputTokens: 2_000, outputTokens: 0, amount: null }),
      usage({ inputTokens: 0, outputTokens: 100, amount: { amount: 0.75, currency: 'USD' } }),
    ]);
    expect(totals.tokens).toBe(3_600);
    expect(totals.amount).toEqual({ amount: 2, currency: 'USD' });
  });

  it('does not invent a total across currencies', () => {
    const totals = summarizeShareUsage([
      usage({ amount: { amount: 1, currency: 'USD' } }),
      usage({ amount: { amount: 7, currency: 'CNY' } }),
    ]);
    expect(totals.amount).toBeNull();
    expect(summarizeShareUsage([]).amount).toBeNull();
  });

  it('formats tokens compactly and money with two decimals', () => {
    expect(formatShareTokens(1_310_000)).toMatch(/m$/i);
    expect(formatShareTokens(412_000)).toMatch(/k$/i);
    expect(formatShareTokens(-3)).toBe('0');
    expect(formatShareMoney({ amount: 31.2, currency: 'USD' })).toBe('$31.20');
    expect(formatShareMoney({ amount: 4.7, currency: 'CNY' })).toBe('¥4.70');
  });

  it('derives an avatar initial from the nickname', () => {
    expect(shareAvatarInitial('magi')).toBe('M');
    expect(shareAvatarInitial('  王一 ')).toBe('王');
    expect(shareAvatarInitial('')).toBe('?');
  });

  it('maps join errors to dialog states', () => {
    expect(providerShareJoinErrorKind('PROVIDER_SHARE_LINK_USED')).toBe('used');
    expect(providerShareJoinErrorKind('PROVIDER_SHARE_LINK_EXPIRED')).toBe('used');
    expect(providerShareJoinErrorKind('NOT_FOUND')).toBe('used');
    expect(providerShareJoinErrorKind('PROVIDER_SHARE_SELF')).toBe('self');
    expect(providerShareJoinErrorKind('PROVIDER_SHARE_ALREADY_MEMBER')).toBe('member');
    expect(providerShareJoinErrorKind('REGION_MISMATCH')).toBe('region');
    expect(providerShareJoinErrorKind('PROVIDER_SHARE_CROSS_REGION_DISABLED')).toBe('region');
    expect(providerShareJoinErrorKind('INVALID_PARAMS')).toBe('invalid');
    expect(providerShareJoinErrorKind('DEVICE_LINK_NOT_CONNECTED')).toBe('error');
    expect(providerShareJoinErrorKind(undefined)).toBe('error');
  });

  it('lists pending requests oldest first and counts them per provider', () => {
    const shares: ProviderShareOwnedView[] = [
      {
        shareId: 's1',
        providerId: 'xd',
        providerLabel: 'Cindy AI',
        createdAt: '2026-10-01T00:00:00Z',
        members: [],
        requests: [
          { requestId: 'r2', displayName: 'B', avatarUrl: null, region: 'global', pairingCode: '2222', createdAt: '2026-10-07T10:05:00Z', expiresAt: '2026-10-08T10:05:00Z' },
          { requestId: 'r1', displayName: 'A', avatarUrl: null, region: 'global', pairingCode: '1111', createdAt: '2026-10-07T10:00:00Z', expiresAt: '2026-10-08T10:00:00Z' },
        ],
      },
      {
        shareId: 's2',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        createdAt: '2026-10-01T00:00:00Z',
        members: [],
        requests: [
          { requestId: 'r3', displayName: 'C', avatarUrl: null, region: 'cn', pairingCode: '3333', createdAt: '2026-10-07T10:02:00Z', expiresAt: '2026-10-08T10:02:00Z' },
        ],
      },
    ];
    const pending = pendingRequestsFromOwned(shares);
    expect(pending.map((item) => item.request.requestId)).toEqual(['r1', 'r3', 'r2']);
    expect(pending[1].share).toEqual({ shareId: 's2', providerId: 'openai', providerLabel: 'OpenAI' });
    const counts = pendingRequestCountByProvider(pending.map((item) => item.share));
    expect(counts.get('xd')).toBe(2);
    expect(counts.get('openai')).toBe(1);
  });

  it('reports shares whose availability changed or that disappeared', () => {
    const before = [received({ shareId: 'a' }), received({ shareId: 'b' }), received({ shareId: 'c' })];
    const after = [
      received({ shareId: 'a' }),
      received({ shareId: 'b', status: 'paused' }),
      received({ shareId: 'd' }),
    ];
    expect(diffReceivedShares(before, after)).toEqual({ changed: ['b'], removed: ['c'] });
    expect(diffReceivedShares(after, [received({ shareId: 'b', status: 'paused', hostOnline: false })])).toEqual({
      changed: ['b'],
      removed: ['a', 'd'],
    });
  });

  it('builds the share agent device id and manage deep link', () => {
    expect(providerShareAgentDeviceId('abc')).toBe('share:abc');
    const url = new URL(providerShareManagePath('custom:my provider'), 'https://x.test');
    expect(url.pathname).toBe('/settings');
    expect(url.searchParams.get('tab')).toBe('providers');
    expect(url.searchParams.get(PROVIDER_SHARE_MANAGE_PARAM)).toBe('custom:my provider');
  });
});
