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
        message: expect.stringContaining('Could not open an SSH command channel'),
      });
      expect(exec).toHaveBeenCalledTimes(stage === 'manager' ? 2 : 1);

      if (stage === 'cached bundle') {
        exec.mockResolvedValueOnce(result('OK\n'));
        await expect(ensureCcManagerInstalledOrInstall({ host })).resolves.toBeUndefined();
        expect(exec).toHaveBeenCalledTimes(2);
      }
    },
  );

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
