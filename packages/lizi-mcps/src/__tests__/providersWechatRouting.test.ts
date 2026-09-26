import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

describe('cindy_wechat send-file working directory', () => {
  it('resolves the working directory at tool-call time on the codex bridge', async () => {
    // 回归:workingDir 曾在 server factory 阶段静态绑定 ctx.workingDir ——
    // Codex / Pi 的 HTTP 桥 factory 时只有全局空 ctx, 即使当前会话有真实
    // 工作目录, send_file_to_user 也必然 WORKING_DIR_UNAVAILABLE。修复后与
    // getPeerId 同纪律, 调用期从 session context 解析。
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-wechat-routing-'));
    const absPath = path.join(workingDir, 'preview.png');
    await fs.writeFile(absPath, 'png-bytes');
    const sendFile = vi.fn(async () => ({ ok: true, messageId: 'media-1' }));
    try {
      const provider = createLiziMcpProviders({
        wechatBot: {
          getActivePeerIdForSession: () => null,
          getMostRecentPeerId: () => 'peer-recent',
          sendMessage: vi.fn(),
          sendFile,
        },
      }).find((candidate) => candidate.name === 'cindy_wechat');
      if (!provider) throw new Error('cindy_wechat provider missing');

      // factory 阶段:Codex 全局空 ctx(workingDir 为空) —— 与生产桥同形状。
      const config = provider.toClaudeSdkConfig({
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      }) as { type: 'sdk'; instance: unknown };

      const outcome = await runWithLiziMcpSessionContext(
        {
          agentKind: 'codex',
          workingDir,
          sessionId: 'desktop-session',
          vendorOptions: {},
        },
        () =>
          tools(config.instance).call_tool.handler({
            name: 'send_file_to_user',
            args: { absPath, displayName: 'result.png' },
          }) as Promise<{ isError?: boolean }>,
      );

      expect(JSON.stringify(outcome)).not.toContain('WORKING_DIR_UNAVAILABLE');
      expect(sendFile).toHaveBeenCalledWith('peer-recent', await fs.realpath(absPath), 'result.png');
    } finally {
      await fs.rm(workingDir, { recursive: true, force: true });
    }
  });
});
