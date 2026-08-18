import { describe, expect, it, vi } from 'vitest';

vi.mock('@cindy/maker-remote-ssh', () => ({
  BUNDLED_NODE_INSTALL_SH: 'echo bundled-node-install',
}));

import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { ensureDshRuntime } from '../dsh-remote-installer.js';

type ExecMock = ReturnType<typeof vi.fn<(command: string, opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>>;

function hostWith(exec: ExecMock): RemoteHost {
  return { id: 'remote-dsh-test', exec } as unknown as RemoteHost;
}

describe('ensureDshRuntime', () => {
  it('uses Cindy bundled Node then installs only exact-versioned DSH packages', async () => {
    const exec = vi.fn<(command: string, opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await ensureDshRuntime(hostWith(exec));
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][0]).toContain('bundled-node-install');
    const installCommand = String(exec.mock.calls[1][0]);
    expect(installCommand).toContain('bash -c');
    expect(installCommand).toContain('0.1.0-rc.7');
    expect(exec.mock.calls[1][1]).toMatchObject({ label: 'dsh-remote-runtime-install' });
  });

  it('deduplicates concurrent installs for the same SSH host', async () => {
    const exec = vi.fn<(command: string, opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const host = hostWith(exec);
    await Promise.all([ensureDshRuntime(host), ensureDshRuntime(host)]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the remote install command fails', async () => {
    const exec = vi.fn<(command: string, opts?: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'remote install failed' });
    await expect(ensureDshRuntime(hostWith(exec))).rejects.toThrow('unable to install DSH runtime');
  });
});
