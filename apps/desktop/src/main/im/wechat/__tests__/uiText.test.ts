import { describe, expect, it } from 'vitest';

import { ui } from '../uiText';

describe('WeChat UI text', () => {
  it('uses WeChat-specific copy for channel-sensitive replies', () => {
    const channelCopy = [
      ui.slash.help,
      ui.slash.detachedBySlash,
      ui.slash.detachedByRevoke,
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'gpt',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        missing: 'provider-key',
      }),
      ...ui.cards.control.takeoverLoadingPrompts.map((prompt) => prompt('会话')),
      ...ui.cards.control.sessionAttachedOneshotPrompts,
    ].join('\n');

    expect(channelCopy).toContain('微信');
    expect(channelCopy).not.toMatch(/Discord|飞书/);
  });
});
