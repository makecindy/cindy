import { describe, expect, it, vi } from 'vitest';
import { probeSessionWorkingDirectory } from '../sessionWorkingDirectoryProbe';

describe('session working directory probe', () => {
  it('returns the filesystem result without consulting the session binding', async () => {
    const stat = { isDirectory: () => true, dev: 7 };
    const readBoundWorkingDir = vi.fn(async () => 'C:/repo');

    await expect(probeSessionWorkingDirectory('C:/repo', {
      stat: vi.fn(async () => stat),
      readBoundWorkingDir,
    })).resolves.toEqual({ kind: 'stat', stat });
    expect(readBoundWorkingDir).not.toHaveBeenCalled();
  });

  it('tolerates a timeout when it is the already-bound session directory', async () => {
    const stat = vi.fn(async () => {
      throw Object.assign(new Error('probe timed out'), { code: 'WORKDIR_PROBE_TIMEOUT' });
    });

    await expect(probeSessionWorkingDirectory('C:\\repo', {
      stat,
      readBoundWorkingDir: vi.fn(async () => 'C:/repo/'),
    })).resolves.toEqual({ kind: 'bound-timeout' });
    expect(stat).toHaveBeenCalledOnce();
  });

  it('tolerates a timeout when the persisted binding matches the probed directory', async () => {
    const timeout = Object.assign(new Error('probe timed out'), { code: 'WORKDIR_PROBE_TIMEOUT' });

    await expect(probeSessionWorkingDirectory('C:/repaired-repo', {
      stat: vi.fn(async () => { throw timeout; }),
      readBoundWorkingDir: vi.fn(async () => ['C:/old-live-repo', 'C:/repaired-repo']),
    })).resolves.toEqual({ kind: 'bound-timeout' });
  });

  it('rethrows a timeout for an unbound directory instead of classifying it as missing', async () => {
    const timeout = Object.assign(new Error('probe timed out'), { code: 'WORKDIR_PROBE_TIMEOUT' });

    await expect(probeSessionWorkingDirectory('/stale/repo', {
      stat: vi.fn(async () => { throw timeout; }),
      readBoundWorkingDir: vi.fn(async () => '/current/repo'),
    })).rejects.toBe(timeout);
  });

  it('preserves non-timeout filesystem errors', async () => {
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });

    await expect(probeSessionWorkingDirectory('/repo', {
      stat: vi.fn(async () => { throw denied; }),
      readBoundWorkingDir: vi.fn(),
    })).rejects.toBe(denied);
  });
});
