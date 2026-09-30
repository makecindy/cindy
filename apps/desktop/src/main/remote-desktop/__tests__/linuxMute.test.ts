import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
import { LinuxDesktopMute } from '../linuxMute';
function setup(muted = false) {
  const sink = {
    id: 62,
    info: {
      props: { 'object.serial': 123, 'node.name': 'speakers', 'media.class': 'Audio/Sink' },
      params: { Props: [{ softMute: muted }] },
    },
  };
  let name = 'speakers';
  const extra = new Map<string, typeof sink>();
  const run = vi.fn(async (tool: string) => {
    if (tool === 'pactl') return name;
    if (tool === 'pw-dump') return JSON.stringify([sink, ...extra.values()]);
    return '';
  });
  return {
    sink,
    run,
    mute: new LinuxDesktopMute(run),
    setDefault: (value: string) => {
      name = value;
    },
    addSink: (value: string, id: number, serial: number) => {
      extra.set(value, {
        id,
        info: {
          props: { 'object.serial': serial, 'node.name': value, 'media.class': 'Audio/Sink' },
          params: { Props: [{ softMute: false }] },
        },
      });
    },
  };
}
it('restores the original output after default changes and stop races mute', async () => {
  const h = setup();
  await h.mute.set(true);
  h.setDefault('headphones');
  await Promise.all([h.mute.set(true), h.mute.set(false)]);
  expect(h.run).toHaveBeenLastCalledWith('pw-cli', [
    'set-param',
    '62',
    'Props',
    '{ softMute: false }',
  ]);
});

it('mutes a newly selected default output and restores every changed sink', async () => {
  vi.useFakeTimers();
  const h = setup();
  h.addSink('headphones', 63, 456);
  await h.mute.set(true);
  h.setDefault('headphones');
  await vi.advanceTimersByTimeAsync(1000);
  await h.mute.set(false);
  const writes = h.run.mock.calls.filter(([tool]) => tool === 'pw-cli');
  expect(writes).toContainEqual(['pw-cli', ['set-param', '62', 'Props', '{ softMute: false }']]);
  expect(writes).toContainEqual(['pw-cli', ['set-param', '63', 'Props', '{ softMute: false }']]);
  h.mute.stop();
  vi.useRealTimers();
});

it('keeps retrying exact sink restoration after a transient failure', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.mute.set(true);
  h.run.mockRejectedValueOnce(new Error('temporary pw failure'));
  await expect(h.mute.set(false)).rejects.toThrow('DESKTOP_HOST_MUTE_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.run.mock.calls.filter(([tool]) => tool === 'pw-cli').length).toBeGreaterThan(1);
  h.mute.stop();
  vi.useRealTimers();
});
it('preserves pre-existing mute and retries failed restoration', async () => {
  const h = setup(true);
  await h.mute.set(true);
  h.run.mockRejectedValueOnce(new Error('private diagnostics'));
  await expect(h.mute.set(false)).rejects.toThrow('DESKTOP_HOST_MUTE_UNAVAILABLE');
  await h.mute.set(false);
  expect(h.run).toHaveBeenLastCalledWith('pw-cli', [
    'set-param',
    '62',
    'Props',
    '{ softMute: true }',
  ]);
});
it('does not touch a different output which reused an unplugged output ID', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.mute.set(true);
  h.run.mockClear();
  h.sink.info.props['object.serial'] = 456;
  await h.mute.set(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.run.mock.calls.some((c) => c[0] === 'pw-cli')).toBe(false);
});
it('stops polling while restoration fails and bounds restoration retries', async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.mute.set(true);
  h.run.mockClear();
  h.run.mockRejectedValue(new Error('offline'));
  await expect(h.mute.set(false)).rejects.toThrow('DESKTOP_HOST_MUTE_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(20000);
  expect(h.run).toHaveBeenCalledTimes(6);
  expect(h.run.mock.calls.every(([tool]) => tool === 'pw-dump')).toBe(true);
});
