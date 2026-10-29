import { describe, expect, it } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import type { SlackToolBridgeLike } from '../types.js';

describe('cindy_slack provider gate', () => {
  const context = { agentKind: 'claude-code', workingDir: '/workspace' };

  it.each([
    { bound: false, serverSupportsTools: false, enabled: false },
    { bound: false, serverSupportsTools: true, enabled: false },
    { bound: true, serverSupportsTools: false, enabled: false },
    { bound: true, serverSupportsTools: true, enabled: true },
  ])(
    'bound=$bound serverSupportsTools=$serverSupportsTools -> $enabled',
    ({ bound, serverSupportsTools, enabled }) => {
      const bridge: SlackToolBridgeLike = {
        availability: () => ({ connected: true, bound, serverSupportsTools }),
        callTool: async () => ({ ok: true, result: null }),
      };
      const provider = createLiziMcpProviders({
        slackHook: { getBridge: () => bridge },
      }).find((item) => item.name === 'cindy_slack');

      expect(provider).toBeDefined();
      expect(provider?.isEnabled?.(context)).toBe(enabled);
    },
  );

  it.each(['codex', 'pi'])('keeps the %s shared gateway registered before binding', (agentKind) => {
    const provider = createLiziMcpProviders({ slackHook: { getBridge: () => null } })
      .find((item) => item.name === 'cindy_slack')!;
    expect(provider.isEnabled?.({ agentKind, workingDir: '' })).toBe(true);
    expect(provider.isEnabled?.({ agentKind, workingDir: '/workspace' })).toBe(false);
  });

  it('bridge 尚未注册时 fail-closed', () => {
    const provider = createLiziMcpProviders({
      slackHook: { getBridge: () => null },
    }).find((item) => item.name === 'cindy_slack');

    expect(provider?.isEnabled?.(context)).toBe(false);
  });
});
