import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VoiceConversationApi,
  VoiceConversationEvent,
  SpeechStartResult,
} from '@/../shared/voiceConversation';
import type { SpeechPlayer } from '../PcmSpeechPlayer';
import type { ChatMessage } from '@/lib/makerChatStore';
import { VoiceConversationController } from '../VoiceConversationController';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => log }));
beforeEach(() => vi.clearAllMocks());

const selection = { modelId: 'tts', voice: 'alloy' };
const user = (id = 'user-1'): ChatMessage =>
  ({ clientId: id, role: 'user', content: 'hello' }) as ChatMessage;
const reply = (id = 'reply-1'): ChatMessage =>
  ({ clientId: id, role: 'assistant', content: 'Hello back', turnCompleted: true }) as ChatMessage;
function fixture() {
  let listener: (event: VoiceConversationEvent) => void = () => {};
  let inputs = 0;
  let calls = 0;
  let inputGeneration = 0;
  const api = {
    models: vi.fn(async () => []),
    voices: vi.fn(async () => ({ source: 'manual' as const, voices: [] })),
    preview: vi.fn(async () => ({ sampleRate: 24000 })),
    readPreview: vi.fn(async () => ({ pcm: new ArrayBuffer(0), done: true })),
    stopPreview: vi.fn(async () => {}),
    preference: vi.fn(async () => ({ selection: null, customized: false })),
    setPreference: vi.fn(async () => ({ selection: null, customized: false })),
    start: vi.fn(async () => ({ callId: `call-${++calls}` })),
    startPlayback: vi.fn<VoiceConversationApi['startPlayback']>(async (input) => ({
      callId: input.callId,
    })),
    audio: vi.fn(),
    finishUtterance: vi.fn(async () => {}),
    setInputMuted: vi.fn<VoiceConversationApi['setInputMuted']>(async () => ({
      inputGeneration: ++inputGeneration,
    })),
    end: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    speak: vi.fn<VoiceConversationApi['speak']>(async () => ({ sampleRate: 24000 })),
    readSpeech: vi.fn<VoiceConversationApi['readSpeech']>(async () => ({
      pcm: new ArrayBuffer(0),
      done: true,
    })),
    onEvent: vi.fn((callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    }),
  } satisfies VoiceConversationApi;
  const microphone = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onPcm16k: vi.fn(),
  };
  const player = {
    play: vi.fn<SpeechPlayer['play']>(async (_read, _rate, onStarted) => {
      onStarted?.();
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  };
  const send = vi.fn(
    async (_text: string, created: (id: string) => void, current: () => boolean) => {
      if (!current()) return false;
      created(`user-${++inputs}`);
      return true;
    },
  );
  const createMicrophone = vi.fn<
    (
      onInterrupted: () => void,
      onStateChange: (event: string, details?: Record<string, unknown>) => void,
    ) => typeof microphone
  >(() => microphone);
  const controller = new VoiceConversationController({
    api,
    botId: 'bot',
    sessionId: 'task',
    microphone: createMicrophone,
    player: () => player,
    send,
  });
  const emit = (
    event: VoiceConversationEvent['event'],
    callId = `call-${calls}`,
    generation = inputGeneration,
  ) => listener({ callId, inputGeneration: generation, event });
  const utterance = (text = 'hello') => emit({ type: 'utterance', id: crypto.randomUUID(), text });
  return { controller, api, microphone, createMicrophone, player, send, emit, utterance };
}

const streamingReply = (content: string, complete = false): ChatMessage => ({
  ...reply(),
  content,
  assistantPhase: 'final_answer',
  isStreaming: !complete,
  turnCompleted: complete,
});

describe('sentence playback', () => {
  it('starts before turn completion, waits between sentences, and flushes the tail exactly once', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('第一句话。第二句还')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.api.speak.mock.calls[0][0]).toMatchObject({ text: '第一句话。', streaming: true });
    expect(f.controller.getSnapshot().phase).toBe('thinking');
    f.controller.updateMessages([user(), streamingReply('第一句话。第二句还')]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.controller.updateMessages([user(), streamingReply('第一句话。第二句还没结束')]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    const final = [user(), streamingReply('第一句话。第二句还没结束', true)];
    f.controller.updateMessages(final);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledTimes(2));
    expect(f.api.speak.mock.calls.map(([value]) => value.text)).toEqual([
      '第一句话。',
      '第二句还没结束',
    ]);
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.controller.updateMessages(final);
    expect(f.api.speak).toHaveBeenCalledTimes(2);
    f.controller.end();
  });

  it.each([false, true])(
    'waits for completion when playback is %s but phase is unknown',
    async (enabled) => {
      const f = fixture();
      await f.controller.start(selection, enabled);
      f.utterance();
      await Promise.resolve();
      await Promise.resolve();
      const content = '第一句话。第二句话。';
      f.controller.updateMessages([
        user(),
        { ...reply(), content, isStreaming: true, turnCompleted: false },
      ]);
      expect(f.api.speak).not.toHaveBeenCalled();
      if (!enabled) {
        f.controller.updateMessages([user(), streamingReply(content)]);
        expect(f.api.speak).not.toHaveBeenCalled();
      }
      f.controller.updateMessages([user(), streamingReply(content, true)]);
      await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
      expect(f.api.speak.mock.calls[0][0].text).toBe(content);
      f.controller.end();
    },
  );

  it('defers to the processed full reply when Main reports an outgoing hook', async () => {
    const f = fixture();
    f.api.speak.mockResolvedValueOnce({ deferred: true });
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('原文第一句话。后续')]);
    await vi.waitFor(() => expect(f.api.interrupt).toHaveBeenCalledTimes(2));
    expect(f.player.play).not.toHaveBeenCalled();
    f.controller.updateMessages([user(), streamingReply('原文第一句话。后续完成。')]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.controller.updateMessages([
      user(),
      { ...streamingReply('处理后的完整回复。', true), ghostReplyPending: true },
    ]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.controller.updateMessages([user(), streamingReply('处理后的完整回复。', true)]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.api.speak.mock.calls[1][0]).toMatchObject({ text: '处理后的完整回复。' });
    expect(f.api.speak.mock.calls[1][0].streaming).toBeUndefined();
    f.controller.end();
  });

  it('prefetches only one segment and drops pending audio on a committed interruption', async () => {
    const f = fixture();
    let finish!: () => void;
    f.player.play.mockImplementationOnce(async (_read, _rate, started) => {
      started?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('第一句话。')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.controller.updateMessages([user(), streamingReply('第一句话。第二句话。')]);
    f.controller.updateMessages([user(), streamingReply('第一句话。第二句话。第三句话。')]);
    expect(f.api.speak.mock.calls.map(([value]) => value.text)).toEqual([
      '第一句话。',
      '第二句话。',
    ]);
    f.emit({ type: 'speech-started' });
    f.utterance('a new question');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.player.play).toHaveBeenCalledOnce();
    expect(f.api.speak).toHaveBeenCalledTimes(2);
    f.controller.end();
  });

  it('plays prepared sentences in order, pauses lookahead, and listens only after the final tail drains', async () => {
    const f = fixture();
    const finishes: Array<() => void> = [];
    f.player.play.mockImplementation(async (read, _rate, started) => {
      await read();
      started?.();
      await new Promise<void>((resolve) => finishes.push(resolve));
    });
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('第一句。')]);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    f.controller.updateMessages([user(), streamingReply('第一句。第二句。')]);
    f.controller.updateMessages([user(), streamingReply('第一句。第二句。第三句。', true)]);
    expect(f.api.speak).toHaveBeenCalledTimes(2);
    f.emit({ type: 'speech-started' });
    finishes[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.api.speak).toHaveBeenCalledTimes(2);
    expect(f.player.play).toHaveBeenCalledOnce();
    f.emit({ type: 'speech-idle' });
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    expect(f.api.speak).toHaveBeenCalledTimes(3);
    expect(f.controller.getSnapshot().phase).toBe('speaking');
    finishes[1]();
    await vi.waitFor(() => expect(finishes).toHaveLength(3));
    expect(f.api.readSpeech.mock.calls.map((call) => call[1])).toEqual(
      f.api.speak.mock.calls.map(([request]) => request.requestId),
    );
    finishes[2]();
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('listening'));
    f.controller.end();
  });

  it('waits for deferred speech cleanup before replaying a final snapshot that arrived meanwhile', async () => {
    const f = fixture();
    f.api.speak.mockResolvedValueOnce({ deferred: true });
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    let cleaned!: () => void;
    f.api.interrupt.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          cleaned = resolve;
        }),
    );
    f.controller.updateMessages([user(), streamingReply('原文第一句。')]);
    await vi.waitFor(() => expect(f.api.interrupt).toHaveBeenCalledTimes(2));
    f.controller.updateMessages([user(), streamingReply('处理后的完整回复。', true)]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    cleaned();
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.api.speak.mock.calls[1][0].text).toBe('处理后的完整回复。');
    f.controller.end();
  });

  it('ignores a late cleanup failure after the user has started a new voice turn', async () => {
    const f = fixture();
    f.api.speak.mockResolvedValueOnce({ deferred: true });
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    let reject!: (error: Error) => void;
    f.api.interrupt.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    f.controller.updateMessages([user(), streamingReply('原文第一句。')]);
    await vi.waitFor(() => expect(f.api.interrupt).toHaveBeenCalledTimes(2));
    f.utterance('next question');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    reject(new Error('late cleanup'));
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), reply(), user('user-2'), reply('reply-2')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.controller.getSnapshot().error).toBeNull();
    f.controller.end();
  });

  it('does not synthesize a closing quote that arrives after a spoken sentence', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('她说：“你好。')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.controller.updateMessages([user(), streamingReply('她说：“你好。”', true)]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.controller.end();
  });

  it('cancels queued audio if a full-text correction replaces the spoken prefix', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), streamingReply('最初的答案。')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.controller.updateMessages([user(), streamingReply('更正后的答案。', true)]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().phase).toBe('listening');
    expect(f.api.interrupt).toHaveBeenCalledTimes(2);
    f.controller.end();
  });
});

