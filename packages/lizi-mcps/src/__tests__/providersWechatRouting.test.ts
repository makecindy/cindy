import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import { getLiziMcpSessionContext, runWithLiziMcpSessionContext } from '../session-context.js';

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

describe('cindy_wechat provider routing', () => {
  // Regression: shared Pi/Codex bridges capture a blank workdir at registration.
  // Real provider handler, unit tier: current-call HTML succeeds; another task's
  // file, missing provenance and a symlink escape must never upload. Existing
  // routing coverage only sends text, so it cannot detect the missing file root.
  it('resolves each file call against its current task rather than the captured directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-provider-'));
    const dirs = [path.join(root, 'a'), path.join(root, 'b')];
    await Promise.all(dirs.map(dir => fs.mkdir(dir)));
    const files = dirs.map(dir => path.join(dir, 'report.html'));
    await Promise.all(files.map(file => fs.writeFile(file, '<!doctype html><title>test</title>')));
    const sendFile = vi.fn(async () => ({ ok: true, messageId: 'file-receipt' }));
    const provider = createLiziMcpProviders({ wechatBot: {
      getActivePeerIdForSession: id => id ? `peer-${id}` : null,
      getMostRecentPeerId: () => 'peer-recent',
      sendMessage: vi.fn(), sendFile,
    } }).find(p => p.name === 'cindy_wechat')!;
    const config = provider.toClaudeSdkConfig({
      agentKind: 'pi', workingDir: '', getSessionContext: getLiziMcpSessionContext,
    }) as { instance: unknown };
    const call = (dir: string, file: string, id: string) => runWithLiziMcpSessionContext(
      { agentKind: 'pi', workingDir: dir, sessionId: id },
      () => tools(config.instance).call_tool.handler({ name: 'send_file_to_user', args: { absPath: file } }),
    );
    try {
      const results = await Promise.all(dirs.map((dir, i) => call(dir, files[i]!, String(i))));
      expect(results.every(r => JSON.stringify(r).includes('file-receipt'))).toBe(true);
      for (const [i, file] of files.entries()) {
        expect(sendFile).toHaveBeenCalledWith(`peer-${i}`, await fs.realpath(file), undefined);
      }
      sendFile.mockClear();
      expect(JSON.stringify(await call(dirs[1]!, files[0]!, '1'))).toContain('PATH_OUT_OF_BOUNDS');
      expect(JSON.stringify(await call('', files[0]!, '0'))).toContain('WORKING_DIR_UNAVAILABLE');
      const link = path.join(dirs[1]!, 'escape.html');
      // Windows may not grant file-symlink creation; still run all ordinary path cases.
      const linked = await fs.symlink(files[0]!, link).then(() => true, (error: NodeJS.ErrnoException) => {
        if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code ?? '')) throw error;
        return false;
      });
      if (linked) expect(JSON.stringify(await call(dirs[1]!, link, '1'))).toContain('PATH_OUT_OF_BOUNDS');
      const remote = await runWithLiziMcpSessionContext(
        { agentKind: 'pi', workingDir: dirs[0]!, sessionId: 'remote', remoteHostId: 'ssh-host' },
        () => tools(config.instance).call_tool.handler({ name: 'send_file_to_user', args: { absPath: files[0] } }),
      );
      expect(JSON.stringify(remote)).toContain('WORKING_DIR_UNAVAILABLE');
      // Even a path that does not exist locally must be rejected before probing
      // the filesystem, rather than reading a same-named local SSH image.
      const remoteImage = await runWithLiziMcpSessionContext(
        { agentKind: 'pi', workingDir: dirs[0]!, sessionId: 'remote', remoteHostId: 'ssh-host' },
        () => tools(config.instance).call_tool.handler({
          name: 'send_file_to_user', args: { absPath: path.join(dirs[0]!, 'remote.png') },
        }),
      );
      expect(JSON.stringify(remoteImage)).toContain('WORKING_DIR_UNAVAILABLE');
      const unavailable = provider.toClaudeSdkConfig({
        agentKind: 'pi', workingDir: dirs[0]!, getSessionContext: () => undefined,
      }) as { instance: unknown };
      const noContext = await tools(unavailable.instance).call_tool.handler({
        name: 'send_file_to_user', args: { absPath: files[0] },
      });
      expect(JSON.stringify(noContext)).toContain('WORKING_DIR_UNAVAILABLE');
      expect(sendFile).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

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
