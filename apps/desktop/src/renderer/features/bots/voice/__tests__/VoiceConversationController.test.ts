import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VoiceConversationApi,
  VoiceConversationEvent,
  SpeechStartResult,
} from '@/../shared/voiceConversation';
import type { SpeechPlayer } from '../PcmSpeechPlayer';
import type { ChatMessage } from '@/lib/makerChatStore';
import { VoiceConversationController } from '../VoiceConversationController';
import type { VoiceQuestionTarget } from '@/components/new-chat/voiceQuestionSelection';

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
    start: vi.fn<VoiceConversationApi['start']>(async () => ({ callId: `call-${++calls}` })),
    startPlayback: vi.fn<VoiceConversationApi['startPlayback']>(async (input) => ({
      callId: input.callId,
    })),
    classifyExit: vi.fn<VoiceConversationApi['classifyExit']>(async () => false),
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
  const taskBusy = vi.fn(() => false);
  const onAutoEnd = vi.fn();
  const questionPending = vi.fn(() => false);
  const questionTarget = vi.fn<() => VoiceQuestionTarget | null>(() => null);
  const controller = new VoiceConversationController({
    api,
    botId: 'bot',
    sessionId: 'task',
    microphone: createMicrophone,
    player: () => player,
    send,
    isTaskBusy: taskBusy,
    isQuestionPending: questionPending,
    getQuestionTarget: questionTarget,
    onAutoEnd,
  });
  const emit = (
    event: VoiceConversationEvent['event'],
    callId = `call-${calls}`,
    generation = inputGeneration,
  ) => listener({ callId, inputGeneration: generation, event });
  const utterance = (text = 'hello') => emit({ type: 'utterance', id: crypto.randomUUID(), text });
  return {
    controller,
    api,
    microphone,
    createMicrophone,
    player,
    send,
    emit,
    utterance,
    taskBusy,
    onAutoEnd,
    questionPending,
    questionTarget,
  };
}