describe('companion voice loop', () => {
  it('sends speech through the existing task, reads only its final reply, then listens again', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.controller.updateMessages([reply('history')]);
    expect(f.api.speak).not.toHaveBeenCalled();
    f.utterance();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await Promise.resolve();
    f.controller.updateMessages([user(), { ...reply(), isStreaming: true }]);
    expect(f.api.speak).not.toHaveBeenCalled();
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.api.speak).toHaveBeenCalledWith({
      callId: 'call-1',
      requestId: expect.any(String),
      text: 'Hello back',
    });
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.controller.updateMessages([user(), reply()]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.utterance('next');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.api.start).toHaveBeenCalledOnce();
    f.controller.end();
    expect(f.microphone.stop).toHaveBeenCalledOnce();
  });

  it('pauses on acoustic onset and cancels pending TTS only when a new utterance commits', async () => {
    const f = fixture();
    let finish!: (value: SpeechStartResult) => void;
    f.api.speak.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), reply()]);
    expect(f.api.speak).toHaveBeenCalledOnce();
    const interruptions = f.api.interrupt.mock.calls.length;
    f.emit({ type: 'speech-started' });
    expect(f.player.pause).toHaveBeenCalledOnce();
    expect(f.api.interrupt).toHaveBeenCalledTimes(interruptions);
    f.utterance('actually, another question');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.api.interrupt).toHaveBeenCalledTimes(interruptions + 1);
    finish({ sampleRate: 24000 });
    await Promise.resolve();
    expect(f.player.play).not.toHaveBeenCalled();
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.end();
  });

  it('stops the microphone for a permission prompt and requires explicit resume', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.emit({ type: 'draft', text: 'not sent yet' });
    f.controller.setBlocked(true);
    f.utterance();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'paused', unsent: 'not sent yet' });
    f.controller.setBlocked(false);
    expect(f.api.start).toHaveBeenCalledOnce();
    await f.controller.start(selection);
    expect(f.api.start).toHaveBeenCalledTimes(2);
    f.controller.end();
  });

  it('stops listening and preserves rejected input plus unsent queued speech', async () => {
    const f = fixture();
    let reject!: (value: boolean) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reject = resolve;
        }),
    );
    await f.controller.start(selection);
    f.utterance('first');
    f.utterance('second');
    reject(false);
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('error'));
    expect(f.controller.getSnapshot().unsent).toBe('first second');
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('cancels a pending start, then waits for teardown before opening another call', async () => {
    const f = fixture();
    let resolve!: (value: { callId: string }) => void;
    f.api.start.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = f.controller.start(selection);
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalledOnce());
    f.controller.end();
    const second = f.controller.start(selection);
    resolve({ callId: 'cancelled-call' });
    await first;
    await second;
    expect(f.api.end).toHaveBeenCalledWith('cancelled-call');
    expect(f.microphone.start).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('ends capture when the main process revokes call ownership', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.emit({ type: 'ended' });
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().phase).toBe('idle');
  });

  it('keeps a delayed send acknowledgement through a false onset and reads its final reply after quiet', async () => {
    const f = fixture();
    let done!: () => void;
    f.send.mockImplementationOnce(async (_text, created) => {
      created('old-user');
      await new Promise<void>((resolve) => {
        done = resolve;
      });
      return true;
    });
    await f.controller.start(selection);
    f.utterance();
    f.emit({ type: 'speech-started' });
    done();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user('old-user'), reply()]);
    expect(f.api.speak).not.toHaveBeenCalled();
    f.emit({ type: 'speech-idle' });
    await vi.waitFor(() => expect(f.api.speak).toHaveBeenCalledOnce());
    expect(f.player.resume).toHaveBeenCalled();
    f.controller.end();
  });

  it('reads the first final reply after a noise-only onset and still reads the next turn', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.emit({ type: 'speech-started' });
    f.controller.updateMessages([user(), reply()]);
    expect(f.api.speak).not.toHaveBeenCalled();
    f.emit({ type: 'draft', text: '' });
    f.emit({ type: 'speech-idle' });
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.emit({ type: 'speech-idle' });
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.utterance('next question');
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), reply(), user('user-2'), reply('reply-2')]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledTimes(2));
    expect(f.controller.getSnapshot().error).toBeNull();
    // Existing logger receives identifiers and counts, never voice/reply text.
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('next question');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('Hello back');
    f.controller.end();
  });

  it('resumes an already playing reply after empty speech without requesting synthesis again', async () => {
    const f = fixture();
    let played!: () => void;
    f.player.play.mockImplementationOnce(
      (_read, _rate, onStarted) =>
        new Promise<void>((resolve) => {
          onStarted?.();
          played = resolve;
        }),
    );
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.emit({ type: 'speech-started' });
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.emit({ type: 'speech-idle' });
    expect(f.player.resume).toHaveBeenCalled();
    expect(f.controller.getSnapshot().phase).toBe('speaking');
    expect(f.api.speak).toHaveBeenCalledOnce();
    played();
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('listening'));
    f.controller.end();
  });

  it.each(['permission', 'end'] as const)(
    'does not resume a held reply across the %s boundary',
    async (boundary) => {
      const f = fixture();
      await f.controller.start(selection);
      f.utterance();
      await Promise.resolve();
      await Promise.resolve();
      f.emit({ type: 'speech-started' });
      if (boundary === 'permission') f.controller.setBlocked(true);
      else f.controller.end();
      f.emit({ type: 'speech-idle' });
      f.controller.updateMessages([user(), reply()]);
      expect(f.api.speak).not.toHaveBeenCalled();
      expect(f.player.close).toHaveBeenCalled();
      f.controller.end();
    },
  );

  it('does not restore reply ownership after an explicit stop before send acknowledgement', async () => {
    const f = fixture();
    let done!: () => void;
    f.send.mockImplementationOnce(async (_text, created) => {
      created('old-user');
      await new Promise<void>((resolve) => {
        done = resolve;
      });
      return true;
    });
    await f.controller.start(selection);
    f.utterance();
    f.emit({ type: 'speech-started' });
    f.controller.interrupt();
    done();
    await Promise.resolve();
    await Promise.resolve();
    f.emit({ type: 'speech-idle' });
    f.controller.updateMessages([user('old-user'), reply()]);
    expect(f.api.speak).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.controller.end();
  });

  it('preserves speech rejected at a permission boundary and waits for preflight before resuming', async () => {
    const f = fixture();
    let finish!: () => void;
    f.send.mockImplementationOnce(async (_text, _created, current) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return current();
    });
    await f.controller.start(selection);
    f.utterance('not enqueued');
    f.controller.setBlocked(true);
    f.controller.setBlocked(false);
    const resumed = f.controller.start(selection);
    await Promise.resolve();
    expect(f.api.start).toHaveBeenCalledOnce();
    finish();
    await resumed;
    expect(f.controller.getSnapshot().unsent).toBe('not enqueued');
    f.controller.retryUnsent();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls[1][0]).toBe('not enqueued');
    expect(f.controller.getSnapshot().unsent).toBe('');
    f.controller.end();
  });

  it('resumes listening for an answer with no spoken prose or an intervening input from another surface', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), { ...reply(), content: '```ts\nconst a = 1;\n```' }]);
    expect(f.controller.getSnapshot().phase).toBe('listening');
    expect(f.api.speak).not.toHaveBeenCalled();
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user('user-2'), user('external'), reply()]);
    expect(f.controller.getSnapshot().phase).toBe('listening');
    expect(f.api.speak).not.toHaveBeenCalled();
    f.controller.end();
  });
});

