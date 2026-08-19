import { describe, expect, it, vi } from 'vitest';

import { joystickScrollSpeed } from '../../../shared/workLouderCodexScroll.js';
import {
  createMacHoldScrollPump,
  createWorkLouderCodexSystemFrontmostInput,
} from '../systemFrontmostInput.js';

describe('createWorkLouderCodexSystemFrontmostInput', () => {
  it('maps a held microphone to the global overlay start/end phases', () => {
    const triggerVoice = vi.fn();
    const input = createWorkLouderCodexSystemFrontmostInput({ triggerVoice });

    expect(input.handle({ type: 'voice', phase: 'press' })).toBe(true);
    expect(input.handle({ type: 'voice', phase: 'release' })).toBe(true);

    expect(triggerVoice).toHaveBeenNthCalledWith(1, 'start');
    expect(triggerVoice).toHaveBeenNthCalledWith(2, 'end');
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
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroyed: boolean };
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
      stdin: { write: vi.fn(), end: vi.fn(), destroyed: false },
      kill: vi.fn(),
      once: vi.fn(),
    };
    resolveSpawn(child);
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.write).toHaveBeenCalledWith('stop\n');
    expect(fallback.stop).toHaveBeenCalled();
  });
});
