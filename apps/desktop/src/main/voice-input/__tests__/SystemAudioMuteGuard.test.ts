import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const audio = vi.hoisted(() => ({ getMuted: vi.fn(), setMuted: vi.fn() }));
const native = vi.hoisted(() => ({ prewarm: vi.fn(), mute: vi.fn(), setMuted: vi.fn() }));
const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => processes);
vi.mock('../MacAudioMuteBackend.js', () => ({ macAudioMuteBackend: native }));
vi.mock('loudness', () => ({ default: audio }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  vi.resetModules();
  vi.doMock('loudness', () => ({ default: audio }));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  audio.getMuted.mockReset().mockResolvedValue(false);
  audio.setMuted.mockReset().mockResolvedValue(undefined);
  native.mute.mockReset();
  native.setMuted.mockReset().mockResolvedValue(undefined);
  processes.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('false\n'));
      child.emit('exit', 0);
    });
    return child;
  });
});
afterEach(() => vi.restoreAllMocks());

it('uses AppleScript when native is not ready and keeps that backend for restoration', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  native.mute.mockResolvedValue(false);
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  await guard.mute(1);
  // Native becomes ready during recording; the original snapshot is still legacy.
  native.mute.mockResolvedValue(true);
  await guard.restore(1);
  expect(processes.spawn).toHaveBeenCalledTimes(2);
  expect(processes.spawn.mock.calls[1][1]).toEqual(['-e', 'set volume without output muted']);
  expect(native.setMuted).not.toHaveBeenCalled();
});

it('queues stop behind an in-flight native mute and restores its original state', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const snapshot = { outputMuted: false, deviceId: 42, deviceUID: 'original-output' };
  let finish!: () => void;
  native.mute.mockImplementation(
    (save) =>
      new Promise<boolean>((resolve) => {
        finish = () => {
          save(snapshot);
          resolve(true);
        };
      }),
  );
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  const muting = guard.mute(1);
  const restoring = guard.restore(1);
  await Promise.resolve();
  expect(native.setMuted).not.toHaveBeenCalled();
  finish();
  await Promise.all([muting, restoring]);
  expect(native.setMuted).toHaveBeenCalledWith(snapshot, false);
});

it('retains native snapshot after a possibly applied failed mute and retries restore on the same device', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const snapshot = { outputMuted: false, deviceId: 42, deviceUID: 'original-output' };
  native.mute.mockImplementation(async (save) => {
    save(snapshot);
    throw new Error('write timed out');
  });
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  await expect(guard.mute(1)).rejects.toThrow('write timed out');
  native.setMuted.mockRejectedValueOnce(new Error('disconnected'));
  await expect(guard.restore(1)).rejects.toThrow('disconnected');
  await guard.mute(2);
  await guard.restore(2);
  expect(native.mute).toHaveBeenCalledTimes(1);
  expect(native.setMuted.mock.calls).toEqual([
    [snapshot, false],
    [snapshot, true],
    [snapshot, false],
  ]);
});

it('keeps native mute until the last owner stops, preserving an initially muted output', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const snapshot = { outputMuted: true, deviceId: 42, deviceUID: 'original-output' };
  native.mute.mockImplementation(async (save) => {
    save(snapshot);
    return true;
  });
  const { SystemAudioMuteGuard } = await import('../SystemAudioMuteGuard');
  const guard = new SystemAudioMuteGuard();
  await guard.mute(1);
  await guard.mute('remote-desktop');
  await guard.restore(1);
  expect(native.setMuted).not.toHaveBeenCalled();
  await guard.restoreAll();
  expect(native.setMuted).toHaveBeenCalledWith(snapshot, true);
});

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
