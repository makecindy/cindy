import { describe, expect, it } from 'vitest';

import type { SlackHookView } from '../../../shared/hookControlIpc';
import { hookViewToBotChannelConnections } from '../botChannelConnections';

function view(): SlackHookView {
  return {
    enabled: true,
    lifecycleAnnouncement: false,
    url: 'wss://hooks.example.test',
    workspaces: {},
    status: 'connected',
    lastError: null,
    binding: null,
    bindings: [
      {
        teamId: 'T1', teamName: 'Acme', slackUserId: 'U1', slackUserName: 'Chris', displaced: false,
      },
      {
        teamId: 'T2', teamName: 'Old', slackUserId: 'U1', slackUserName: 'Chris', displaced: true,
      },
    ],
    pendingBind: null,
    serverMultiTeam: true,
    telegram: {
      enabled: true,
      url: 'wss://telegram.example.test',
      status: 'connected',
      lastError: null,
      available: true,
      capabilityPending: false,
      defaultWorkspace: null,
      binding: {
        provider: 'telegram',
        state: 'confirmed',
        attemptId: null,
        bindingId: 'binding-1',
        principalId: '101',
        principalName: 'Chris',
        scopeId: 'bot-1',
        scopeName: '@cindy_bot',
        connectUrl: null,
        expiresAt: null,
        reason: null,
        remediationUrl: null,
        actions: [],
      },
    },
    x: {
      enabled: false,
      url: '',
      status: 'disabled',
      lastError: null,
      available: false,
      capabilityPending: false,
      binding: null,
      defaultWorkspace: null,
    },
  };
}

describe('hookViewToBotChannelConnections', () => {
  it('exposes each live Slack team and the official Telegram bot as separate mount identities', () => {
    const rows = hookViewToBotChannelConnections(view());
    expect(rows.map((row) => [row.kind, row.accountKey, row.ownership])).toEqual([
      ['slack', 'T1', 'server-relay'],
      ['telegram', 'bot-1', 'server-relay'],
    ]);
    expect(rows[0]?.features).toContain('threads');
    expect(rows[1]?.features).toContain('group-history');
  });

  it('retains configured accounts while offline but marks them disconnected', () => {
    const offline = view();
    offline.status = 'disabled';
    offline.enabled = false;
    offline.telegram.status = 'connecting';
    const rows = hookViewToBotChannelConnections(offline);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.connected === false)).toBe(true);
  });
});
