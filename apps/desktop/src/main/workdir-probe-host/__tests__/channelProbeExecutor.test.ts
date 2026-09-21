import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../index', () => ({
  workdirProbeHostClient: { validate: vi.fn(), availability: vi.fn() },
}));

import { workdirProbeHostClient } from '../index';
import { MainProcessWorkdirProbeError } from '../MainProcessWorkdirProbeClient';
import { createWorkdirProbeHostExecutor } from '../channelProbeExecutor';

afterEach(() => vi.resetAllMocks());

describe('channel executor uses the main-process probe boundary', () => {
  it('passes validation and availability through with the caller deadline', async () => {
    const executor = createWorkdirProbeHostExecutor();
    vi.mocked(workdirProbeHostClient.validate).mockResolvedValue({
      ok: true,
      realPath: '/resolved',
    });
    vi.mocked(workdirProbeHostClient.availability).mockResolvedValue({ ok: true, usable: true });
    await expect(executor.validate('/selected', 5000)).resolves.toEqual({
      ok: true,
      realPath: '/resolved',
    });
    expect(workdirProbeHostClient.validate).toHaveBeenCalledWith('/selected', '/selected', 5000);
    await expect(executor.availability('/saved', 5000)).resolves.toEqual({
      ok: true,
      usable: true,
    });
    expect(workdirProbeHostClient.availability).toHaveBeenCalledWith('/saved', '/saved', 5000);
  });

  it.each(['validate', 'availability'] as const)(
    'maps main-process deadline and capacity errors for %s',
    async (kind) => {
      const executor = createWorkdirProbeHostExecutor();
      vi.mocked(workdirProbeHostClient[kind])
        .mockRejectedValueOnce(
          new MainProcessWorkdirProbeError('WORKDIR_PROBE_TIMEOUT', 'private host path'),
        )
        .mockRejectedValueOnce(
          new MainProcessWorkdirProbeError('WORKDIR_PROBE_UNAVAILABLE', 'private host path'),
        )
        .mockRejectedValueOnce(new Error('private host path'));
      await expect(executor[kind]('/dir', 20)).resolves.toEqual({
        ok: false,
        code: 'PROBE_TIMEOUT',
      });
      await expect(executor[kind]('/dir', 20)).resolves.toEqual({
        ok: false,
        code: 'PROBE_UNAVAILABLE',
      });
      await expect(executor[kind]('/dir', 20)).resolves.toEqual({
        ok: false,
        code: 'PROBE_UNAVAILABLE',
      });
    },
  );

  it('keeps new-directory rejection strict while treating missing saved directories as unavailable', async () => {
    const executor = createWorkdirProbeHostExecutor();
    vi.mocked(workdirProbeHostClient.validate).mockResolvedValue({
      ok: false,
      code: 'NOT_DIRECTORY',
    });
    vi.mocked(workdirProbeHostClient.availability).mockResolvedValue({
      ok: false,
      code: 'NOT_DIRECTORY',
    });
    await expect(executor.validate('/file', 20)).resolves.toEqual({
      ok: false,
      code: 'NOT_DIRECTORY',
    });
    await expect(executor.availability('/file', 20)).resolves.toEqual({ ok: true, usable: false });
  });
});
