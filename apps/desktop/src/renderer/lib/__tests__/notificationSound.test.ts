// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audioHarness = vi.hoisted(() => ({
  play: vi.fn<() => Promise<void>>(),
  pause: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

import {
  NOTIFICATION_SOUND_START_TIMEOUT_MS,
  SESSION_SOUND_COOLDOWN_MS,
  playSessionEventSound,
  resetNotificationSoundCooldownForTest,
} from '../notificationSound';

describe('playSessionEventSound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    audioHarness.play.mockReset();
    audioHarness.pause.mockReset();
    resetNotificationSoundCooldownForTest();
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

  it('aborts and pauses a pending playback when the window regains focus', async () => {
    audioHarness.play.mockReturnValue(new Promise<void>(() => undefined));
    const controller = new AbortController();
    const result = playSessionEventSound('done', controller.signal);

    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(audioHarness.pause).toHaveBeenCalledOnce();
  });

  // ── 冷却合并(#3257 review P1):并发终态只播一声 ──────────────────────────

  it('merges same-kind events within the cooldown window into one playback', async () => {
    audioHarness.play.mockResolvedValue(undefined);
    // 第一次:真实播放,进入冷却
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    expect(audioHarness.play).toHaveBeenCalledTimes(1);
    // 冷却窗口内的同类事件:不再叠加播放,但返回 true(该条 toast 照常静音,
    // 用户刚听过同一个音,不需要 OS 音再补)
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    expect(audioHarness.play).toHaveBeenCalledTimes(1);
  });

  it('merges concurrent same-kind events before the first playback settles', async () => {
    let resolvePlayback!: () => void;
    audioHarness.play.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePlayback = resolve;
      }),
    );

    const first = playSessionEventSound('done');
    const second = playSessionEventSound('done');

    expect(audioHarness.play).toHaveBeenCalledTimes(1);
    resolvePlayback();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('cooldown is per kind: different kinds do not suppress each other', async () => {
    audioHarness.play.mockResolvedValue(undefined);
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    await expect(playSessionEventSound('error')).resolves.toBe(true);
    expect(audioHarness.play).toHaveBeenCalledTimes(2);
  });

  it('failed playback does not enter the cooldown: the next event retries', async () => {
    audioHarness.play.mockRejectedValueOnce(new Error('autoplay denied'));
    await expect(playSessionEventSound('done')).resolves.toBe(false);
    // 失败不占冷却窗口:紧接着的同批事件仍会重试播放
    audioHarness.play.mockResolvedValue(undefined);
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    expect(audioHarness.play).toHaveBeenCalledTimes(2);
  });

  it('cooldown expires after SESSION_SOUND_COOLDOWN_MS', async () => {
    audioHarness.play.mockResolvedValue(undefined);
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(SESSION_SOUND_COOLDOWN_MS + 1);
    await expect(playSessionEventSound('done')).resolves.toBe(true);
    expect(audioHarness.play).toHaveBeenCalledTimes(2);
  });
});
