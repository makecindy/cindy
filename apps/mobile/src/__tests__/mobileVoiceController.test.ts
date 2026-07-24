import { describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
  deleteSecureItem: vi.fn(async () => undefined),
}));
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';
import type {
  AsrEvent,
  AsrProvider,
  AudioTrace,
  RefinementResult,
} from '@cindy/voice-input-core';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { createMobileVoiceControllerSession } from '@/session/mobileVoiceController';
import { mobileVoiceEmptyTranscriptError } from '@/session/mobileVoiceInput';

vi.mock('@/session/mobileRealtimeAudio', () => ({
  startMobileRealtimeAudio: vi.fn(),
}));

class FakeAsrProvider implements AsrProvider {
  private callback: (event: AsrEvent) => void = () => {};
  stopCalls = 0;

  async start(): Promise<void> {
    this.callback({ type: 'connected', at: Date.now() });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  appendAudio(_chunk: ArrayBuffer, _trace?: AudioTrace): void {
    this.callback({ type: 'partial', text: 'raw draft', at: Date.now() });
  }

  async flushAudio(): Promise<void> {
    this.callback({ type: 'stable', text: 'raw final', at: Date.now() });
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }

  emit(event: AsrEvent): void {
    this.callback(event);
  }
}

class EmptyTranscriptAsrProvider extends FakeAsrProvider {
  appendAudio(_chunk: ArrayBuffer, _trace?: AudioTrace): void {}

  async flushAudio(): Promise<void> {
    this.emit({ type: 'stable', text: '', at: Date.now() });
  }
}

class ThrowingStartAsrProvider extends FakeAsrProvider {
  async start(): Promise<void> {
    throw new Error('cannot connect with sk-mobile-voice');
  }
}

class OrderedStartAsrProvider extends FakeAsrProvider {
  constructor(private readonly onStart: () => void) {
    super();
  }

  async start(): Promise<void> {
    this.onStart();
    await super.start();
  }
}

// ASR provider whose start() only resolves after resolveStart() is called, and
// which records every appended chunk. Lets tests reproduce the window where the
// mic is capturing while the ASR handshake is still in flight.
class GatedStartAsrProvider extends FakeAsrProvider {
  readonly appended: ArrayBuffer[] = [];
  flushCalls = 0;
  private release: (() => void) | null = null;
  private fail: ((error: Error) => void) | null = null;
  private readonly gate = new Promise<void>((resolve, reject) => {
    this.release = resolve;
    this.fail = reject;
  });

  resolveStart(): void {
    this.release?.();
  }

  failStart(error: Error): void {
    this.fail?.(error);
  }

  async start(): Promise<void> {
    await this.gate;
    await super.start();
  }

  appendAudio(chunk: ArrayBuffer, trace?: AudioTrace): void {
    this.appended.push(chunk);
    super.appendAudio(chunk, trace);
  }

  async flushAudio(): Promise<void> {
    this.flushCalls += 1;
    await super.flushAudio();
  }
}

function credential(): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
    proxyApiKey: 'sk-mobile-voice',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-06-19T00:01:00.000Z',
    asr: {
      provider: 'litellm-gpt-realtime-whisper',
      model: 'gpt-realtime-whisper',
      auth: 'api-key',
      mode: 'realtime-websocket',
      endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
      pcmSampleRate: 24000,
      protocolProfile: 'openai-transcription-manual',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
    settings: {
      language: 'zh-CN',
      refinementEnabled: true,
      playInteractionSound: true,
    },
  };
}

