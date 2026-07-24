import { describe, expect, it, vi } from 'vitest';

import { runVoiceInputStartPreflight } from '../voice-input/startPreflight';

describe('voice input start preflight', () => {
  it('rejects concurrent starts without invoking another preflight', async () => {
    const lock = { current: false };
    let release!: (accepted: boolean) => void;
    const pendingConsent = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const firstPreflight = vi.fn(() => pendingConsent);
    const concurrentPreflight = vi.fn(() => true);

    const firstStart = runVoiceInputStartPreflight(lock, firstPreflight);
    await expect(runVoiceInputStartPreflight(lock, concurrentPreflight)).resolves.toBe(false);
    expect(concurrentPreflight).not.toHaveBeenCalled();

    release(false);
    await expect(firstStart).resolves.toBe(false);
    await expect(runVoiceInputStartPreflight(lock, concurrentPreflight)).resolves.toBe(true);
    expect(concurrentPreflight).toHaveBeenCalledTimes(1);
  });
});
