import { describe, expect, it } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import {
  connectionIssueHint,
  connectionIssueTitle,
  describeRemoteError,
  formatRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@/device-link/remoteStatus';
import { i18n } from '@/i18n';

describe('remoteStatus', () => {
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
    expect(describeRemoteError('[NOT_CONNECTED] offline')).toContain('稍后重新同步');
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
