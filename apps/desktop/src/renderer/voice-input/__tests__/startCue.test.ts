import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function audioContext(state = 'running') {
  const parameter = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  const oscillator = {
    type: '',
    frequency: parameter,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const gain = { gain: parameter, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state,
    currentTime: 0,
    destination: {},
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: vi.fn(() => new Promise<void>(() => {})),
  };
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context;
    }),
  );
  return { oscillator, gain, context };
}

describe('ready cue completion for system mute', () => {
  it('settles after playback ends and disconnects its audio nodes', async () => {
    const { oscillator, gain } = audioContext();
    const { playVoiceInputStartCue } = await import('../startCue');
    const done = vi.fn();
    const playback = playVoiceInputStartCue().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    oscillator.onended?.();
    await playback;
    expect(done).toHaveBeenCalledOnce();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a suspended context and cancels the sound so it cannot play late', async () => {
    const { oscillator } = audioContext('suspended');
    const { playVoiceInputStartCue } = await import('../startCue');
    const playback = playVoiceInputStartCue();
    await vi.advanceTimersByTimeAsync(310);
    await playback;
    expect(oscillator.stop).toHaveBeenLastCalledWith();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(oscillator.onended).toBeNull();
  });

  it('does not prevent muting when playback is unavailable', async () => {
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        throw new Error('unavailable');
      }),
    );
    const { playVoiceInputStartCue } = await import('../startCue');
    await expect(playVoiceInputStartCue()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
