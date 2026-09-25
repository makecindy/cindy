import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MacAudioMuteBackend } from '../MacAudioMuteBackend';

const snapshot = { outputMuted: false, deviceId: 42, deviceUID: 'output-42' };
const success = { stdout: JSON.stringify(snapshot), error: null };
beforeEach(() => vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin'));
afterEach(() => vi.restoreAllMocks());

it('does not wait for compilation or cold initialization on a mute request', async () => {
  let finish!: (binary: string) => void;
  const prepare = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const run = vi.fn().mockResolvedValue(success);
  const backend = new MacAudioMuteBackend(prepare, run);
  const warming = backend.prewarm();
  expect(backend.prewarm()).toBe(warming);
  expect(await backend.mute(vi.fn())).toBe(false);
  expect(run).not.toHaveBeenCalled();
  finish('helper');
  await warming;
  const save = vi.fn();
  expect(await backend.mute(save)).toBe(true);
  expect(save).toHaveBeenCalledWith(snapshot);
  expect(run.mock.calls.map((call) => call[1])).toEqual([['read'], ['mute']]);
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('falls back if warmup fails, without throwing into startup', async () => {
  const backend = new MacAudioMuteBackend(async () => {
    throw new Error('no compiler');
  });
  await backend.prewarm();
  expect(await backend.mute(vi.fn())).toBe(false);
});

it('falls back only when a failed mute has not produced a snapshot', async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce(success)
    .mockResolvedValueOnce({ stdout: '', error: new Error('unsupported device') })
    .mockResolvedValueOnce({ ...success, error: new Error('write timed out') });
  const backend = new MacAudioMuteBackend(async () => 'helper', run);
  await backend.prewarm();
  const save = vi.fn();
  expect(await backend.mute(save)).toBe(false);
  expect(save).not.toHaveBeenCalled();
  await expect(backend.mute(save)).rejects.toThrow('write timed out');
  expect(save).toHaveBeenCalledWith(snapshot);
});

it('restores the captured device and reports failed restores for retry', async () => {
  const run = vi.fn().mockResolvedValue(success);
  const backend = new MacAudioMuteBackend(async () => 'helper', run);
  await backend.prewarm();
  await backend.setMuted(snapshot, false);
  expect(run).toHaveBeenLastCalledWith('helper', ['set', '42', 'output-42', 'false'], 2_000);
  run.mockResolvedValueOnce({ stdout: '', error: new Error('device disconnected') });
  await expect(backend.setMuted(snapshot, false)).rejects.toThrow('device disconnected');
});

it.each(['null', '{}', '{"outputMuted":false,"deviceId":0,"deviceUID":"x"}'])(
  'does not enable native on an invalid warmup response: %s',
  async (stdout) => {
    const backend = new MacAudioMuteBackend(
      async () => 'helper',
      vi.fn().mockResolvedValue({ stdout, error: null }),
    );
    await backend.prewarm();
    expect(await backend.mute(vi.fn())).toBe(false);
  },
);

it('does not compile or spawn on Windows', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const prepare = vi.fn();
  const backend = new MacAudioMuteBackend(prepare);
  await backend.prewarm();
  expect(prepare).not.toHaveBeenCalled();
});
