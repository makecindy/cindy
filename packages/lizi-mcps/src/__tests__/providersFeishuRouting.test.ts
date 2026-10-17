import { describe, expect, it, vi } from 'vitest';
import { createLiziMcpProviders } from '../providers.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';

function setup() {
  const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'om_notification' }));
  const provider = createLiziMcpProviders({
    feishuBot: { getOwnerOpenId: () => 'ou_owner', sendFile: vi.fn(), sendMessage },
  }).find((candidate) => candidate.name === 'cindy_feishu_bot')!;
  const config = provider.toClaudeSdkConfig({ agentKind: 'codex', workingDir: '' }) as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> };
  };
  const call = () => config.instance._registeredTools.call_tool.handler({
    name: 'send_message_to_user', args: { text: 'hello' },
  });
  return { sendMessage, call };
}

describe('Feishu notification session attribution', () => {
  it('resolves each caller at tool-call time on the shared bridge', async () => {
    const { sendMessage, call } = setup();
    await Promise.all(['session-a', 'session-b'].map((sessionId) => runWithLiziMcpSessionContext(
      { agentKind: 'codex', workingDir: '/tmp/task', sessionId }, call,
    )));
    // 第 4 个参数是当前 tool-call 的 session ctx(宿主据此选出站 bot)。
    expect(sendMessage).toHaveBeenCalledWith('ou_owner', 'hello', 'session-a', expect.objectContaining({ sessionId: 'session-a' }));
    expect(sendMessage).toHaveBeenCalledWith('ou_owner', 'hello', 'session-b', expect.objectContaining({ sessionId: 'session-b' }));
  });

  it('keeps an explicit Feishu conversation out of owner notification routing', async () => {
    const { sendMessage, call } = setup();
    await runWithLiziMcpSessionContext({
      agentKind: 'codex', workingDir: '/tmp/task', sessionId: 'group-session',
      vendorOptions: { feishuChatId: 'oc_group' },
    }, call);
    expect(sendMessage).toHaveBeenCalledWith('oc_group', 'hello', undefined, expect.objectContaining({ sessionId: 'group-session' }));
  });

  it('leaves messages unattributed when no trusted caller is available', async () => {
    const { sendMessage, call } = setup();
    await call();
    expect(sendMessage).toHaveBeenCalledWith('ou_owner', 'hello', undefined, expect.objectContaining({ agentKind: 'codex' }));
  });
});
