import { describe, expect, it, vi } from 'vitest';

import { joystickScrollSpeed } from '../../../shared/workLouderCodexScroll.js';
import { createWorkLouderCodexSystemFrontmostInput } from '../systemFrontmostInput.js';

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
});
