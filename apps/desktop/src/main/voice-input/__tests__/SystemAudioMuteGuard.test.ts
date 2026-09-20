import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({ getMuted: vi.fn(), setMuted: vi.fn() }));
vi.mock('loudness', () => ({ default: audio }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  vi.resetModules();
  vi.doMock('loudness', () => ({ default: audio }));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  audio.getMuted.mockReset().mockResolvedValue(false);
  audio.setMuted.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it.each(['restore', 'restoreAll'] as const)(
  'retains original audio state after failed %s through a new owner',
  async (method) => {
    const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
    const guard = new SystemAudioMuteGuard();
    await guard.mute(1);
    audio.setMuted.mockRejectedValueOnce(new Error('OS unavailable'));
    await expect(method === 'restore' ? guard.restore(1) : guard.restoreAll()).rejects.toThrow(
      'OS unavailable',
    );
    await guard.mute(2);
    await guard.restore(1);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false], [true]]);
    await guard.restore(2);
    expect(audio.getMuted).toHaveBeenCalledTimes(1);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false], [true], [false]]);
  },
);

it('allows a failed last-owner restore to be retried without another mute', async () => {
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  await guard.mute(1);
  audio.setMuted.mockRejectedValueOnce(new Error('OS unavailable'));
  await expect(guard.restore(1)).rejects.toThrow();
  await guard.restore(1);
  expect(audio.setMuted.mock.calls).toEqual([[true], [false], [false]]);
});

it('rejects mute when the Windows backend cannot load, including cached failures', async () => {
  vi.doMock('loudness', () => {
    throw new Error('module missing');
  });
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  await expect(guard.mute(1)).rejects.toThrow('SYSTEM_AUDIO_UNAVAILABLE');
  await expect(guard.mute(2)).rejects.toThrow('SYSTEM_AUDIO_UNAVAILABLE');
  expect(audio.getMuted).not.toHaveBeenCalled();
  expect(audio.setMuted).not.toHaveBeenCalled();
});

it.each([true, false])(
  'keeps remote and WebContents owners independent, remote first=%s',
  async (remoteFirst) => {
    const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
    const guard = new SystemAudioMuteGuard();
    const owners = remoteFirst
      ? ['remote-desktop' as const, 0xc1d0]
      : [0xc1d0, 'remote-desktop' as const];
    await guard.mute(owners[0]);
    await guard.mute(owners[1]);
    await guard.mute(owners[0]);
    await guard.restore(owners[0]);
    await guard.restore(owners[0]);
    expect(audio.getMuted).toHaveBeenCalledTimes(1);
    expect(audio.setMuted.mock.calls).toEqual([[true]]);
    await guard.restore(owners[1]);
    expect(audio.setMuted.mock.calls).toEqual([[true], [false]]);
  },
);
