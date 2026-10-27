import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileVoiceConversation,
  type MobileVoiceConversationOptions,
} from '@/session/mobileVoiceConversation';

/**
 * Test value: call the production conversation controller to verify the user's
 * opt-in recording → send → reply playback → next recording lifecycle.
 * Contract: screen loss/stop must end capture, never send empty speech, and never
 * capture Cindy's playback. Existing mobileVoiceController tests only cover a
 * single ASR recording, not automatic sending or playback between recordings.
 * Minimal failures: unchanged partial ASR text, a reply before send resolves, and
 * stop while capture/send/playback is pending. Unit tier: injected adapters and
 * fake timers, without native recording, network or real waits.
 */

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<MobileVoiceConversationOptions> = {}) {
  const adapters = {
    startListening: vi.fn(async () => undefined),
    finishListening: vi.fn(async (): Promise<string | null> => 'Recognized message'),
    cancelListening: vi.fn(async () => undefined),
    send: vi.fn(async (_text: string) => undefined),
    speak: vi.fn(async (_text: string) => undefined),
    stopSpeaking: vi.fn(async () => undefined),
    onStateChanged: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  return { ...adapters, conversation: createMobileVoiceConversation(adapters) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('mobile voice conversation', () => {
  it('sends once after changed speech settles, stops capture before playback and resumes after playback', async () => {
    const playback = deferred<void>();
    const order: string[] = [];
    const h = harness({
      startListening: vi.fn(async () => { order.push('listen'); }),
      finishListening: vi.fn(async () => { order.push('capture-ended'); return 'Final speech.'; }),
      send: vi.fn(async () => { order.push('send'); }),
      speak: vi.fn(async () => { order.push('speak'); await playback.promise; }),
    });
    await h.conversation.begin();
    h.conversation.onTranscriptChanged('First');
    await vi.advanceTimersByTimeAsync(1_000);
    h.conversation.onTranscriptChanged('First thought');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.send).not.toHaveBeenCalled();
    // Duplicate ASR events do not postpone an already completed utterance.
    h.conversation.onTranscriptChanged('First thought');
    await vi.advanceTimersByTimeAsync(800);
    expect(h.send).toHaveBeenCalledExactlyOnceWith('Final speech.');
    expect(h.conversation.getState()).toBe('waiting');
    const reply = h.conversation.onReply({ id: 'reply-1', text: 'Answer.' });
    expect(h.conversation.getState()).toBe('speaking');
    h.conversation.onTranscriptChanged('Answer.');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(order).toEqual(['listen', 'capture-ended', 'send', 'speak']);
    playback.resolve();
    await reply;
    expect(order).toEqual(['listen', 'capture-ended', 'send', 'speak', 'listen']);
    expect(h.conversation.getState()).toBe('listening');
    expect(h.conversation.currentDraft()).toBe('');
    await h.conversation.dispose();
  });

  it('does not send an existing unchanged draft or keep a silent microphone running', async () => {
    const h = harness();
    await h.conversation.begin({ initialDraft: 'Draft from before activation' });
    h.conversation.onTranscriptChanged('Draft from before activation');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.cancelListening).toHaveBeenCalledOnce();
    expect(h.conversation.getState()).toBe('idle');
    expect(h.conversation.currentDraft()).toBe('Draft from before activation');
  });

  it.each([null, '', '   '])('pauses and preserves a draft if final recognition is %j', async (finalText) => {
    const h = harness({ finishListening: vi.fn(async () => finalText) });
    await h.conversation.begin();
    h.conversation.onTranscriptChanged('Keep this draft');
    await h.conversation.submit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.conversation.getState()).toBe('paused');
    expect(h.conversation.currentDraft()).toBe('Keep this draft');
  });

  it('coalesces a manual send and the silence timer while final recognition is pending', async () => {
    const finalText = deferred<string>();
    const h = harness({ finishListening: vi.fn(() => finalText.promise) });
    await h.conversation.begin();
    h.conversation.onTranscriptChanged('Question');
    const submit = h.conversation.submit();
    await h.conversation.submit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.finishListening).toHaveBeenCalledOnce();
    finalText.resolve('Question?');
    await submit;
    expect(h.send).toHaveBeenCalledExactlyOnceWith('Question?');
    await h.conversation.dispose();
  });

  it('waits for successful send before speaking a fast reply and ignores duplicate or inactive replies', async () => {
    const sending = deferred<void>();
    const h = harness({ send: vi.fn(() => sending.promise) });
    await h.conversation.onReply({ id: 'old', text: 'Old reply' });
    await h.conversation.begin();
    const submit = h.conversation.submit();
    await vi.advanceTimersByTimeAsync(0);
    await h.conversation.onReply({ id: 'answer', text: 'New reply' });
    expect(h.speak).not.toHaveBeenCalled();
    sending.resolve();
    await submit;
    expect(h.speak).toHaveBeenCalledExactlyOnceWith('New reply');
    await h.conversation.submit();
    await h.conversation.onReply({ id: 'answer', text: 'New reply' });
    expect(h.speak).toHaveBeenCalledOnce();
    expect(h.conversation.getState()).toBe('waiting');
    await h.conversation.dispose();
  });

  it.each(['recognition', 'send', 'playback'] as const)('pauses on %s failure and keeps recognized speech', async (stage) => {
    const error = new Error(`${stage} failed`);
    const h = harness({
      ...(stage === 'recognition' ? { finishListening: vi.fn(async () => { throw error; }) } : {}),
      ...(stage === 'send' ? { send: vi.fn(async () => { throw error; }) } : {}),
      ...(stage === 'playback' ? { speak: vi.fn(async () => { throw error; }) } : {}),
    });
    await h.conversation.begin();
    h.conversation.onTranscriptChanged('Recognized message');
    await h.conversation.submit();
    if (stage === 'playback') await h.conversation.onReply({ id: 'reply', text: 'Answer' });
    expect(h.conversation.getState()).toBe('paused');
    expect(h.conversation.currentDraft()).toBe('Recognized message');
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.cancelListening).toHaveBeenCalledOnce();
    expect(h.stopSpeaking).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.startListening).toHaveBeenCalledOnce();
  });

  it('cancels a late microphone startup before a new activation may record', async () => {
    const starting = deferred<void>();
    const order: string[] = [];
    const startListening = vi.fn()
      .mockImplementationOnce(async () => { order.push('start-old'); await starting.promise; })
      .mockImplementationOnce(async () => { order.push('start-new'); });
    const h = harness({
      startListening,
      cancelListening: vi.fn(async () => { order.push('cancel'); }),
    });
    const first = h.conversation.begin();
    await vi.advanceTimersByTimeAsync(0);
    await h.conversation.stop();
    const second = h.conversation.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(startListening).toHaveBeenCalledOnce();
    starting.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['start-old', 'cancel', 'cancel', 'start-new']);
    expect(h.conversation.getState()).toBe('listening');
    await h.conversation.dispose();
  });

  it.each(['recognition', 'send', 'playback'] as const)('does not send, speak or reopen capture after disposal during %s', async (stage) => {
    const pending = deferred<void>();
    const h = harness({
      ...(stage === 'recognition' ? { finishListening: vi.fn(async () => { await pending.promise; return 'Late speech'; }) } : {}),
      ...(stage === 'send' ? { send: vi.fn(() => pending.promise) } : {}),
      ...(stage === 'playback' ? { speak: vi.fn(() => pending.promise) } : {}),
    });
    await h.conversation.begin();
    const submit = h.conversation.submit();
    await vi.advanceTimersByTimeAsync(0);
    const reply = h.conversation.onReply({ id: 'late-reply', text: 'Answer' });
    const disposal = h.conversation.dispose();
    pending.resolve();
    await Promise.all([submit, reply, disposal]);
    await h.conversation.begin();
    await h.conversation.onReply({ id: 'another-late-reply', text: 'Answer' });
    expect(h.conversation.getState()).toBe('idle');
    expect(h.startListening).toHaveBeenCalledOnce();
    if (stage === 'recognition') expect(h.send).not.toHaveBeenCalled();
    if (stage !== 'playback') expect(h.speak).not.toHaveBeenCalled();
  });

  it('resumes a transferred reply wait without opening the microphone before playback', async () => {
    const h = harness();
    await h.conversation.begin({ waiting: true, initialDraft: 'Sent on previous screen' });
    expect(h.startListening).not.toHaveBeenCalled();
    await h.conversation.onReply({ id: 'handoff-answer', text: 'Answer' });
    expect(h.speak).toHaveBeenCalledExactlyOnceWith('Answer');
    expect(h.startListening).toHaveBeenCalledOnce();
    await h.conversation.dispose();
  });

  it('ignores late adapter errors after the user stops or leaves the screen', async () => {
    const h = harness();
    await h.conversation.begin();
    await h.conversation.stop();
    await h.conversation.pause(new Error('Late recognition error'));
    await h.conversation.dispose();
    await h.conversation.pause(new Error('Late playback error'));
    expect(h.conversation.getState()).toBe('idle');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('holds disposal until a late native startup has released capture for the replacement screen', async () => {
    const starting = deferred<void>();
    const order: string[] = [];
    const h = harness({
      startListening: vi.fn(() => starting.promise),
      cancelListening: vi.fn(async () => { order.push('cancel'); }),
    });
    const begin = h.conversation.begin();
    await vi.advanceTimersByTimeAsync(0);
    const disposal = h.conversation.dispose().then(() => { order.push('replacement-ready'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['cancel']);
    starting.resolve();
    await Promise.all([begin, disposal]);
    expect(order).toEqual(['cancel', 'cancel', 'replacement-ready']);
  });
});