describe('independent call transcript and task acceptance', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays the first call sentence without sending an ordinary main-task message', async () => {
    const f = fixture();
    const submit = vi.fn<NonNullable<VoiceConversationApi['submitTurn']>>(async () => true);
    Object.assign(f.api, { submitTurn: submit });
    await f.controller.start(selection);
    f.utterance('Say hello.');
    await vi.advanceTimersByTimeAsync(0);
    const id = submit.mock.calls[0][1];
    f.emit({ type: 'call-record', record: {
      version: 1, callId: 'call-1', startedAt: 0, handoffs: [],
      turns: [
        { id, role: 'user', text: 'Say hello.', createdAt: 1, complete: true },
        { id: `${id}:reply`, role: 'assistant', text: 'Hello there.', createdAt: 2, complete: true },
      ],
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.api.speak).toHaveBeenCalledOnce();
    expect(f.api.speak.mock.calls[0][0].text).toBe('Hello there.');
    expect(f.controller.getSnapshot().callRecord?.turns).toHaveLength(2);
    f.controller.end();
  });

  it('keeps a failed call input for retry without dispatching it into the main task', async () => {
    const f = fixture();
    const submit = vi.fn<NonNullable<VoiceConversationApi['submitTurn']>>(async () => true);
    Object.assign(f.api, { submitTurn: submit });
    await f.controller.start(selection);
    f.utterance('Remember this original sentence.');
    await vi.advanceTimersByTimeAsync(0);
    const id = submit.mock.calls[0][1];
    f.emit({ type: 'call-record', record: {
      version: 1, callId: 'call-1', startedAt: 0, handoffs: [],
      turns: [{ id, role: 'user', text: 'Remember this original sentence.', createdAt: 1, complete: true, failed: true }],
    } });
    expect(f.controller.getSnapshot().unsent).toBe('Remember this original sentence.');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().phase).toBe('error');
    expect(f.api.end).toHaveBeenCalledWith('call-1'); // Reuse ordinary failure cleanup.
    f.controller.end();
  });

  it('does not end a compound call before the main task acknowledges its handoff', async () => {
    const f = fixture();
    let accept!: (ok: boolean) => void;
    const submit = vi.fn<NonNullable<VoiceConversationApi['submitTurn']>>(async () => true);
    const promote = vi.fn<NonNullable<VoiceConversationApi['promoteTurn']>>(() => new Promise(resolve => { accept = resolve; }));
    Object.assign(f.api, { submitTurn: submit, promoteTurn: promote });
    f.api.classifyExit.mockResolvedValue('submit_then_exit');
    await f.controller.start(selection);
    f.utterance('帮我用三条列出整理桌面的步骤，然后退出语音模式。');
    await vi.advanceTimersByTimeAsync(0);
    expect(promote).toHaveBeenCalledWith('call-1', submit.mock.calls[0][1]);
    expect(f.controller.getSnapshot().exitCountdown?.waitingForSend).toBe(true);
    expect(f.api.end).not.toHaveBeenCalled();
    accept(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('cancel exit keeps a successfully handed-off task without closing the call', async () => {
    const f = fixture();
    let accept!: (ok: boolean) => void;
    const submit = vi.fn<NonNullable<VoiceConversationApi['submitTurn']>>(async () => true);
    const promote = vi.fn<NonNullable<VoiceConversationApi['promoteTurn']>>(() => new Promise(resolve => { accept = resolve; }));
    Object.assign(f.api, { submitTurn: submit, promoteTurn: promote });
    f.api.classifyExit.mockResolvedValue('submit_then_exit');
    await f.controller.start(selection);
    f.utterance('帮我整理桌面，然后退出语音模式。');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.cancelExit();
    accept(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.end).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('returns to listening after task acceptance, queues a result behind the current answer and speaks it once', async () => {
    const f = fixture();
    const submit = vi.fn<NonNullable<VoiceConversationApi['submitTurn']>>(async () => true);
    Object.assign(f.api, { submitTurn: submit });
    await f.controller.start(selection);
    f.utterance('Research this.');
    await vi.advanceTimersByTimeAsync(0);
    const first = submit.mock.calls[0][1];
    const record: import('@cindy/maker-core').VoiceCallRecord = {
      version: 1, callId: 'call-1', startedAt: 0,
      handoffs: [{ id: 'task', inputId: first, text: 'Research this.', state: 'accepted' }],
      turns: [{ id: first, role: 'user', text: 'Research this.', createdAt: 1, complete: true }],
    };
    f.emit({ type: 'call-record', record: structuredClone(record) });
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.utterance('Tell me something.');
    await vi.advanceTimersByTimeAsync(0);
    const second = submit.mock.calls[1][1];
    let finish!: () => void;
    f.player.play.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    record.turns.push(
      { id: second, role: 'user', text: 'Tell me something.', createdAt: 2, complete: true },
      { id: `${second}:reply`, role: 'assistant', text: 'Here is your answer.', createdAt: 3, complete: true },
    );
    f.emit({ type: 'call-record', record: structuredClone(record) });
    await vi.advanceTimersByTimeAsync(0);
    record.handoffs[0].state = 'completed';
    record.turns.push({ id: `${first}:reply:result`, role: 'assistant', text: 'The research is ready.', createdAt: 4, complete: true });
    f.emit({ type: 'call-record', record: structuredClone(record) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.speak).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.speak.mock.calls.map(([input]) => input.text)).toEqual(['Here is your answer.', 'The research is ready.']);
    f.emit({ type: 'call-record', record: structuredClone(record) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.speak).toHaveBeenCalledTimes(2);
    f.controller.end();
  });
});

describe('ordinary question routing in a live voice call', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps capture, holds playback, answers without chat/classification and reads the continued reply', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await vi.advanceTimersByTimeAsync(0);
    const target = { receive: vi.fn() };
    f.questionPending.mockReturnValue(true);
    f.questionTarget.mockReturnValue(target);
    f.controller.refreshQuestion();
    f.controller.updateMessages([user(), reply()]);
    await vi.advanceTimersByTimeAsync(71_000);
    expect(f.api.speak).not.toHaveBeenCalled();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    expect(f.microphone.stop).not.toHaveBeenCalled();
    expect(f.api.end).not.toHaveBeenCalled();
    f.api.classifyExit.mockClear();
    f.emit({ type: 'speech-started' });
    f.emit({ type: 'draft', text: '第一项' });
    f.utterance('第一项');
    expect(target.receive).toHaveBeenCalledExactlyOnceWith('第一项');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.api.classifyExit).not.toHaveBeenCalled();
    f.questionPending.mockReturnValue(false);
    f.questionTarget.mockReturnValue(null);
    f.controller.refreshQuestion();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.speak).toHaveBeenCalledOnce();
    expect(f.microphone.start).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it.each(['step', 'dismiss', 'new-question'] as const)('does not retarget speech after %s', async (change) => {
    const f = fixture();
    const first = { receive: vi.fn() };
    const second = { receive: vi.fn() };
    await f.controller.start(selection);
    f.questionPending.mockReturnValue(change !== 'new-question');
    f.questionTarget.mockReturnValue(change === 'new-question' ? null : first);
    f.emit({ type: 'speech-started' });
    f.emit({ type: 'draft', text: '第一' });
    f.questionPending.mockReturnValue(change !== 'dismiss');
    f.questionTarget.mockReturnValue(change === 'dismiss' ? null : second);
    f.controller.refreshQuestion();
    f.utterance('第一项');
    expect(first.receive).not.toHaveBeenCalled();
    expect(second.receive).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.api.classifyExit).not.toHaveBeenCalled();
    f.controller.end();
  });

  it('keeps permission blocking and local exit commands intact', async () => {
    const f = fixture();
    const target = { receive: vi.fn() };
    await f.controller.start(selection);
    f.questionPending.mockReturnValue(true);
    f.questionTarget.mockReturnValue(target);
    f.controller.refreshQuestion();
    f.controller.setBlocked(true);
    f.utterance('第一项');
    expect(target.receive).not.toHaveBeenCalled();
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().phase).toBe('paused');
    f.controller.setBlocked(false);
    await f.controller.start(selection);
    f.utterance('退出语音模式');
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(target.receive).not.toHaveBeenCalled();
  });

  it('never sends a retained partial choice as ordinary chat after mute and dismissal', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.questionPending.mockReturnValue(true);
    const target = { receive: vi.fn() };
    f.questionTarget.mockReturnValue(target);
    f.emit({ type: 'draft', text: '第一项' });
    await f.controller.toggleMute();
    expect(f.controller.getSnapshot()).toMatchObject({ unsent: '', questionDraft: '第一项' });
    f.questionPending.mockReturnValue(false);
    f.questionTarget.mockReturnValue(null);
    f.controller.retryUnsent();
    expect(f.send).not.toHaveBeenCalled();
    expect(target.receive).not.toHaveBeenCalled();
    f.controller.end();
  });

  it('retains an ordinary input if a question arrives during send preflight', async () => {
    const f = fixture();
    let dispatch!: () => void;
    f.send.mockImplementationOnce((_text, _created, current) => new Promise((resolve) => {
      dispatch = () => resolve(current());
    }));
    await f.controller.start(selection);
    f.utterance('保留这条普通消息');
    f.questionPending.mockReturnValue(true);
    f.controller.refreshQuestion();
    dispatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().unsent).toBe('保留这条普通消息');
    f.controller.retryUnsent();
    expect(f.controller.getSnapshot().unsent).toBe('保留这条普通消息');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.microphone.stop).not.toHaveBeenCalled();
    f.questionPending.mockReturnValue(false);
    f.controller.refreshQuestion();
    f.controller.retryUnsent();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.lastCall?.[0]).toBe('保留这条普通消息');
    f.controller.end();
  });

  it('keeps a failed chat input separate from a partial question answer across mute', async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce(false);
    await f.controller.start(selection);
    f.utterance('保留原消息');
    await vi.advanceTimersByTimeAsync(0);
    f.questionPending.mockReturnValue(true);
    const target = { receive: vi.fn() };
    f.questionTarget.mockReturnValue(target);
    await f.controller.start(selection);
    f.emit({ type: 'draft', text: '第二项' });
    await f.controller.toggleMute();
    expect(f.controller.getSnapshot()).toMatchObject({ unsent: '保留原消息', questionDraft: '第二项' });
    f.controller.retryUnsent();
    expect(target.receive).toHaveBeenCalledExactlyOnceWith('第二项');
    expect(f.controller.getSnapshot().unsent).toBe('保留原消息');
    f.questionPending.mockReturnValue(false);
    f.questionTarget.mockReturnValue(null);
    f.controller.refreshQuestion();
    f.controller.retryUnsent();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send.mock.calls.map((call) => call[0])).toEqual(['保留原消息', '保留原消息']);
    f.controller.end();
  });
});

