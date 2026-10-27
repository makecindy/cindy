import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  module: null as null | { speak: ReturnType<typeof vi.fn>; stopSpeech: ReturnType<typeof vi.fn> },
  state: 'active',
  platform: 'ios',
  moduleLookups: vi.fn(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) => { mocks.moduleLookups(name); return mocks.module; },
  UnavailabilityError: class extends Error {},
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return mocks.platform; } },
  AppState: {
    get currentState() { return mocks.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));

import {
  isMobileVoiceSpeechAvailable,
  speakMobileVoiceReply,
  stopMobileVoiceSpeech,
} from '@/session/mobileVoiceSpeech';

// Test value: public speech entry must report playback completion, preserve new
// reply ownership and stop on background/abort (core-product-principles §4.3).
// Existing capture/cue tests do not cover native reply playback. Minimal failure:
// abort A after B starts must not silence B. Unit tier uses fake native promises;
// no timers, hardware or native speech engine is simulated as actually verified.
// Standalone measured time: 0.27 s wall / 0.19 s Vitest on 2026-10-20.
describe('mobile spoken replies', () => {
  let pending: { id: string; resolve: (result: 'done' | 'cancelled') => void } | undefined;

  beforeEach(() => {
    mocks.state = 'active';
    mocks.platform = 'ios';
    mocks.moduleLookups.mockClear();
    pending = undefined;
    mocks.module = {
      speak: vi.fn((options: { requestId: string }) => new Promise<'done' | 'cancelled'>(resolve => {
        pending = { id: options.requestId, resolve };
      })),
      stopSpeech: vi.fn(async (requestId: string) => {
        if (pending?.id !== requestId) return;
        const current = pending;
        pending = undefined;
        current.resolve('cancelled');
      }),
    };
  });

  afterEach(async () => {
    await stopMobileVoiceSpeech();
    expect(mocks.listeners.size).toBe(0);
  });

  it('keeps playback pending until native completion and returns the completion result', async () => {
    const result = speakMobileVoiceReply('Hello', { language: 'en-US' });
    let completed = false;
    void result.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(mocks.module!.speak.mock.calls[0][0]).toMatchObject({ text: 'Hello', language: 'en-US' });
    pending!.resolve('done');
    expect(await result).toBe('done');
  });

  it('rejects unavailable legacy builds without attempting playback', async () => {
    mocks.module = { speak: undefined as never, stopSpeech: undefined as never };
    expect(isMobileVoiceSpeechAvailable()).toBe(false);
    await expect(speakMobileVoiceReply('Hello')).rejects.toThrow();
    mocks.module = null;
    expect(isMobileVoiceSpeechAvailable()).toBe(false);
  });

  // The iOS-only release must never discover or invoke speech on other platforms,
  // even if a native module with the same methods is present.
  it.each(['android', 'web'])('does not load or invoke native speech on %s', async platform => {
    mocks.platform = platform;
    expect(isMobileVoiceSpeechAvailable()).toBe(false);
    await expect(speakMobileVoiceReply('Hello')).rejects.toThrow();
    expect(mocks.moduleLookups).not.toHaveBeenCalled();
    expect(mocks.module!.speak).not.toHaveBeenCalled();
  });

  it('cancels on background and does not start a reply while already inactive', async () => {
    const result = speakMobileVoiceReply('Private reply');
    mocks.state = 'background';
    mocks.listeners.forEach(listener => listener('background'));
    expect(await result).toBe('cancelled');
    expect(await speakMobileVoiceReply('Another reply')).toBe('cancelled');
    expect(mocks.module!.speak).toHaveBeenCalledTimes(1);
  });

  it('does not let an old abort stop a replacement reply', async () => {
    const controller = new AbortController();
    const first = speakMobileVoiceReply('First', { signal: controller.signal });
    const second = speakMobileVoiceReply('Second');
    expect(await first).toBe('cancelled');
    await Promise.resolve();
    controller.abort();
    expect(pending).toBeDefined();
    pending!.resolve('done');
    expect(await second).toBe('done');
    expect(mocks.module!.stopSpeech).toHaveBeenCalledTimes(1);
  });

  it('makes stop idempotent and skips an already aborted reply', async () => {
    const result = speakMobileVoiceReply('Hello');
    await Promise.all([stopMobileVoiceSpeech(), stopMobileVoiceSpeech()]);
    expect(await result).toBe('cancelled');
    expect(mocks.module!.stopSpeech).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    expect(await speakMobileVoiceReply('No audio', { signal: controller.signal })).toBe('cancelled');
    expect(mocks.module!.speak).toHaveBeenCalledTimes(1);
  });

  it('preserves every character across platform length limits and surrogate boundaries', async () => {
    mocks.module!.speak.mockResolvedValue('done');
    const reply = `${'a'.repeat(2999)}😀${'中'.repeat(4000)}`;
    expect(await speakMobileVoiceReply(reply)).toBe('done');
    const chunks = mocks.module!.speak.mock.calls.map(([options]) => options.text as string);
    expect(chunks.join('')).toBe(reply);
    expect(chunks.every(chunk => chunk.length <= 3000 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });

  it('reports synthesis errors rather than treating them as completed replies', async () => {
    const failure = new Error('ERR_VOICE_SPEECH_LANGUAGE');
    mocks.module!.speak.mockRejectedValue(failure);
    await expect(speakMobileVoiceReply('Hello')).rejects.toBe(failure);
  });
});
