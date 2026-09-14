import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import {
  connectionRecoverySyncRetryDelayMs,
  connectionIssueHint,
  connectionIssueTitle,
  describeRemoteComposerBlockingError,
  describeRemoteError,
  formatRemoteError,
  humanizeRemoteError,
  isAutoRecoveringRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('remoteStatus', () => {
  it('backs repeated connection recovery syncs off and caps the delay', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(connectionRecoverySyncRetryDelayMs))
      .toEqual([900, 1_800, 3_600, 7_200, 14_400, 28_800, 30_000]);
    expect(connectionRecoverySyncRetryDelayMs(20)).toBe(30_000);
  });

  it('labels relay status', () => {
    expect(relayStatusLabel('online')).toBe('Relay 已连接');
    expect(relayStatusLabel('connecting')).toBe('正在连接 Relay');
    expect(relayStatusLabel('stopped')).toBe('Relay 未连接');
  });

  it('renders deterministic sync hints', () => {
    expect(relayStatusHint('online', new Date(2026, 0, 1, 3, 4, 5).getTime())).toBe('上次同步 03:04:05');
    expect(relayStatusHint('connecting', null)).toContain('自动重新订阅');
  });

  it('maps common remote errors to actionable copy', () => {
    expect(describeRemoteError('[REMOTE_DISABLED] disabled')).toContain('关闭允许远程控制');
    expect(describeRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x'")).toContain('版本不支持');
    expect(describeRemoteError('[ACCESS_REVOKED] revoked')).toContain('撤销手机访问权限');
    expect(describeRemoteError('[NOT_CONNECTED] offline')).toBe(i18n.t('session.screen.networkReconnecting'));
    expect(describeRemoteError('unknown failure')).toBe('unknown failure');
  });

  it('preserves structured remote error codes for banner classification', () => {
    const text = formatRemoteError(new DeviceLinkError('ACCESS_REVOKED', 'access revoked by target device'));
    expect(text).toBe('[ACCESS_REVOKED] access revoked by target device');
    expect(describeRemoteError(text)).toContain('撤销手机访问权限');

    expect(formatRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' }))).toBe(
      '[REMOTE_DISABLED] remote disabled',
    );
    expect(formatRemoteError(new Error('[NOT_CONNECTED] offline'))).toBe('[NOT_CONNECTED] offline');
  });

  it('keeps the composer writable for automatic recovery, but blocks deterministic failures', () => {
    for (const error of [
      '[NOT_CONNECTED] offline',
      '[DEVICE_OFFLINE] target unavailable',
      '[LINK_NOT_OPEN] reopening',
      '[INVOKE_TIMEOUT] timed out',
      '[DEVICE_UNRESPONSIVE] circuit open',
      '[SESSION_REFERENCE_OFFLINE] target unavailable',
      '[REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE] dedupe state unavailable',
    ]) {
      expect(isAutoRecoveringRemoteError(error), error).toBe(true);
      expect(describeRemoteComposerBlockingError(error), error).toBeNull();
    }

    const deliveryUnknown = new DeviceLinkError('NOT_CONNECTED', 'ack may be lost');
    deliveryUnknown.inFlight = true;
    expect(isAutoRecoveringRemoteError(deliveryUnknown)).toBe(true);

    expect(describeRemoteComposerBlockingError('[ACCESS_REVOKED] revoked'))
      .toContain('撤销手机访问权限');
    expect(describeRemoteComposerBlockingError('[REMOTE_DISABLED] disabled'))
      .toContain('关闭允许远程控制');
    expect(describeRemoteComposerBlockingError("[CHANNEL_NOT_ALLOWED] channel 'x'"))
      .toContain('版本不支持');
    expect(describeRemoteComposerBlockingError(null)).toBeNull();
  });

  it('localizes Stop connection recovery errors without dropping their structured classification', async () => {
    const previousLanguage = i18n.language;
    try {
      for (const locale of ['en', 'ja', 'ko', 'zh-TW'] as const) {
        await i18n.changeLanguage(locale);
        expect(describeRemoteError('[DEVICE_OFFLINE]')).toBe(i18n.t('session.menu.aiRenameOffline'));
        expect(describeRemoteError('[NOT_CONNECTED]')).toBe(i18n.t('session.screen.networkReconnecting'));
        expect(humanizeRemoteError(
          Object.assign(new Error('target unavailable'), { code: 'DEVICE_OFFLINE' }),
        )).toBe(i18n.t('session.menu.aiRenameOffline'));
        expect(humanizeRemoteError(
          Object.assign(new Error('relay reconnecting'), { code: 'NOT_CONNECTED' }),
        )).toBe(i18n.t('session.screen.networkReconnecting'));
      }
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('localizes every connection issue kind', async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en');
      expect(connectionIssueTitle('auth-failed')).toBe('Sign-in expired');
      expect(connectionIssueHint('replaced')).toContain('replaced elsewhere');
      expect(connectionIssueTitle('too-many-connections')).toBe('Too many connections');
      expect(connectionIssueHint('version-mismatch')).toContain('Update to the latest version');
      expect(connectionIssueTitle('unstable')).toBe('Connection keeps dropping');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