it('keeps the ordinary final text and stops voice on a BYOK synthesis failure without fallback or resend', async () => {
  const f = fixture();
  f.api.speak.mockRejectedValueOnce(new Error('upstream error'));
  await f.controller.start({
    ...selection,
    providerId: 'byok',
    agent: 'codex',
    protocol: 'openai',
  });
  f.utterance();
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  await Promise.resolve();
  const messages = [user(), reply()];
  f.controller.updateMessages(messages);
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('error'));
  expect(f.controller.getSnapshot().error).toBe('speech');
  expect(f.microphone.stop).toHaveBeenCalledOnce();
  expect(messages[1]).toEqual(reply());
  expect(f.api.start).toHaveBeenCalledOnce();
  expect(f.api.speak).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
  f.controller.end();
});

describe('microphone-only mute', () => {
  it('keeps the same call and spoken reply running, and rejects stale input after unmute', async () => {
    const f = fixture();
    let finished!: () => void;
    f.player.play.mockImplementation(async (_read, _rate, started) => {
      started?.();
      await new Promise<void>((resolve) => {
        finished = resolve;
      });
    });
    await f.controller.start(selection);
    const oldPcm = f.microphone.onPcm16k.mock.calls[0][0];
    f.utterance();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('speaking'));
    f.player.cancel.mockClear();
    f.api.interrupt.mockClear();
    const muted = f.controller.toggleMute();
    f.emit({ type: 'error', text: 'late input error' }, 'call-1', 0);
    oldPcm({ pcm16k: new ArrayBuffer(2) });
    await muted;
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'speaking',
      muted: true,
      microphonePending: false,
      microphoneError: false,
    });
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.api.setInputMuted).toHaveBeenCalledWith('call-1', true);
    f.emit({ type: 'speech-started' });
    f.utterance('ignored while muted');
    expect(f.player.pause).not.toHaveBeenCalled();
    expect(f.api.audio).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.api.end).not.toHaveBeenCalled();
    expect(f.api.interrupt).not.toHaveBeenCalled();
    expect(f.player.cancel).not.toHaveBeenCalled();
    expect(f.player.close).not.toHaveBeenCalled();
    await f.controller.toggleMute();
    expect(f.api.start).toHaveBeenCalledOnce();
    expect(f.microphone.start).toHaveBeenCalledTimes(2);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'speaking', muted: false });
    f.emit({ type: 'utterance', id: 'old', text: 'stale' }, 'call-1', 0);
    oldPcm({ pcm16k: new ArrayBuffer(2) });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.api.audio).not.toHaveBeenCalled();
    const newPcm = f.microphone.onPcm16k.mock.calls[1][0];
    newPcm({ pcm16k: new ArrayBuffer(2) });
    expect(f.api.audio).toHaveBeenCalledWith({
      callId: 'call-1',
      inputGeneration: 2,
      pcm: expect.any(ArrayBuffer),
    });
    finished();
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('listening'));
    f.utterance('next');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    f.controller.end();
  });

  it('keeps listening to the reply when microphone context cleanup rejects', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.microphone.stop.mockRejectedValueOnce(new Error('context already closed'));
    await f.controller.toggleMute();
    expect(f.controller.getSnapshot()).toMatchObject({
      muted: true,
      error: null,
      microphonePending: false,
    });
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(log.warn).toHaveBeenCalledWith('microphone cleanup failed', { callId: 'call-1' });
    f.controller.end();
  });

  it('resumes a noise-held reply on mute and keeps reading sentences received while muted', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    f.emit({ type: 'speech-started' });
    f.controller.updateMessages([user(), streamingReply('第一句。')]);
    expect(f.api.speak).not.toHaveBeenCalled();
    await f.controller.toggleMute();
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.player.resume).toHaveBeenCalled();
    f.controller.updateMessages([user(), streamingReply('第一句。第二句。', true)]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledTimes(2));
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'listening', muted: true });
    expect(f.api.end).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'reply resumed on microphone mute',
      expect.objectContaining({ heldMs: expect.any(Number) }),
    );
    f.controller.end();
  });

  it('tracks an already accepted task whose acknowledgement arrives after mute', async () => {
    const f = fixture();
    let accepted!: () => void;
    f.send.mockImplementationOnce(async (_text, created) => {
      created('user-1');
      await new Promise<void>((resolve) => {
        accepted = resolve;
      });
      return true;
    });
    await f.controller.start(selection);
    f.utterance();
    await f.controller.toggleMute();
    accepted();
    await Promise.resolve();
    await Promise.resolve();
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    expect(f.controller.getSnapshot().unsent).toBe('');
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it.each(['reject', 'throw'] as const)(
    'retains cancelled preflight on mute (%s) and only sends on explicit retry',
    async (outcome) => {
      const f = fixture();
      let finish!: () => void;
      f.send.mockImplementationOnce(async (_text, _created, current) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        expect(current()).toBe(false);
        if (outcome === 'throw') throw new Error('cancelled');
        return false;
      });
      await f.controller.start(selection);
      f.utterance('not enqueued');
      await f.controller.toggleMute();
      finish();
      await vi.waitFor(() => expect(f.controller.getSnapshot().unsent).toBe('not enqueued'));
      expect(f.controller.getSnapshot()).toMatchObject({
        phase: 'listening',
        muted: true,
        error: null,
      });
      expect(f.send).toHaveBeenCalledOnce();
      f.controller.retryUnsent();
      f.controller.retryUnsent();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
      expect(f.send.mock.calls[1][0]).toBe('not enqueued');
      expect(f.controller.getSnapshot().unsent).toBe('');
      f.controller.end();
    },
  );

  it('joins late rejected preflight text to speech already queued after unmute', async () => {
    const f = fixture();
    let finish!: () => void;
    f.send.mockImplementationOnce(async (_text, _created, current) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return current();
    });
    await f.controller.start(selection);
    f.utterance('first part');
    await f.controller.toggleMute();
    await f.controller.toggleMute();
    f.utterance('second part');
    finish();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls[1][0]).toBe('first part second part');
    expect(f.controller.getSnapshot().unsent).toBe('');
    f.controller.end();
  });

  it('preserves a draft on mute without sending it on unmute, then joins it to continued speech', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.emit({ type: 'draft', text: 'first part' });
    await f.controller.toggleMute();
    expect(f.controller.getSnapshot()).toMatchObject({ transcript: '', unsent: 'first part' });
    await f.controller.toggleMute();
    expect(f.send).not.toHaveBeenCalled();
    f.utterance('second part');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.send.mock.calls[0][0]).toBe('first part second part');
    f.controller.end();
  });

  it.each(['asr', 'microphone', 'interruption'] as const)(
    'keeps the reply available after failed %s unmute and allows retry',
    async (failure) => {
      const f = fixture();
      await f.controller.start(selection);
      f.utterance();
      await Promise.resolve();
      await Promise.resolve();
      await f.controller.toggleMute();
      if (failure === 'asr') f.api.setInputMuted.mockRejectedValueOnce(new Error('offline'));
      else if (failure === 'microphone')
        f.microphone.start.mockRejectedValueOnce(new Error('denied'));
      else
        f.microphone.start.mockImplementationOnce(async () => {
          f.createMicrophone.mock.calls.at(-1)![0]();
        });
      await f.controller.toggleMute();
      expect(f.controller.getSnapshot()).toMatchObject({
        phase: 'thinking',
        muted: true,
        microphoneError: true,
        microphonePending: false,
      });
      expect(f.api.end).not.toHaveBeenCalled();
      expect(f.player.close).not.toHaveBeenCalled();
      f.controller.updateMessages([user(), reply()]);
      await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
      await f.controller.toggleMute();
      expect(f.controller.getSnapshot()).toMatchObject({ muted: false, microphoneError: false });
      f.controller.end();
    },
  );

  it('does not report listening when resumed ASR fails during microphone startup', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await Promise.resolve();
    await Promise.resolve();
    await f.controller.toggleMute();
    let ready!: () => void;
    f.microphone.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const opening = f.controller.toggleMute();
    await vi.waitFor(() => expect(f.microphone.start).toHaveBeenCalledTimes(2));
    f.emit({ type: 'error', text: '' });
    ready();
    await opening;
    expect(f.controller.getSnapshot()).toMatchObject({
      muted: true,
      microphoneError: true,
      microphonePending: false,
    });
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.updateMessages([user(), reply()]);
    await vi.waitFor(() => expect(f.player.play).toHaveBeenCalledOnce());
    f.controller.end();
  });

  it.each(['end', 'permission'] as const)(
    'disposes a late microphone obtained during unmute after %s',
    async (boundary) => {
      const f = fixture();
      await f.controller.start(selection);
      await f.controller.toggleMute();
      let ready!: () => void;
      f.microphone.start.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      );
      const opening = f.controller.toggleMute();
      await vi.waitFor(() => expect(f.microphone.start).toHaveBeenCalledTimes(2));
      expect(f.controller.getSnapshot()).toMatchObject({ muted: true, microphonePending: true });
      const duplicate = f.controller.toggleMute();
      expect(duplicate).toBe(opening);
      if (boundary === 'end') f.controller.end();
      else f.controller.setBlocked(true);
      const stopped = f.microphone.stop.mock.calls.length;
      ready();
      await opening;
      expect(f.microphone.stop).toHaveBeenCalledTimes(stopped + 1);
      expect(f.controller.getSnapshot()).toMatchObject({
        phase: boundary === 'end' ? 'idle' : 'paused',
        microphonePending: false,
      });
      expect(f.api.start).toHaveBeenCalledOnce();
    },
  );

  it('logs safe capture settings, first-frame timing, and phases through the existing logger', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.createMicrophone.mock.calls[0][1]('stream_started', {
      tracks: [
        {
          label: 'private mic',
          settings: {
            deviceId: 'secret-device',
            groupId: 'secret-group',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
          },
        },
      ],
    });
    f.microphone.onPcm16k.mock.calls[0][0]({ pcm16k: new ArrayBuffer(2) });
    f.microphone.onPcm16k.mock.calls[0][0]({ pcm16k: new ArrayBuffer(2) });
    expect(log.info).toHaveBeenCalledWith(
      'microphone capture',
      expect.objectContaining({
        event: 'stream_started',
        tracks: [
          {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 1,
            latency: null,
          },
        ],
      }),
    );
    expect(
      log.info.mock.calls.filter(([event]) => event === 'microphone first frame'),
    ).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      'phase changed',
      expect.objectContaining({
        from: 'connecting',
        to: 'microphone',
        elapsedMs: expect.any(Number),
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      'phase changed',
      expect.objectContaining({ from: 'microphone', to: 'listening' }),
    );
    for (const secret of ['private mic', 'secret-device', 'secret-group'])
      expect(JSON.stringify(log.info.mock.calls)).not.toContain(secret);
    f.controller.end();
  });
});
