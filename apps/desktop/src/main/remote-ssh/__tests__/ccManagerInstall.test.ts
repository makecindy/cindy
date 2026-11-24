import { PROTOCOL_VERSION } from '@cindy/maker-cc-manager/protocol';
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearCcManagerInstallCache, ensureCcManagerInstalledOrInstall } from '../cc-manager-install.js';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const channelRefused = () => Object.assign(
  new Error('(SSH) Channel open failure: open failed'),
  { reason: 2 },
);
const result = (stdout: string) => ({ stdout, stderr: '', exitCode: 0, signal: null });
const readyAgent = result('READY 2.1.321\n');
const readyManager = result(
  'NODE_READY 22.0.0\n' +
  `MGR_READY {"managerVersion":"test","protocolVersion":${PROTOCOL_VERSION}}\n`,
);

function hostFixture() {
  const exec = vi.fn<RemoteHost['exec']>().mockRejectedValue(new Error('unexpected SSH call'));
  const host = { id: 'test-host', getStatus: () => 'ready', exec } as unknown as RemoteHost;
  return { host, exec };
}

describe('Claude Code SSH startup probes', () => {
  beforeEach(() => clearCcManagerInstallCache());

  it.each(['agent', 'manager', 'cached bundle'] as const)(
    'reports a refused %s probe without attempting installation',
    async (stage) => {
      const { host, exec } = hostFixture();
      if (stage === 'cached bundle') {
        exec.mockResolvedValueOnce(readyAgent)
          .mockResolvedValueOnce(readyManager)
          .mockResolvedValueOnce(result('OK\n'));
        await ensureCcManagerInstalledOrInstall({ host });
        exec.mockClear();
      } else if (stage === 'manager') {
        exec.mockResolvedValueOnce(readyAgent);
      }
      exec.mockRejectedValueOnce(channelRefused());

      await expect(ensureCcManagerInstalledOrInstall({ host })).rejects.toMatchObject({
        code: 'SSH_EXEC_FAILED',
        message: expect.stringContaining('SSH command channel open failed'),
      });
      expect(exec).toHaveBeenCalledTimes(stage === 'manager' ? 2 : 1);

      if (stage === 'cached bundle') {
        exec.mockResolvedValueOnce(result('OK\n'));
        await expect(ensureCcManagerInstalledOrInstall({ host })).resolves.toBeUndefined();
        expect(exec).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each(['before the probe', 'while the probe is pending'] as const)(
    'shares the same-host install that starts %s',
    async (timing) => {
      const { host, exec } = hostFixture();
      const blockedProbe = Promise.withResolvers<Awaited<ReturnType<RemoteHost['exec']>>>();
      const installProbe = Promise.withResolvers<Awaited<ReturnType<RemoteHost['exec']>>>();
      const installStarted = Promise.withResolvers<void>();
      const installError = new Error('shared install failed');

      if (timing === 'while the probe is pending') {
        exec.mockReturnValueOnce(blockedProbe.promise);
      }
      exec.mockResolvedValueOnce(result('NOT_INSTALLED\n')).mockImplementationOnce(() => {
        installStarted.resolve();
        return installProbe.promise;
      }).mockRejectedValueOnce(channelRefused());
      const second = timing === 'while the probe is pending'
        ? ensureCcManagerInstalledOrInstall({ host })
        : null;
      const first = ensureCcManagerInstalledOrInstall({ host });
      await installStarted.promise;
      const joined = second ?? ensureCcManagerInstalledOrInstall({ host });
      const results = Promise.allSettled([first, joined]);
      if (second) blockedProbe.reject(channelRefused());
      // Leave the install pending while the rejected probe resumes.
      await Promise.resolve();
      installProbe.reject(installError);

      const failure = { status: 'rejected', reason: expect.objectContaining({
        code: 'SSH_INSTALL_FAILED',
        message: expect.stringContaining(installError.message),
      }) };
      expect(await results).toEqual([failure, failure]);
      expect(exec).toHaveBeenCalledTimes(second ? 3 : 2);
    },
  );

  it.each([
    { error: channelRefused(), refused: true },
    { error: new Error('daemon check timed out'), refused: false },
  ])('distinguishes a refused daemon probe from other failures (refused=$refused)', async ({ error, refused }) => {
    const { host, exec } = hostFixture();
    exec.mockResolvedValueOnce(readyAgent)
      .mockResolvedValueOnce(readyManager)
      .mockResolvedValueOnce(result('OK\n'))
      .mockRejectedValueOnce(error);

    const prepare = ensureCcManagerInstalledOrInstall({ host });
    if (refused) {
      await expect(prepare).rejects.toMatchObject({ code: 'SSH_EXEC_FAILED' });
    } else {
      await expect(prepare).resolves.toBeUndefined();
    }
    expect(exec).toHaveBeenCalledTimes(4);

    // A refused probe must not mark the manager as installed.
    if (refused) exec.mockResolvedValueOnce(readyAgent).mockResolvedValueOnce(readyManager);
    exec.mockResolvedValueOnce(result('OK\n')).mockResolvedValueOnce(result('ALIVE\n'));
    await expect(ensureCcManagerInstalledOrInstall({ host })).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(refused ? 8 : 5);
  });

  it('continues to installation when the probe confirms the runtime is missing', async () => {
    const { host, exec } = hostFixture();
    exec.mockResolvedValueOnce(result('NOT_INSTALLED\n'))
      .mockResolvedValueOnce(result('NODE_READY 22.0.0\nMGR_MISSING\n'))
      .mockRejectedValueOnce(new Error('installer failed'));

    await expect(ensureCcManagerInstalledOrInstall({ host })).rejects.toMatchObject({
      code: 'SSH_INSTALL_FAILED',
      message: expect.stringContaining('installer failed'),
    });
    expect(exec).toHaveBeenCalledTimes(3);
  });
});
