import { describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

describe('cindy_wechat provider routing', () => {
  it('pins an attached WeChat turn to the peer active in the current session', async () => {
    const getActivePeerIdForSession = vi.fn((sessionId: string | undefined) =>
      sessionId === 'desktop-session' ? 'peer-active' : null,
    );
    const getMostRecentPeerId = vi.fn(() => 'peer-recent');
    const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'message-1' }));
    const provider = createLiziMcpProviders({
      wechatBot: {
        getActivePeerIdForSession,
        getMostRecentPeerId,
        sendMessage,
        sendFile: vi.fn(),
      },
    }).find((candidate) => candidate.name === 'cindy_wechat');
    if (!provider) throw new Error('cindy_wechat provider missing');

    const config = provider.toClaudeSdkConfig({
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    }) as { type: 'sdk'; instance: unknown };

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        sessionId: 'desktop-session',
        vendorOptions: {},
      },
      () =>
        tools(config.instance).call_tool.handler({
          name: 'send_message_to_user',
          args: { text: 'hello' },
        }),
    );

    expect(getActivePeerIdForSession).toHaveBeenCalledWith('desktop-session');
    expect(getMostRecentPeerId).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('peer-active', 'hello');
  });
});
