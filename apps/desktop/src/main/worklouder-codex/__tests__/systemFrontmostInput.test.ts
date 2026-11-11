import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { joystickScrollSpeed } from '../../../shared/workLouderCodexScroll.js';
import {
  WINDOWS_WHEEL_DELTA,
  accumulateScrollNotches,
  createIntervalScrollPump,
  createMacHoldScrollPump,
  createWorkLouderCodexSystemFrontmostInput,
} from '../systemFrontmostInput.js';

describe('createWorkLouderCodexSystemFrontmostInput', () => {
  describe('microphone key outside Cindy', () => {
    const HOLD_DELAY_MS = 450;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function createVoiceInput() {
      const triggerVoice = vi.fn();
      return {
        triggerVoice,
        input: createWorkLouderCodexSystemFrontmostInput({
          triggerVoice,
          holdDelayMs: HOLD_DELAY_MS,
          createScrollPump: () => ({ setSpeed: vi.fn(), stop: vi.fn() }),
        }),
      };
    }

    it('keeps the overlay recording after a short tap', () => {
      const { triggerVoice, input } = createVoiceInput();

      expect(input.handle({ type: 'voice', phase: 'press' })).toBe(true);
      vi.advanceTimersByTime(HOLD_DELAY_MS - 1);
      expect(input.handle({ type: 'voice', phase: 'release' })).toBe(true);

      expect(triggerVoice.mock.calls.map(([phase]) => phase)).toEqual(['start', 'tap']);
    });

    it('submits when the key is held past the hold threshold', () => {
      const { triggerVoice, input } = createVoiceInput();

      expect(input.handle({ type: 'voice', phase: 'press' })).toBe(true);
      vi.advanceTimersByTime(HOLD_DELAY_MS);
      expect(input.handle({ type: 'voice', phase: 'release' })).toBe(true);

      expect(triggerVoice.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    });

    it('ignores repeated key-down messages while the key is held', () => {
      const { triggerVoice, input } = createVoiceInput();

      input.handle({ type: 'voice', phase: 'press' });
      input.handle({ type: 'voice', phase: 'press' });
      vi.advanceTimersByTime(HOLD_DELAY_MS);
      input.handle({ type: 'voice', phase: 'release' });

      expect(triggerVoice.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    });

    it('drops a release that has no matching press', () => {
      const { triggerVoice, input } = createVoiceInput();

      expect(input.handle({ type: 'voice', phase: 'release' })).toBe(true);

      expect(triggerVoice).not.toHaveBeenCalled();
    });
  });

  it('sends Return for the send key', () => {
    const postKey = vi.fn(async () => undefined);
    const input = createWorkLouderCodexSystemFrontmostInput({
      runner: { postKey, postScroll: vi.fn(async () => undefined) },
      createScrollPump: () => ({ setSpeed: vi.fn(), stop: vi.fn() }),
    });

    expect(input.handle({ type: 'command', commandId: 'composer.submit' })).toBe(true);
    expect(postKey).toHaveBeenCalledWith('return');
  });

  it('keeps a held stick scrolling until scroll-stop', () => {
    const speeds: number[] = [];
    const stop = vi.fn();
    const input = createWorkLouderCodexSystemFrontmostInput({
      createScrollPump: () => ({
        setSpeed: (pxPerSecond) => {
          speeds.push(pxPerSecond);
        },
        stop,
      }),
    });

    expect(input.handle({ type: 'scroll', direction: 'down', intensity: 1 })).toBe(true);
    expect(input.handle({ type: 'scroll', direction: 'up', intensity: 1 })).toBe(true);
    expect(input.handle({ type: 'scroll-stop' })).toBe(true);

    expect(speeds[0]).toBeCloseTo(-joystickScrollSpeed(1));
    expect(speeds[1]).toBeCloseTo(joystickScrollSpeed(1));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('discards a hold-scroll helper that finishes after stop', async () => {
    let resolveSpawn!: (child: {
      stdin: {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        destroyed: boolean;
      };
      kill: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    }) => void;
    const spawn = vi.fn(
      () =>
        new Promise<Parameters<typeof resolveSpawn>[0]>((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    const fallback = { setSpeed: vi.fn(), stop: vi.fn() };
    const pump = createMacHoldScrollPump(fallback, spawn);

    pump.setSpeed(-800);
    pump.stop();
    const child = {
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), destroyed: false },
      kill: vi.fn(),
      once: vi.fn(),
    };
    resolveSpawn(child);
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledWith('stop\n', expect.any(Function));
    expect(child.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(fallback.stop).toHaveBeenCalled();
  });

  it('listens for hold-scroll stdin errors before writing speed', async () => {
    let resolveSpawn!: (child: {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; destroyed: boolean };
      kill: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    }) => void;
    const spawn = vi.fn(
      () =>
        new Promise<Parameters<typeof resolveSpawn>[0]>((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    const pump = createMacHoldScrollPump({ setSpeed: vi.fn(), stop: vi.fn() }, spawn);
    pump.setSpeed(-800);
    const child = {
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), destroyed: false },
      kill: vi.fn(),
      once: vi.fn(),
    };
    resolveSpawn(child);
    await Promise.resolve();

    expect(child.stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.stdin.write).toHaveBeenCalledWith('-800\n', expect.any(Function));
  });

  it('keeps sub-notch Windows wheel remainders across ticks', () => {
    let state = accumulateScrollNotches(0, 42);
    expect(state).toEqual({ remainder: 42, deltaY: 0 });
    state = accumulateScrollNotches(state.remainder, 42);
    expect(state).toEqual({ remainder: 84, deltaY: 0 });
    state = accumulateScrollNotches(state.remainder, 42);
    expect(state).toEqual({ remainder: 6, deltaY: WINDOWS_WHEEL_DELTA });
  });

  it('posts a Windows wheel notch only after leftover pixels accumulate', async () => {
    vi.useFakeTimers();
    try {
      const postScroll = vi.fn(async () => undefined);
      let now = 1_000;
      const pump = createIntervalScrollPump(
        { postKey: vi.fn(async () => undefined), postScroll },
        () => now,
        WINDOWS_WHEEL_DELTA,
      );

      pump.setSpeed(2600);
      await vi.advanceTimersByTimeAsync(0);
      expect(postScroll).not.toHaveBeenCalled();

      now += 16;
      await vi.advanceTimersByTimeAsync(16);
      now += 16;
      await vi.advanceTimersByTimeAsync(16);
      expect(postScroll).toHaveBeenCalledWith(WINDOWS_WHEEL_DELTA);

      pump.stop();
      postScroll.mockClear();
      pump.setSpeed(2600);
      await vi.advanceTimersByTimeAsync(0);
      expect(postScroll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
