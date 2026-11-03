/**
 * 任务菜单的账号余量读哪台电脑(2026-10-09 用户反馈:远程供应商的任务看不到余量 —— 读的是被控
 * 电脑的同名账号,Agent 实际在另一台电脑)。
 */
import { describe, expect, it } from 'vitest';

import {
  formatProviderAccountLabel,
  resolveSessionUsageAccount,
} from '@/session/sessionUsageAccount';

describe('resolveSessionUsageAccount', () => {
  it('Agent 就在被控电脑上:读被控电脑', () => {
    expect(
      resolveSessionUsageAccount({ agentDeviceId: null, providerId: 'anthropic', sharedTaskGuest: false }),
    ).toEqual({ kind: 'host' });
  });

  it('Agent 在同账号另一台电脑:读那台', () => {
    expect(
      resolveSessionUsageAccount({
        agentDeviceId: 'device-agent',
        providerId: 'anthropic',
        sharedTaskGuest: false,
      }),
    ).toEqual({ kind: 'device', deviceId: 'device-agent' });
  });

  it('分享来的供应商、共享任务访客、没指定来源:读不到', () => {
    expect(
      resolveSessionUsageAccount({
        agentDeviceId: 'share:share-1',
        providerId: 'anthropic',
        sharedTaskGuest: false,
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      resolveSessionUsageAccount({
        agentDeviceId: 'device-owner-other',
        providerId: 'anthropic',
        sharedTaskGuest: true,
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      resolveSessionUsageAccount({ agentDeviceId: 'device-agent', providerId: ' ', sharedTaskGuest: false }),
    ).toEqual({ kind: 'unreadable' });
  });

  it('SSH 远程工作区忽略残留的 agentDeviceId(与电脑端同口径)', () => {
    expect(
      resolveSessionUsageAccount({
        agentDeviceId: 'device-agent',
        providerId: 'anthropic',
        sharedTaskGuest: false,
        remoteHostId: 'ssh-host',
      }),
    ).toEqual({ kind: 'host' });
  });
});

describe('formatProviderAccountLabel', () => {
  it('来源名后接登录身份,名称里已含身份时不重复', () => {
    expect(
      formatProviderAccountLabel({
        name: 'Claude',
        subscriptionAccount: { source: 'oauth', identity: 'a@example.com' },
      }),
    ).toBe('Claude · a@example.com');
    expect(
      formatProviderAccountLabel({
        name: 'ChatGPT a@example.com',
        openAiAccount: { source: 'oauth', identity: 'a@example.com' },
      }),
    ).toBe('ChatGPT a@example.com');
    expect(formatProviderAccountLabel(undefined)).toBeUndefined();
  });
});