// Production entry: controller + ASR events. Contract: companion-voice-mode.md
// automatic exits; prior coverage checked manual teardown, not idle/intent exits.
// Minimal regression: an unused open call stays open after 60s + 10s. Unit tier,
// fake time and in-memory audio/API; no live microphone, tasks or provider requests.
// Standalone vitest run: 2.58s wall time, including the existing playback/mute cases.
describe('automatic voice exit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Acceptance regression: semantic HTTP latency previously blocked dispatch.
  // Real controller + final ASR event, deferred verdict/acceptance and fake time
  // exercise independent sending, TTS and cancellation without external calls.
  // Unit tier; this file runs in about 3 seconds locally.
  it('dispatches immediately and keeps subsequent sends and TTS independent of a pending classifier', async () => {
    const f = fixture();
    let resolve!: (value: boolean) => void;
    f.api.classifyExit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.controller.start(selection);
    f.utterance('请给我一个建议');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toBe('请给我一个建议');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.updateMessages([user(), reply()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.speak).toHaveBeenCalledOnce();
    f.utterance('再解释一下');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send.mock.calls.map((call) => call[0])).toEqual(['请给我一个建议', '再解释一下']);
    resolve(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.controller.end();
  });

  it.each([true, 'submit_then_exit'] as const)(
    'applies late %s only to the already accepted message without resending it',
    async (decision) => {
      const f = fixture();
      let resolve!: (value: typeof decision) => void;
      f.api.classifyExit.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await f.controller.start(selection);
      f.utterance('请继续工作，我先离开了');
      expect(f.send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      f.taskBusy.mockReturnValue(true);
      resolve(decision);
      await vi.advanceTimersByTimeAsync(0);
      if (decision === true) {
        expect(f.controller.getSnapshot().exitCountdown?.secondsRemaining).toBe(3);
        expect(f.onAutoEnd).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3_000);
      }
      expect(f.onAutoEnd).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.taskBusy()).toBe(true);
    },
  );

  it('waits for acceptance before starting a pure semantic countdown', async () => {
    const f = fixture();
    f.api.classifyExit.mockResolvedValue(true);
    let accept!: () => void;
    f.send.mockImplementation(async (_text, created) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      created('input');
      return true;
    });
    await f.controller.start(selection);
    f.utterance('我想先离开了');
    expect(f.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().exitCountdown?.secondsRemaining).toBe(3);
    f.controller.cancelExit();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().unsent).toBe('');
    f.controller.end();
  });

  it('does not revive a background verdict after an explicit cancel before it returned', async () => {
    const f = fixture();
    let resolve!: (value: 'submit_then_exit') => void;
    f.api.classifyExit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.controller.start(selection);
    f.utterance('帮我写计划，然后结束语音');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.cancelExit();
    resolve('submit_then_exit');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('sends first and then offers a cancellable countdown for semantic exit', async () => {
    const f = fixture();
    f.api.classifyExit.mockResolvedValue(true);
    await f.controller.start(selection);
    f.utterance('今天先聊到这里吧');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.classifyExit).toHaveBeenCalledWith('call-1', expect.any(String), 0);
    expect(f.controller.getSnapshot().exitCountdown).toEqual({
      reason: 'semantic',
      secondsRemaining: 3,
    });
    expect(f.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.cancelExit();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.end).not.toHaveBeenCalled();
    expect(f.player.resume).toHaveBeenCalled();
    f.controller.end();
  });

  // Regression entry is the real controller + finalized ASR event. Deferred
  // send() models auth/enqueue latency; fake time proves no early teardown or
  // duplicate send, without microphone, account, network or background jobs.
  it('keeps a misclassified message accepted and never duplicates it on cancel or retry', async () => {
    const f = fixture();
    const text = '帮我整理资料，然后退出语音模式';
    f.api.classifyExit.mockResolvedValue(true);
    await f.controller.start(selection);
    f.utterance(text);
    await vi.advanceTimersByTimeAsync(0);
    f.controller.cancelExit();
    f.controller.cancelExit();
    expect(f.controller.getSnapshot().unsent).toBe('');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    f.controller.retryUnsent();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toBe(text);
    expect(f.api.classifyExit).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().unsent).toBe('');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(text);
    f.controller.end();
  });

  it.each(['speech', 'mute', 'block', 'failure'] as const)(
    'cancels a countdown across %s without restoring or duplicating accepted input',
    async (action) => {
      const f = fixture();
      f.api.classifyExit.mockResolvedValue(true);
      await f.controller.start(selection);
      f.utterance('please do this, then hang up');
      await vi.advanceTimersByTimeAsync(0);
      if (action === 'speech') f.emit({ type: 'speech-started' });
      else if (action === 'mute') await f.controller.toggleMute();
      else if (action === 'block') f.controller.setBlocked(true);
      else f.emit({ type: 'error', text: '' });
      expect(f.controller.getSnapshot().unsent).toBe('');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      f.controller.end();
    },
  );

  it('submits the complete compound request and exits immediately after acceptance without stopping work', async () => {
    const f = fixture();
    const text = '帮我查资料，然后退出语音模式';
    f.api.classifyExit.mockResolvedValue('submit_then_exit');
    let accept!: () => void;
    f.send.mockImplementation(async (_text, created, current) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      created('accepted-task');
      return true;
    });
    await f.controller.start(selection);
    f.utterance(text);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]![0]).toBe(text);
    expect(f.controller.getSnapshot().exitCountdown?.waitingForSend).toBe(true);
    expect(f.api.end).not.toHaveBeenCalled();
    f.taskBusy.mockReturnValue(true);
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.api.end).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.taskBusy()).toBe(true);
    expect(f.controller.getSnapshot().unsent).toBe('');
  });

  it.each(['结束语音模式', '拜拜'])(
    'defers %s while an earlier send has left the queue but is not accepted',
    async (exitText) => {
      const f = fixture();
      let accept!: () => void;
      f.send.mockImplementation(async (_text, created, current) => {
        await new Promise<void>((done) => {
          accept = done;
        });
        expect(current()).toBe(true);
        created('accepted-task');
        return true;
      });
      await f.controller.start(selection);
      f.utterance('帮我整理资料');
      await vi.advanceTimersByTimeAsync(0);
      f.emit({ type: 'speech-started' });
      f.utterance(exitText);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.controller.getSnapshot().exitCountdown?.waitingForSend).toBe(true);
      expect(f.api.end).not.toHaveBeenCalled();
      accept();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onAutoEnd).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.send.mock.calls[0]![0]).toBe('帮我整理资料');
    },
  );

  it.each(['rejected', 'throw'] as const)(
    'retains the compound request after send %s and cancels automatic exit',
    async (failure) => {
      const f = fixture();
      const text = '帮我继续整理，提交后关闭语音';
      f.api.classifyExit.mockResolvedValue('submit_then_exit');
      f.send.mockImplementationOnce(async () => {
        if (failure === 'throw') throw new Error('send failed');
        return false;
      });
      await f.controller.start(selection);
      f.utterance(text);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.controller.getSnapshot()).toMatchObject({
        unsent: text,
        phase: 'error',
        error: 'send',
        exitCountdown: null,
      });
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      await f.controller.start(selection);
      f.controller.retryUnsent();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.send.mock.calls.map((call) => call[0])).toEqual([text, text]);
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      expect(f.api.classifyExit).toHaveBeenCalledOnce();
      f.controller.end();
    },
  );

  it('cancels pending exit before acceptance without resending the compound request', async () => {
    const f = fixture();
    f.api.classifyExit.mockResolvedValue('submit_then_exit');
    let accept!: () => void;
    f.send.mockImplementation(async (_text, created, current) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      created('accepted-task');
      return true;
    });
    await f.controller.start(selection);
    f.utterance('Please write the report in the background and end voice mode');
    await vi.advanceTimersByTimeAsync(0);
    f.controller.cancelExit();
    accept();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    f.controller.retryUnsent();
    expect(f.controller.getSnapshot().unsent).toBe('');
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it.each(['mute', 'block', 'end'] as const)(
    'does not revive a pending exit or duplicate accepted input after %s',
    async (boundary) => {
      const f = fixture();
      f.api.classifyExit.mockResolvedValue('submit_then_exit');
      let accept!: () => void;
      f.send.mockImplementation(async (_text, created) => {
        await new Promise<void>((done) => {
          accept = done;
        });
        created('already-accepted');
        return true;
      });
      await f.controller.start(selection);
      f.utterance('Keep working in the background and end voice chat');
      await vi.advanceTimersByTimeAsync(0);
      if (boundary === 'mute') await f.controller.toggleMute();
      else if (boundary === 'block') f.controller.setBlocked(true);
      else f.controller.end();
      accept();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot().exitCountdown).toBeNull();
      expect(f.controller.getSnapshot().unsent).toBe('');
      expect(f.send).toHaveBeenCalledOnce();
      f.controller.end();
    },
  );

  it('cancels pending exit on new speech while preserving both sends', async () => {
    const f = fixture();
    f.api.classifyExit.mockResolvedValueOnce('submit_then_exit');
    let accept!: () => void;
    f.send.mockImplementationOnce(async (_text, created, current) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      created('first');
      return true;
    });
    await f.controller.start(selection);
    f.utterance('Write the report, then exit voice');
    await vi.advanceTimersByTimeAsync(0);
    f.emit({ type: 'speech-started' });
    f.utterance('Add a summary too');
    accept();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.send.mock.calls.map((call) => call[0])).toEqual([
      'Write the report, then exit voice',
      'Add a summary too',
    ]);
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    f.controller.end();
  });

  it('ends a confirmed semantic countdown using the existing resource cleanup only', async () => {
    const f = fixture();
    f.api.classifyExit.mockResolvedValue(true);
    await f.controller.start(selection);
    f.taskBusy.mockReturnValue(true);
    f.utterance('I need to go, talk later');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.api.end).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith('voice mode ended', {
      callId: 'call-1',
      reason: 'semantic',
    });
  });

  it.each(['再见', '结束语音'])('keeps %s on the immediate local path', async (text) => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance(text);
    expect(f.api.classifyExit).not.toHaveBeenCalled();
    f.controller.end();
  });

  it.each(['continue', 'error'] as const)(
    'sends the original utterance once on classifier %s',
    async (outcome) => {
      const f = fixture();
      if (outcome === 'error') f.api.classifyExit.mockRejectedValue(new Error('unavailable'));
      await f.controller.start(selection);
      f.utterance('Please keep working');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.send.mock.calls[0]![0]).toBe('Please keep working');
      expect(f.controller.getSnapshot().exitCountdown).toBeNull();
      f.controller.end();
    },
  );

  it('ignores a late semantic exit after the user speaks again and preserves both utterances', async () => {
    const f = fixture();
    let resolve!: (value: boolean) => void;
    f.api.classifyExit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.controller.start(selection);
    f.utterance('Maybe later');
    f.emit({ type: 'speech-started' });
    f.emit({ type: 'draft', text: 'please wait' });
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.controller.getSnapshot().transcript).toBe('please wait');
    f.utterance('please wait');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send.mock.calls.map((call) => call[0])).toEqual(['Maybe later', 'please wait']);
    f.controller.end();
  });

  it('does not transfer an old pending judgment or its text into a newly opened call', async () => {
    const f = fixture();
    let resolve!: (value: boolean) => void;
    f.api.classifyExit.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await f.controller.start(selection);
    f.utterance('Talk later');
    f.controller.end();
    // Opening another call must not await the old classifier either.
    await f.controller.start(selection);
    resolve(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'listening',
      unsent: '',
      exitCountdown: null,
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    f.controller.end();
  });

  it.each(['mute', 'block', 'end'] as const)(
    'does not act on a late judgment after %s',
    async (action) => {
      const f = fixture();
      let resolve!: (value: boolean) => void;
      f.api.classifyExit.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await f.controller.start(selection);
      f.utterance('Talk later');
      if (action === 'mute') await f.controller.toggleMute();
      else if (action === 'block') f.controller.setBlocked(true);
      else f.controller.end();
      resolve(true);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.controller.getSnapshot().unsent).toBe('');
      f.controller.end();
    },
  );

  it('shows a ten-second countdown after one idle minute, then releases voice and closes once', async () => {
    const f = fixture();
    await f.controller.start(selection);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.controller.getSnapshot().exitCountdown).toEqual({
      reason: 'idle',
      secondsRemaining: 10,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.controller.getSnapshot().exitCountdown?.secondsRemaining).toBe(1);
    expect(f.api.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.controller.getSnapshot().phase).toBe('idle');
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(f.player.close).toHaveBeenCalledOnce();
    expect(f.api.end).toHaveBeenCalledWith('call-1');
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends on a final explicit voice command while preserving accepted task work', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance('keep working in the background');
    await vi.advanceTimersByTimeAsync(0);
    f.taskBusy.mockReturnValue(true);
    f.emit({ type: 'draft', text: '结束语音' });
    expect(f.api.end).not.toHaveBeenCalled();
    f.utterance('结束语音。');
    expect(f.controller.getSnapshot().phase).toBe('idle');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.api.end).toHaveBeenCalledWith('call-1');
  });

  it('offers three seconds for a standalone farewell without sending it as a task message', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance('拜拜！');
    expect(f.controller.getSnapshot().exitCountdown).toEqual({
      reason: 'farewell',
      secondsRemaining: 3,
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.api.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.onAutoEnd).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts only fully idle time and rechecks task activity at the exit boundary', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.taskBusy.mockReturnValue(true);
    f.controller.refreshActivity();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.taskBusy.mockReturnValue(false);
    f.controller.refreshActivity();
    await vi.advanceTimersByTimeAsync(69_999);
    // Simulate a new background task before React's next activity notification.
    f.taskBusy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.end).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.taskBusy.mockReturnValue(false);
    f.controller.refreshActivity();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.controller.end();
    expect(vi.getTimerCount()).toBe(0);
  });

  // #5718 review: ordinary reply waiting is covered, but accepted input with
  // no reply after a terminal failure was stuck forever. Unit/fake time:
  // correlated terminal input resumes listening without resending or ending work.
  // Standalone file validation including both review fixes: 2.72s wall time.
  it.each(['error', 'cancelled'] as const)('releases reply ownership on task %s and restores idle exit', async (reason) => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance();
    await vi.advanceTimersByTimeAsync(0);
    f.taskBusy.mockReturnValue(true); // Independent background work stays busy.
    f.controller.updateMessages([user()], { clientId: 'user-1', reason });
    expect(f.controller.getSnapshot().phase).toBe('listening');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(f.api.end).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    f.taskBusy.mockReturnValue(false);
    f.controller.refreshActivity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.getSnapshot().exitCountdown?.reason).toBe('idle');
    f.controller.end();
  });

  it('ignores another input failure and handles a matching failure received before send acknowledgement', async () => {
    const f = fixture();
    let accept!: () => void;
    f.send.mockImplementationOnce(async (_text, created) => {
      created('user-1');
      await new Promise<void>((resolve) => { accept = resolve; });
      return true;
    });
    await f.controller.start(selection);
    f.utterance();
    f.controller.updateMessages([user()], { clientId: 'older', reason: 'error' });
    expect(f.controller.getSnapshot().phase).toBe('thinking');
    f.controller.updateMessages([user()], { clientId: 'user-1', reason: 'error' });
    f.emit({ type: 'speech-started' });
    f.emit({ type: 'draft', text: 'still speaking' });
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'listening', transcript: 'still speaking' });
    f.emit({ type: 'draft', text: '' });
    f.emit({ type: 'speech-idle' });
    expect(f.controller.getSnapshot().phase).toBe('listening');
    f.controller.updateMessages([user(), reply()]);
    expect(f.api.speak).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('waits through send preflight, reply generation, synthesis, playback and gaps between sentences', async () => {
    const f = fixture();
    let accept!: () => void;
    f.send.mockImplementationOnce(async (_text, created) => {
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
      created('user-1');
      return true;
    });
    let synthesize!: (value: SpeechStartResult) => void;
    f.api.speak.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          synthesize = resolve;
        }),
    );
    let played!: () => void;
    f.player.play.mockImplementationOnce(async (_read, _rate, started) => {
      started?.();
      await new Promise<void>((resolve) => {
        played = resolve;
      });
    });
    await f.controller.start(selection);
    f.utterance();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.api.end).not.toHaveBeenCalled();
    accept();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.controller.updateMessages([user(), streamingReply('一句话。')]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().phase).toBe('preparing');
    synthesize({ sampleRate: 24000 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().phase).toBe('speaking');
    played();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().phase).toBe('thinking');
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.updateMessages([user(), streamingReply('一句话。', true)]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.controller.getSnapshot().exitCountdown?.reason).toBe('idle');
    f.controller.end();
  });

  it('cancels idle exit on speech activity even before text, and retains muted unsent text', async () => {
    const f = fixture();
    await f.controller.start(selection);
    await vi.advanceTimersByTimeAsync(60_000);
    f.emit({ type: 'speech-started' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.emit({ type: 'speech-idle' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.getSnapshot().exitCountdown?.reason).toBe('idle');
    f.emit({ type: 'draft', text: 'unfinished thought' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.api.end).not.toHaveBeenCalled();
    await f.controller.toggleMute();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.controller.getSnapshot().unsent).toBe('unfinished thought');
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    f.controller.end();
  });

  it.each(['button', 'speech'] as const)(
    'cancels farewell by %s and resumes the held reply without resending',
    async (trigger) => {
      const f = fixture();
      let played!: () => void;
      f.player.play.mockImplementationOnce(async (_read, _rate, started) => {
        started?.();
        await new Promise<void>((resolve) => {
          played = resolve;
        });
      });
      await f.controller.start(selection);
      f.utterance();
      await vi.advanceTimersByTimeAsync(0);
      f.controller.updateMessages([user(), reply()]);
      await vi.advanceTimersByTimeAsync(0);
      f.emit({ type: 'speech-started' });
      f.utterance('再见');
      await vi.advanceTimersByTimeAsync(2_000);
      const resumes = f.player.resume.mock.calls.length;
      if (trigger === 'button') f.controller.cancelExit();
      else {
        f.emit({ type: 'speech-started' });
        expect(f.player.resume).toHaveBeenCalledTimes(resumes);
        f.emit({ type: 'speech-idle' });
      }
      expect(f.controller.getSnapshot().exitCountdown).toBeNull();
      expect(f.player.resume).toHaveBeenCalledTimes(resumes + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.api.end).not.toHaveBeenCalled();
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.api.speak).toHaveBeenCalledOnce();
      played();
      await vi.advanceTimersByTimeAsync(0);
      f.controller.end();
    },
  );

  it('allows cancelling idle exit while muted without reopening the microphone', async () => {
    const f = fixture();
    await f.controller.start(selection);
    await f.controller.toggleMute();
    await vi.advanceTimersByTimeAsync(60_000);
    f.controller.cancelExit();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.controller.getSnapshot()).toMatchObject({ muted: true, exitCountdown: null });
    expect(f.microphone.start).toHaveBeenCalledOnce();
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.end();
  });

  it.each(['end', 'permission', 'error'] as const)(
    'clears farewell timers across %s and does not close a later call',
    async (boundary) => {
      const f = fixture();
      await f.controller.start(selection);
      f.utterance('bye');
      if (boundary === 'end') f.controller.end();
      if (boundary === 'permission') {
        f.controller.setBlocked(true);
        f.controller.setBlocked(false);
      }
      if (boundary === 'error') f.emit({ type: 'error', text: '' });
      expect(vi.getTimerCount()).toBe(0);
      await f.controller.start(selection);
      f.emit({ type: 'utterance', id: 'late', text: '结束语音' }, 'call-1');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.controller.getSnapshot().phase).toBe('listening');
      expect(f.onAutoEnd).not.toHaveBeenCalled();
      f.controller.end();
    },
  );

  it('only arms idleness after the microphone is ready, and ignores old input generations', async () => {
    const f = fixture();
    let ready!: () => void;
    f.microphone.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const opening = f.controller.start(selection);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.controller.getSnapshot().phase).toBe('microphone');
    expect(f.api.end).not.toHaveBeenCalled();
    ready();
    await opening;
    await f.controller.toggleMute();
    await f.controller.toggleMute();
    f.emit({ type: 'utterance', id: 'stale-input', text: '结束语音' }, 'call-1', 0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.api.end).not.toHaveBeenCalled();
    f.controller.end();
  });

  it.each([
    '不要结束语音',
    '再见用英语怎么说',
    '他说了拜拜',
    '“拜拜”',
    '再见？',
    '拜拜，明天要做什么',
    '先别说话',
    '暂停一下',
    '停止朗读',
  ])('keeps contextual or ambiguous speech as a normal message: %s', async (text) => {
    const f = fixture();
    await f.controller.start(selection);
    f.utterance(text);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).toHaveBeenCalledWith(text, expect.any(Function), expect.any(Function));
    expect(f.controller.getSnapshot().exitCountdown).toBeNull();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    f.controller.end();
  });

  it.each(['退出语音模式', '请关闭语音对话！', '請結束語音模式。', 'End voice chat.'])(
    'recognizes a whole explicit command: %s',
    async (text) => {
      const f = fixture();
      await f.controller.start(selection);
      f.utterance(text);
      expect(f.api.end).toHaveBeenCalledWith('call-1');
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it('keeps a farewell in context with retained input and never logs the spoken control text', async () => {
    const f = fixture();
    await f.controller.start(selection);
    f.emit({ type: 'draft', text: '我刚刚说的是' });
    await f.controller.toggleMute();
    await f.controller.toggleMute();
    f.utterance('拜拜');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).toHaveBeenCalledWith(
      '我刚刚说的是 拜拜',
      expect.any(Function),
      expect.any(Function),
    );
    f.utterance('退出语音模式');
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledWith('voice mode ended', {
      callId: 'call-1',
      reason: 'voice_command',
    });
    expect(log.info).toHaveBeenCalledWith(
      'voice resources released',
      expect.objectContaining({ callId: 'call-1', failedOperations: 0 }),
    );
    for (const text of ['拜拜', '退出语音模式', '我刚刚说的是'])
      expect(JSON.stringify(log.info.mock.calls)).not.toContain(text);
  });
});

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

  // Unit: encoded results must retain the same prefetch/interruption contract;
  // the old PCM-only fixtures could not detect a dropped MP3 format at playback.
  it.each(['pcm', 'mp3'] as const)('prefetches only one %s segment and drops pending audio on a committed interruption', async format => {
    const f = fixture();
    if (format === 'mp3') f.api.speak.mockResolvedValue({ format: 'mp3', data: new Uint8Array([1]).buffer });
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
    expect(f.player.play.mock.calls[0][1]).toEqual(format === 'mp3'
      ? { format: 'mp3', data: new Uint8Array([1]).buffer } : 24000);
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

  it.each(['pcm', 'mp3'] as const)('plays prepared %s sentences in order, pauses lookahead, and listens only after the final tail drains', async format => {
    const f = fixture();
    if (format === 'mp3') f.api.speak.mockResolvedValue({ format: 'mp3', data: new Uint8Array([1]).buffer });
    const finishes: Array<() => void> = [];
    f.player.play.mockImplementation(async (read, audio, started) => {
      if (typeof audio === 'number') await read();
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
      format === 'mp3' ? [] : f.api.speak.mock.calls.map(([request]) => request.requestId),
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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.utterance('second');
    reject(false);
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('error'));
    expect(f.controller.getSnapshot().unsent).toBe('first second');
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  });

  // #5718 review: queued finals were covered, but a newer partial was lost on
  // send rejection. Unit: real controller, deferred send + ASR events; preserve
  // chronological input once, including deliberate repetition, through retry.
  it.each(['second draft', 'first'])('retains a newer partial after send failure (%s)', async (draft) => {
    const f = fixture();
    let reject!: (value: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => { reject = resolve; }));
    await f.controller.start(selection);
    f.utterance('first');
    f.emit({ type: 'draft', text: 'queued' });
    f.utterance('queued');
    f.emit({ type: 'draft', text: '' });
    f.emit({ type: 'speech-started' });
    f.emit({ type: 'draft', text: draft });
    reject(false);
    await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('error'));
    expect(f.controller.getSnapshot()).toMatchObject({
      unsent: `first queued ${draft}`,
      transcript: '',
    });
    await f.controller.start(selection);
    f.controller.retryUnsent();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    expect(f.send.mock.calls[1][0]).toBe(`first queued ${draft}`);
    f.controller.end();
  });

  it('retains a finalized draft only once when it exceeds the send queue limit', async () => {
    const f = fixture();
    await f.controller.start(selection);
    const text = 'a'.repeat(16_001);
    f.emit({ type: 'draft', text });
    // Queue rejection runs synchronously, before the ASR's next empty draft.
    f.utterance(text);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', unsent: text, transcript: '' });
    expect(f.send).not.toHaveBeenCalled();
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

  // Startup regression: Main releases its failed call and emits ended before
  // start's IPC rejection arrives. Earlier mocks only rejected the promise.
  // Real controller, unit tier: show the retryable error and release playback;
  // a later retry must still acquire the microphone exactly once.
  it('keeps a startup failure visible when ended arrives before the start rejection', async () => {
    const f = fixture();
    f.api.start.mockImplementationOnce(async ({ callId }) => {
      f.emit({ type: 'ended' }, callId);
      throw new Error('Voice conversation is unavailable');
    });
    await f.controller.start(selection);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'connection' });
    expect(f.microphone.start).not.toHaveBeenCalled();
    expect(f.player.close).toHaveBeenCalledOnce();
    expect(f.onAutoEnd).not.toHaveBeenCalled();
    await f.controller.start(selection);
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'listening', error: null });
    expect(f.microphone.start).toHaveBeenCalledOnce();
    f.controller.end();
  });

  it('keeps a user-cancelled startup idle when its rejection arrives late', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.api.start.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const opening = f.controller.start(selection);
    await vi.waitFor(() => expect(f.api.start).toHaveBeenCalledOnce());
    f.controller.end();
    reject(new Error('cancelled'));
    await opening;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(f.microphone.start).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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

// Oct 21 TTS stall: the existing failure case did not distinguish preparation
// and audio-read timeouts. Unit: real controller/queue, serialized IPC failures.
it.each([
  { stage: 'prepare', code: 'PRECONDITION_FAILED', error: 'speech' },
  { stage: 'prepare', code: 'VOICE_SPEECH_TIMEOUT', error: 'speechTimeout' },
  { stage: 'read', code: 'VOICE_SPEECH_TIMEOUT', error: 'speechTimeout' },
] as const)(
  'retains text and reports $code during $stage without fallback or resend',
  async ({ stage, code, error }) => {
    const f = fixture();
    const failure = new Error(
      `Error invoking remote method 'voice-conversation:${stage === 'prepare' ? 'speak' : 'read-speech'}': Error: [${code}] Safe failure.`,
    );
    if (stage === 'prepare') f.api.speak.mockRejectedValueOnce(failure);
    else {
      f.api.readSpeech.mockRejectedValueOnce(failure);
      f.player.play.mockImplementationOnce(async (read, _rate, onStarted) => {
        onStarted?.();
        await read();
      });
    }
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
    expect(f.controller.getSnapshot().error).toBe(error);
    expect(f.microphone.stop).toHaveBeenCalledOnce();
    expect(messages[1]).toEqual(reply());
    expect(f.api.start).toHaveBeenCalledOnce();
    expect(f.api.speak).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.end();
  },
);

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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
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
