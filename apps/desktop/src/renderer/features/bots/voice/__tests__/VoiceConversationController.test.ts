import { describe, expect, it, vi } from 'vitest';
import type { VoiceConversationApi, VoiceConversationEvent } from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import { VoiceConversationController } from '../VoiceConversationController';

const selection = { modelId: 'tts', voice: 'alloy' };
const user = (id = 'user-1'): ChatMessage =>
  ({ clientId: id, role: 'user', content: 'hello' }) as ChatMessage;
const reply = (id = 'reply-1'): ChatMessage =>
  ({ clientId: id, role: 'assistant', content: 'Hello back', turnCompleted: true }) as ChatMessage;
function fixture() {
  let listener: (event: VoiceConversationEvent) => void = () => {};
  let inputs = 0;
  let calls = 0;
  const api = {
    models: vi.fn(async () => []),
    start: vi.fn(async () => ({ callId: `call-${++calls}` })),
    audio: vi.fn(),
    finishUtterance: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    speak: vi.fn(async () => ({ sampleRate: 24000 })),
    readSpeech: vi.fn(async () => ({ pcm: new ArrayBuffer(0), done: true })),
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
  const player = { play: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn() };
  const send = vi.fn(
    async (_text: string, created: (id: string) => void, current: () => boolean) => {
      if (!current()) return false;
      created(`user-${++inputs}`);
      return true;
    },
  );
  const controller = new VoiceConversationController({
    api,
    botId: 'bot',
    sessionId: 'task',
    microphone: () => microphone,
    player: () => player,
    send,
  });
  const emit = (event: VoiceConversationEvent['event'], callId = `call-${calls}`) =>
    listener({ callId, event });
  const utterance = (text = 'hello') => emit({ type: 'utterance', id: crypto.randomUUID(), text });
  return { controller, api, microphone, player, send, emit, utterance };
}

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

  it('interrupts pending TTS immediately and discards its late response without stopping the task', async () => {
    const f = fixture();
    let finish!: (value: { sampleRate: number }) => void;
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
    f.emit({ type: 'speech-started' });
    expect(f.player.cancel).toHaveBeenCalled();
    expect(f.api.interrupt).toHaveBeenCalledWith('call-1');
    finish({ sampleRate: 24000 });
    await Promise.resolve();
    expect(f.player.play).not.toHaveBeenCalled();
    f.utterance('actually, another question');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
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

  it('an interruption before a delayed send acknowledgement does not resurrect its old reply', async () => {
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