describe('mobileVoiceController', () => {
  it('propagates and localizes empty-transcript failures from stop()', async () => {
    const errors: string[] = [];
    const states: string[] = [];
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new EmptyTranscriptAsrProvider(),
      refiner: null,
      startAudio: async ({ onChunk: nextOnChunk }) => {
        onChunk = nextOnChunk;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onStateChanged: (state) => states.push(state),
      onError: (message) => errors.push(message),
    });

    await session.start();
    onChunk?.({
      pcm16: new Int16Array([1000, 1000]).buffer,
      trace: { capturedAt: 1, convertedAt: 2, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 },
    });

    await expect(session.stop()).rejects.toThrow(mobileVoiceEmptyTranscriptError());
    expect(errors).toEqual([mobileVoiceEmptyTranscriptError()]);
    expect(states).toContain('error');
    expect(states).not.toContain('done');
  });

  it('plays optional start feedback after native capture starts', async () => {
    const order: string[] = [];
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new OrderedStartAsrProvider(() => order.push('asr-start')),
      refiner: null,
      startAudio: async () => {
        order.push('audio-start');
        return async () => {
          order.push('audio-stopped');
        };
      },
      onDraftChanged: vi.fn(),
      onReadyForStartCue: () => order.push('start-cue'),
    });

    await session.start();
    expect(order).toEqual(['asr-start', 'audio-start', 'start-cue']);

    await session.cancel();
    expect(order).toEqual(['asr-start', 'audio-start', 'start-cue', 'audio-stopped']);
  });

  it('uses the synced desktop ASR sample rate and exposes realtime ASR draft while recording', async () => {
    const drafts: string[] = [];
    let audioChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let capturedSampleRate = 0;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: 'existing',
      asr: new FakeAsrProvider(),
      refiner: null,
      startAudio: async ({ sampleRate, onChunk }) => {
        capturedSampleRate = sampleRate;
        audioChunk = onChunk;
        return async () => undefined;
      },
      onDraftChanged: (draft) => drafts.push(draft),
    });

    await session.start();
    audioChunk?.({
      pcm16: new Uint8Array([1, 2]).buffer,
      trace: {
        capturedAt: 1,
        convertedAt: 2,
        chunkIndex: 1,
        sampleRate: 24000,
        durationMs: 120,
      },
    });

    expect(capturedSampleRate).toBe(24000);
    expect(session.currentDraft()).toBe('existing\nraw draft');
    expect(drafts).toEqual(['existing\nraw draft']);

    await session.cancel();
  });

  it('throttles repeated ASR partial draft publishes but applies stable text immediately', async () => {
    vi.useFakeTimers();
    try {
      const drafts: string[] = [];
      let currentDraft = '';
      const asr = new FakeAsrProvider();
      const session = createMobileVoiceControllerSession({
        credential: credential(),
        initialDraft: currentDraft,
        readCurrentDraft: () => currentDraft,
        asr,
        refiner: null,
        startAudio: async () => async () => undefined,
        onDraftChanged: (draft) => {
          currentDraft = draft;
          drafts.push(draft);
        },
      });

      await session.start();
      asr.emit({ type: 'partial', text: 'one', at: Date.now() });
      asr.emit({ type: 'partial', text: 'one two', at: Date.now() });
      asr.emit({ type: 'partial', text: 'one two three', at: Date.now() });

      expect(drafts).toEqual(['one']);
      expect(session.currentDraft()).toBe('one two three');

      vi.advanceTimersByTime(80);
      expect(drafts).toEqual(['one', 'one two three']);

      asr.emit({ type: 'partial', text: 'one two three four', at: Date.now() });
      asr.emit({ type: 'partial', text: 'one two three four five', at: Date.now() });
      asr.emit({ type: 'stable', text: 'final words', at: Date.now() });

      expect(drafts).toEqual(['one', 'one two three', 'one two three four', 'final words']);
      expect(session.currentDraft()).toBe('final words');
      vi.advanceTimersByTime(80);
      expect(drafts).toEqual(['one', 'one two three', 'one two three four', 'final words']);

      await session.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish deferred partials over manual composer edits', async () => {
    vi.useFakeTimers();
    try {
      const drafts: string[] = [];
      let currentDraft = '';
      const asr = new FakeAsrProvider();
      const session = createMobileVoiceControllerSession({
        credential: credential(),
        initialDraft: currentDraft,
        readCurrentDraft: () => currentDraft,
        asr,
        refiner: null,
        startAudio: async () => async () => undefined,
        onDraftChanged: (draft) => {
          currentDraft = draft;
          drafts.push(draft);
        },
      });

      await session.start();
      asr.emit({ type: 'partial', text: 'one', at: Date.now() });
      asr.emit({ type: 'partial', text: 'one two', at: Date.now() });
      currentDraft = 'manual edit';

      vi.advanceTimersByTime(80);
      expect(drafts).toEqual(['one']);
      expect(session.currentDraft()).toBe('manual edit');

      asr.emit({ type: 'stable', text: 'final words', at: Date.now() });
      expect(drafts).toEqual(['one']);
      expect(session.currentDraft()).toBe('manual edit');

      await session.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects realtime ASR and streaming refinement into one composer insertion', async () => {
    const drafts: string[] = [];
    const states: string[] = [];
    const order: string[] = [];
    const recordedHistory: string[] = [];
    const updatedHistory: Array<{ entryId: string; text: string }> = [];
    const appliedLearning: Array<{
      draft: string;
      rawTranscriptText: string;
      refinedText: string;
      start: number;
      end: number;
    }> = [];
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: 'prefix',
      asr: new FakeAsrProvider(),
      refiner: {
        async refine(input): Promise<RefinementResult> {
          order.push(`refine:${input.text}`);
          if (input.text === 'raw final') input.onPartial?.('refined preview');
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: input.text === 'raw final' ? 'refined final' : 'ignored optimistic refine',
            elapsedMs: 1,
          };
        },
      },
      startAudio: async ({ onChunk }) => {
        onChunk({
          pcm16: new Uint8Array([1, 2]).buffer,
          trace: {
            capturedAt: 1,
            convertedAt: 2,
            chunkIndex: 1,
            sampleRate: 24000,
            durationMs: 120,
          },
        });
        return async () => {
          order.push('audio-stopped');
        };
      },
      onDraftChanged: (draft) => drafts.push(draft),
      onStateChanged: (state) => states.push(state),
      onReadyForEndCue: () => order.push('end-cue'),
      recordHistory: (text) => {
        recordedHistory.push(text);
        return `history:${text}`;
      },
      updateHistoryEntry: (entryId, text) => {
        updatedHistory.push({ entryId, text });
      },
      onRefinementApplied: (input) => {
        appliedLearning.push(input);
      },
    });

    await session.start();
    const finalDraft = await session.stop();

    expect(drafts).toEqual([
      'prefix\nraw draft',
      'prefix\nraw final',
      'prefix\nrefined preview',
      'prefix\nrefined final',
    ]);
    expect(finalDraft).toBe('prefix\nrefined final');
    expect(states).toContain('listening');
    expect(states).toContain('submitting');
    expect(states).toContain('refining');
    expect(states.at(-1)).toBe('done');
    expect(order).toEqual([
      'audio-stopped',
      'end-cue',
      'refine:raw draft',
      'refine:raw final',
    ]);
    expect(recordedHistory).toEqual(['raw final']);
    expect(updatedHistory).toEqual([
      { entryId: 'history:raw final', text: 'refined final' },
    ]);
    expect(appliedLearning).toEqual([
      {
        draft: 'prefix\nrefined final',
        rawTranscriptText: 'raw final',
        refinedText: 'refined final',
        start: 7,
        end: 20,
      },
    ]);
  });

  it('does not let optional end feedback block stop-time submission', async () => {
    const drafts: string[] = [];
    const states: string[] = [];
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new FakeAsrProvider(),
      refiner: null,
      startAudio: async ({ onChunk }) => {
        onChunk({
          pcm16: new Uint8Array([1, 2]).buffer,
          trace: {
            capturedAt: 1,
            convertedAt: 2,
            chunkIndex: 1,
            sampleRate: 24000,
            durationMs: 120,
          },
        });
        return async () => undefined;
      },
      onDraftChanged: (draft) => drafts.push(draft),
      onStateChanged: (state) => states.push(state),
      onReadyForEndCue: () => {
        throw new Error('end feedback unavailable');
      },
    });

    await session.start();
    const finalDraft = await session.stop();

    expect(drafts).toEqual(['raw draft', 'raw final']);
    expect(finalDraft).toBe('raw final');
    expect(states).toContain('submitting');
    expect(states.at(-1)).toBe('done');
  });

  it('does not overwrite the composer when the visible voice insertion changed externally', async () => {
    const drafts: string[] = [];
    const refineInputs: string[] = [];
    const recordedHistory: string[] = [];
    let currentDraft = 'prefix';
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: currentDraft,
      readCurrentDraft: () => currentDraft,
      asr: new FakeAsrProvider(),
      refiner: {
        async refine(input): Promise<RefinementResult> {
          refineInputs.push(input.text);
          input.onPartial?.('refined preview');
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: 'refined final',
            elapsedMs: 1,
          };
        },
      },
      startAudio: async ({ onChunk }) => {
        onChunk({
          pcm16: new Uint8Array([1, 2]).buffer,
          trace: {
            capturedAt: 1,
            convertedAt: 2,
            chunkIndex: 1,
            sampleRate: 24000,
            durationMs: 120,
          },
        });
        return async () => undefined;
      },
      onDraftChanged: (draft) => {
        currentDraft = draft;
        drafts.push(draft);
      },
      recordHistory: (text) => {
        recordedHistory.push(text);
      },
    });

    await session.start();
    currentDraft = 'prefix\nmanual edit';
    const finalDraft = await session.stop();

    expect(drafts).toEqual(['prefix\nraw draft']);
    expect(finalDraft).toBe('prefix\nmanual edit');
    expect(refineInputs).toEqual(['raw draft']);
    expect(recordedHistory).toEqual([]);
  });

  it('updates refined history even when async secure storage returns the history id late', async () => {
    const updatedHistory: Array<{ entryId: string; text: string }> = [];
    let resolveHistory: ((entryId: string) => void) | undefined;
    const historyRecorded = new Promise<string>((resolve) => {
      resolveHistory = resolve;
    });
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new FakeAsrProvider(),
      refiner: {
        async refine(input): Promise<RefinementResult> {
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: 'refined final',
            elapsedMs: 1,
          };
        },
      },
      startAudio: async ({ onChunk }) => {
        onChunk({
          pcm16: new Uint8Array([1, 2]).buffer,
          trace: {
            capturedAt: 1,
            convertedAt: 2,
            chunkIndex: 1,
            sampleRate: 24000,
            durationMs: 120,
          },
        });
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      recordHistory: () => historyRecorded,
      updateHistoryEntry: (entryId, text) => {
        updatedHistory.push({ entryId, text });
      },
    });

    await session.start();
    const stopped = session.stop();
    await stopped;
    expect(updatedHistory).toEqual([]);

    resolveHistory?.('history-late');
    await Promise.resolve();
    await Promise.resolve();

    expect(updatedHistory).toEqual([
      { entryId: 'history-late', text: 'refined final' },
    ]);
  });

  it('redacts synced mobile voice keys from startup failures surfaced to the session caller', async () => {
    const errors: string[] = [];
    const startCues: string[] = [];
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new ThrowingStartAsrProvider(),
      refiner: null,
      startAudio: async () => async () => undefined,
      onDraftChanged: vi.fn(),
      onError: (message) => errors.push(message),
      onReadyForStartCue: () => startCues.push('start-cue'),
    });

    let thrown: unknown;
    try {
      await session.start();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('sk-mobile-voice');
    expect(errors).toEqual(['cannot connect with [REDACTED]']);
    expect(startCues).toEqual([]);
  });

  it('redacts synced mobile voice keys from microphone startup failures', async () => {
    const errors: string[] = [];
    const startCues: string[] = [];
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new FakeAsrProvider(),
      refiner: null,
      startAudio: async () => {
        throw new Error('microphone failed before using sk-mobile-voice');
      },
      onDraftChanged: vi.fn(),
      onError: (message) => errors.push(message),
      onReadyForStartCue: () => startCues.push('start-cue'),
    });

    let thrown: unknown;
    try {
      await session.start();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('sk-mobile-voice');
    expect(errors).toEqual([]);
    expect(startCues).toEqual([]);
  });

  it('cancels the active ASR session when native microphone capture is interrupted', async () => {
    const errors: string[] = [];
    const states: string[] = [];
    let audioChunkCb: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let audioError: ((error: Error) => void) | undefined;
    let audioStopCalls = 0;
    const asr = new FakeAsrProvider();
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async ({ onChunk, onError }) => {
        audioChunkCb = onChunk;
        audioError = onError;
        return async () => {
          audioStopCalls += 1;
        };
      },
      onDraftChanged: vi.fn(),
      onStateChanged: (state) => states.push(state),
      onError: (message) => errors.push(message),
    });

    await session.start();
    // 'listening' is only surfaced once the mic delivers real PCM (capture goes
    // live), so a chunk must arrive before it appears. The native layer then
    // reports an interruption mid-capture.
    audioChunkCb?.({
      pcm16: new Uint8Array([1, 2]).buffer,
      trace: { capturedAt: 1, convertedAt: 2, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 },
    });
    audioError?.(new Error('native capture interrupted before sk-mobile-voice could finish'));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual(['native capture interrupted before [REDACTED] could finish']);
    expect(states).toContain('listening');
    expect(states).toContain('error');
    expect(states).not.toContain('done');
    expect(audioStopCalls).toBe(1);
    expect(asr.stopCalls).toBe(1);
  });

  it('buffers audio captured during the ASR handshake and flushes it in order once ASR is ready', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const a = new Uint8Array([1]).buffer;
    const b = new Uint8Array([2]).buffer;

    const startPromise = session.start();
    // Let start() get past `await startAudio` to `await asrStartPromise` (still gated).
    await Promise.resolve();
    await Promise.resolve();

    // Speak during the handshake. A fallback provider's appendAudio is a no-op
    // until its inner provider is active, so these must be buffered, not sent.
    onChunk?.({ pcm16: a, trace });
    onChunk?.({ pcm16: b, trace });
    expect(asr.appended).toEqual([]);

    asr.resolveStart();
    await startPromise;

    // Handshake-window audio is replayed in order once ASR can receive it.
    expect(asr.appended).toEqual([a, b]);

    // Chunks after ready pass straight through.
    const c = new Uint8Array([3]).buffer;
    onChunk?.({ pcm16: c, trace });
    expect(asr.appended).toEqual([a, b, c]);

    await session.cancel();
  });

  it('flushes handshake-buffered audio when stop() is called before the ASR connection is ready', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const a = new Uint8Array([9]).buffer;

    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    onChunk?.({ pcm16: a, trace });

    // Stop while the handshake is still gated; stop() must wait for it to settle.
    const stopPromise = session.stop();
    await Promise.resolve();
    expect(asr.appended).toEqual([]);
    expect(asr.flushCalls).toBe(0);

    asr.resolveStart();
    await startPromise;
    await stopPromise;

    // The short utterance captured before connect was replayed and then flushed,
    // not stranded as empty text.
    expect(asr.appended).toEqual([a]);
    expect(asr.flushCalls).toBe(1);
    expect(asr.stopCalls).toBe(1);
  });

  it('does not replay handshake audio into a cancelled controller when the mic fails mid-handshake, and start() rejects', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        onError = input.onError;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    onChunk?.({ pcm16: new Uint8Array([1]).buffer, trace });

    // Mic fails while the ASR handshake is still gated.
    onError?.(new Error('native capture interrupted before sk-mobile-voice could finish'));
    await Promise.resolve();
    await Promise.resolve();

    // The handshake then succeeds late — must not revive a cancelled run.
    asr.resolveStart();
    await expect(startPromise).rejects.toThrow();
    // Nothing replayed into the cancelled controller, and the key is redacted.
    expect(asr.appended).toEqual([]);
    await startPromise.catch((err: unknown) => {
      expect(String((err as Error).message)).not.toContain('sk-mobile-voice');
    });
  });

  it('surfaces the ASR handshake failure through stop() when stop() is called before it settles', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    onChunk?.({ pcm16: new Uint8Array([1]).buffer, trace });

    const stopPromise = session.stop();
    await Promise.resolve();
    // Handshake fails while stop() is waiting for it to settle.
    asr.failStart(new Error('cannot connect with sk-mobile-voice'));

    // Both start() and the early stop() surface the failure rather than reporting
    // a silent success (which the caller would render as "done").
    await expect(startPromise).rejects.toThrow();
    await expect(stopPromise).rejects.toThrow();
    await stopPromise.catch((err: unknown) => {
      expect(String((err as Error).message)).not.toContain('sk-mobile-voice');
    });
  });

  it('stops the just-opened provider and does not revive the run when cancel() lands during the handshake', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    onChunk?.({ pcm16: new Uint8Array([1]).buffer, trace });

    // User cancels while the ASR handshake is still gated. cancel()'s own asr.stop()
    // here cannot close the not-yet-opened connection (a real fallback provider has
    // no active inner provider yet).
    await session.cancel();
    const stopsAfterCancel = asr.stopCalls;

    // Handshake resolves late: the run must not be revived, and the provider that
    // only just opened must be stopped rather than left alive until the server times out.
    asr.resolveStart();
    await startPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(asr.appended).toEqual([]);
    expect(asr.stopCalls).toBeGreaterThan(stopsAfterCancel);
  });

  it('closes native capture when cancel() lands before startAudio has resolved', async () => {
    const asr = new FakeAsrProvider();
    let releaseStartAudio: (() => void) | undefined;
    let audioStopCalls = 0;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async () => {
        await new Promise<void>((resolve) => {
          releaseStartAudio = resolve;
        });
        return async () => {
          audioStopCalls += 1;
        };
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: vi.fn(),
    });

    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();

    // Cancel while the native capture is still opening: its teardown sees
    // stopAudio === null and cannot close anything yet.
    await session.cancel();
    expect(audioStopCalls).toBe(0);

    // When the capture handle finally arrives, the abandoned run must close it
    // instead of leaving the mic and its event subscriptions live.
    releaseStartAudio?.();
    await startPromise;
    expect(audioStopCalls).toBe(1);
  });

  it('surfaces the failure through stop() when the mic fails during the handshake before an early stop', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        onError = input.onError;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    onChunk?.({ pcm16: new Uint8Array([1]).buffer, trace });

    // Mic fails while the ASR handshake is still gated (so the late .then returns
    // without recording an asrStartError), then the user stops.
    onError?.(new Error('native capture interrupted before sk-mobile-voice could finish'));
    await Promise.resolve();
    const stopPromise = session.stop();
    asr.resolveStart();

    await expect(startPromise).rejects.toThrow();
    // stop() must surface the failure via audioFailureActive rather than falling
    // through to a "successful" empty draft the caller renders as done.
    await expect(stopPromise).rejects.toThrow();
    await stopPromise.catch((err: unknown) => {
      expect(String((err as Error).message)).not.toContain('sk-mobile-voice');
    });
  });

  it('allows a fresh recording after a mic failure interrupted the previous run', async () => {
    const states: string[] = [];
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    const asr = new FakeAsrProvider();
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        onError = input.onError;
        return async () => undefined;
      },
      onDraftChanged: vi.fn(),
      onError: vi.fn(),
      onStateChanged: (state) => states.push(state),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };

    // Run 1: starts fine, then the mic is interrupted mid-capture.
    await session.start();
    onChunk?.({ pcm16: new Uint8Array([1]).buffer, trace });
    onError?.(new Error('native capture interrupted'));
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toContain('error');

    // Run 2: a healthy start on the SAME session must not be poisoned by the
    // previous run's audioFailureActive flag. Before the reset fix this start()
    // rejected (the handshake .then hit the stale flag and skipped ready/replay,
    // then the post-handshake guard threw), permanently bricking voice input.
    states.length = 0;
    await expect(session.start()).resolves.toBeUndefined();
    onChunk?.({ pcm16: new Uint8Array([2]).buffer, trace });
    expect(states).toContain('listening');
    expect(states).not.toContain('error');

    await session.cancel();
  });

  it('stops native capture before awaiting the handshake and drops post-stop audio on early stop', async () => {
    const asr = new GatedStartAsrProvider();
    let onChunk: ((chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void) | undefined;
    let micStopped = false;
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr,
      refiner: null,
      startAudio: async (input) => {
        onChunk = input.onChunk;
        return async () => {
          micStopped = true;
        };
      },
      onDraftChanged: vi.fn(),
    });

    const trace: AudioTrace = { capturedAt: 0, convertedAt: 0, chunkIndex: 0, sampleRate: 16_000, durationMs: 20 };
    const pre = new Uint8Array([1]).buffer;
    const post = new Uint8Array([2]).buffer;

    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();
    // Pre-stop utterance captured during the still-gated handshake — buffered.
    onChunk?.({ pcm16: pre, trace });

    const stopPromise = session.stop();
    await Promise.resolve();
    // Native capture is torn down immediately on stop(), before the gated handshake
    // settles — the mic isn't held live for the rest of the WebSocket connect.
    expect(micStopped).toBe(true);

    // Any chunk emitted after stop (old ordering kept the mic live during connect)
    // must be dropped rather than buffered and later flushed.
    onChunk?.({ pcm16: post, trace });

    asr.resolveStart();
    await startPromise;
    await stopPromise;

    // Only the pre-stop chunk reached ASR; the post-stop chunk was discarded.
    expect(asr.appended).toEqual([pre]);
    expect(asr.flushCalls).toBe(1);
  });
});
