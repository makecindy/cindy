import { describe, expect, it, vi } from 'vitest';
import { createLiziMcpProviders } from '../providers.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';
import type { FeishuBotMcpHostDeps } from '../types.js';

function setup(getOwnerOpenId: FeishuBotMcpHostDeps['getOwnerOpenId'] = async () => 'ou_owner') {
  const sendMessage = vi.fn(async () => ({ ok: true, messageId: 'om_notification' }));
  const sendFile = vi.fn(async () => ({ ok: true, messageId: 'om_file' }));
  const provider = createLiziMcpProviders({
    feishuBot: { getOwnerOpenId, sendFile, sendMessage },
  }).find((candidate) => candidate.name === 'cindy_feishu_bot')!;
  const config = provider.toClaudeSdkConfig({ agentKind: 'codex', workingDir: '' }) as {
    instance: { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> };
  };
  const call = () => config.instance._registeredTools.call_tool.handler({
    name: 'send_message_to_user', args: { text: 'hello' },
  });
  const callFile = () => config.instance._registeredTools.call_tool.handler({
    name: 'send_file_to_user', args: { absPath: '/tmp/report.txt' },
  });
  return { sendMessage, sendFile, call, callFile };
}

describe('Feishu notification session attribution', () => {
  // #6439: worker DB owner lookup is asynchronous. The real MCP handler must
  // pass a resolved recipient to both send paths, never a Promise (unit tier).
  it('awaits the owner before sending a file', async () => {
    const { sendFile, callFile } = setup();
    await callFile();
    expect(sendFile).toHaveBeenCalledWith('ou_owner', '/tmp/report.txt', undefined, expect.any(Object));
  });
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
    const { sendMessage, call } = setup(() => 'ou_owner');
    await call();
    expect(sendMessage).toHaveBeenCalledWith('ou_owner', 'hello', undefined, expect.objectContaining({ agentKind: 'codex' }));
  });

  it('does not send or suggest rebinding when the asynchronous owner lookup fails', async () => {
    const { sendMessage, sendFile, call, callFile } = setup(async () => { throw new Error('DbClient not ready'); });
    for (const invoke of [call, callFile]) {
      await expect(invoke()).rejects.toThrow('DbClient not ready');
    }
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
  });
});
