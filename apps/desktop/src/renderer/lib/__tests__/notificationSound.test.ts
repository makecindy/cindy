// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audioHarness = vi.hoisted(() => ({
  play: vi.fn<() => Promise<void>>(),
  pause: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

import { NOTIFICATION_SOUND_START_TIMEOUT_MS, playSessionEventSound } from '../notificationSound';

describe('playSessionEventSound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    audioHarness.play.mockReset();
    audioHarness.pause.mockReset();
    vi.stubGlobal(
      'Audio',
      class {
        play = audioHarness.play;
        pause = audioHarness.pause;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns true when playback starts', async () => {
    audioHarness.play.mockResolvedValue(undefined);
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    expect(audioHarness.pause).not.toHaveBeenCalled();
  });

  it('returns false when playback rejects', async () => {
    audioHarness.play.mockRejectedValue(new Error('autoplay denied'));
    await expect(playSessionEventSound('error')).resolves.toBe(false);
  });

  it('bounds a pending playback start and pauses the late audio', async () => {
    audioHarness.play.mockReturnValue(new Promise<void>(() => undefined));
    const result = playSessionEventSound('needs-reply');

    await vi.advanceTimersByTimeAsync(NOTIFICATION_SOUND_START_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
    expect(audioHarness.pause).toHaveBeenCalledOnce();
  });
});
