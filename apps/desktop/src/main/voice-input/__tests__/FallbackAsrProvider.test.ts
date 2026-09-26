import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsrEvent, AsrProvider } from '@cindy/voice-input-core';
import { VoiceInputController, VoiceTimelineLogger } from '@cindy/voice-input-core';
import { getVoiceInputRateLimitMessage } from '../voiceInputStartError.js';
import { VOICE_INPUT_RATE_LIMITED_MESSAGE } from '../../../shared/voiceInputErrors.js';

import { FallbackAsrProvider, type FallbackAsrCandidate } from '../FallbackAsrProvider.js';
import {
  isVoiceInputProviderCoolingDown,
  resetVoiceInputProviderHealthForTests,
} from '../VoiceInputProviderHealth.js';
import type { VoiceInputProviderKind } from '../voiceInputAsrConfig.js';

type MockAsrProvider = AsrProvider & {
  emit: (event: AsrEvent) => void;
  appended: ArrayBuffer[];
};

function makeMockProvider(options?: {
  startError?: Error;
  startGate?: Promise<void>;
  stopGate?: Promise<void>;
  recover?: () => Promise<void>;
}): MockAsrProvider {
  const callbacks: Array<(event: AsrEvent) => void> = [];
  const appended: ArrayBuffer[] = [];
  const provider: MockAsrProvider = {
    appended,
    start: vi.fn(async () => {
      if (options?.startError) throw options.startError;
      await options?.startGate;
    }),
    stop: vi.fn(async () => {
      await options?.stopGate;
    }),
    appendAudio: vi.fn((chunk: ArrayBuffer) => {
      appended.push(chunk);
    }),
    flushAudio: vi.fn(async () => {}),
    onEvent: (callback) => {
      callbacks.push(callback);
    },
    dispose: vi.fn(async () => {}),
    emit: (event) => {
      for (const callback of callbacks) callback(event);
    },
  };
  if (options?.recover) provider.recover = options.recover;
  return provider;
}

function candidate(kind: string, provider: MockAsrProvider | (() => Promise<AsrProvider>)): FallbackAsrCandidate {
  return {
    kind: kind as VoiceInputProviderKind,
    create: typeof provider === 'function' ? provider : async () => provider,
  };
}

const chunk = (byte: number): ArrayBuffer => new Uint8Array([byte]).buffer;

const accountRateLimit = (): Error => Object.assign(new Error('语音请求过于频繁'), {
  code: 'RATE_LIMITED',
  statusCode: 429,
});

describe('FallbackAsrProvider', () => {
  beforeEach(() => {
    resetVoiceInputProviderHealthForTests();
  });

  it.each([
    { managed: true, error: accountRateLimit(), limited: true },
    { managed: true, error: new Error('network down'), limited: false },
    { managed: false, error: accountRateLimit(), limited: false },
  ])('preserves the recovery cause and recognized text through the controller (%#)', async ({ managed, error, limited }) => {
    const primary = makeMockProvider({ recover: async () => { throw error; } });
    const backup = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', primary),
      candidate('litellm-qwen3-asr-flash-realtime', backup),
    ], { sharedAccountRateLimit: managed });
    const onError = vi.fn();
    const submitted: string[] = [];
    const controller = new VoiceInputController({
      asr: fallback,
      logger: new VoiceTimelineLogger(),
      recoveryErrorMessage: managed ? getVoiceInputRateLimitMessage : undefined,
      callbacks: {
        onDraftChanged: () => {},
        onSubmitted: (text, segment) => {
          submitted.push(text);
          return { id: 'range', segmentIds: [segment.id], startOffset: 0, endOffset: text.length, userTouched: false };
        },
        onError,
      },
    });
    try {
      await controller.start();
      primary.emit({ type: 'partial', text: 'keep these words', at: Date.now() });
      primary.emit({ type: 'disconnected', at: Date.now() });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(onError).toHaveBeenCalledWith(
        limited ? VOICE_INPUT_RATE_LIMITED_MESSAGE : 'Voice input stopped receiving recognition. Please try again.',
        limited ? undefined : 'recognition_stalled',
        { transcriptKept: true },
      );
      expect(submitted).toEqual(['keep these words']);
      expect(backup.start).not.toHaveBeenCalled();
      expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(!limited);
    } finally {
      await controller.cancel();
      await fallback.dispose();
    }
  });

  it.each(['create', 'start'] as const)('stops on shared account rate limits during %s without penalizing providers', async (phase) => {
    const error = accountRateLimit();
    const first = makeMockProvider({ startError: error });
    const createBackup = vi.fn(async () => makeMockProvider());
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', phase === 'create' ? async () => { throw error; } : first),
      candidate('litellm-qwen3-asr-flash-realtime', createBackup),
    ], { hedgeDelayMs: null, sharedAccountRateLimit: true });

    await expect(fallback.start()).rejects.toBe(error);

    expect(createBackup).not.toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBeNull();
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(false);
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(false);
    if (phase === 'start') await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());

    // A subsequent user attempt can use the primary immediately, without
    // waiting for a provider cooldown introduced by this failed run.
    const retry = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider()),
    ], { sharedAccountRateLimit: true });
    await retry.start();
    expect(retry.activeProviderKind).toBe('litellm-volcengine-sauc-asr');
  });

  it('preserves earlier real failures but surfaces the later account rate limit unchanged', async () => {
    const error = accountRateLimit();
    const third = vi.fn(async () => makeMockProvider());
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ startError: new Error('connection refused') })),
      candidate('litellm-qwen3-asr-flash-realtime', makeMockProvider({ startError: error })),
      candidate('litellm-gpt-realtime-whisper', third),
    ], { hedgeDelayMs: null, sharedAccountRateLimit: true });

    await expect(fallback.start()).rejects.toBe(error);
    expect(third).not.toHaveBeenCalled();
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(true);
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(false);
  });

  it.each([
    { sharedAccountRateLimit: false, error: accountRateLimit() },
    { sharedAccountRateLimit: true, error: new Error('Upstream handshake failed: HTTP 429') },
  ])('keeps independent provider failures eligible for fallback (%#)', async ({ sharedAccountRateLimit, error }) => {
    const backup = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ startError: error })),
      candidate('litellm-qwen3-asr-flash-realtime', backup),
    ], { hedgeDelayMs: null, sharedAccountRateLimit });

    await fallback.start();
    expect(backup.start).toHaveBeenCalledOnce();
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(true);
  });

  it('does not penalize the active provider when recovery hits the shared account quota', async () => {
    const error = accountRateLimit();
    const backup = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ recover: async () => { throw error; } })),
      candidate('litellm-qwen3-asr-flash-realtime', backup),
    ], { sharedAccountRateLimit: true });

    await fallback.start();
    await expect(fallback.recover!()).rejects.toBe(error);
    expect(backup.start).not.toHaveBeenCalled();
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(false);
  });

  it.each(['create', 'start'] as const)('cleans up a hedged candidate that finishes %s after an account rate limit', async (phase) => {
    let rejectPrimary!: (error: Error) => void;
    let releaseBackup!: () => void;
    const primary = makeMockProvider({
      startGate: new Promise<void>((_resolve, reject) => { rejectPrimary = reject; }),
    });
    const backupGate = new Promise<void>((resolve) => { releaseBackup = resolve; });
    const backup = makeMockProvider({ startGate: phase === 'start' ? backupGate : undefined });
    const createBackup = vi.fn(async () => {
      if (phase === 'create') await backupGate;
      return backup;
    });
    const third = vi.fn(async () => makeMockProvider());
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', primary),
      candidate('litellm-qwen3-asr-flash-realtime', createBackup),
      candidate('litellm-gpt-realtime-whisper', third),
    ], { hedgeDelayMs: 1_000, sharedAccountRateLimit: true });
    vi.useFakeTimers();
    try {
      const error = accountRateLimit();
      const result = fallback.start().catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(createBackup).toHaveBeenCalledOnce();
      rejectPrimary(error);
      expect(await result).toBe(error);
      releaseBackup();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(backup.dispose).toHaveBeenCalledOnce();
      expect(third).not.toHaveBeenCalled();
      expect(fallback.activeProviderKind).toBeNull();
      expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(false);
      expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(false);
      if (phase === 'create') expect(backup.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the first candidate when it starts successfully and forwards its events', async () => {
    const first = makeMockProvider();
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-volcengine-sauc-asr');
    expect(second.start).not.toHaveBeenCalled();
    first.emit({ type: 'partial', text: 'hello', at: 1 });
    expect(events).toEqual([{ type: 'partial', text: 'hello', at: 1 }]);
    fallback.appendAudio(chunk(1));
    expect(first.appended).toHaveLength(1);
  });

  it('replays the connected event emitted during start() once the candidate wins', async () => {
    const callbacks: Array<(event: AsrEvent) => void> = [];
    const provider: AsrProvider = {
      start: vi.fn(async () => {
        // Real providers emit `connected` from inside start(), before the
        // wrapper has committed them as active.
        for (const callback of callbacks) callback({ type: 'connected', at: 7 });
      }),
      stop: vi.fn(async () => {}),
      appendAudio: vi.fn(),
      flushAudio: vi.fn(async () => {}),
      onEvent: (callback) => {
        callbacks.push(callback);
      },
    };
    const fallback = new FallbackAsrProvider([candidate('litellm-volcengine-sauc-asr', async () => provider)]);
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();

    expect(events).toEqual([{ type: 'connected', at: 7 }]);
  });

  it('drops the connected event of a losing candidate', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstCallbacks: Array<(event: AsrEvent) => void> = [];
    const first: AsrProvider = {
      start: vi.fn(async () => {
        await firstGate;
        for (const callback of firstCallbacks) callback({ type: 'connected', at: 1 });
      }),
      stop: vi.fn(async () => {}),
      appendAudio: vi.fn(),
      flushAudio: vi.fn(async () => {}),
      onEvent: (callback) => {
        firstCallbacks.push(callback);
      },
      dispose: vi.fn(async () => {}),
    };
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', async () => first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ], { hedgeDelayMs: 0 });
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();
    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
  });

  it('falls back to the next candidate when start() fails and suppresses events from the failed attempt', async () => {
    const first = makeMockProvider({ startError: new Error('dial failed') });
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);
    const events: AsrEvent[] = [];
    fallback.onEvent((event) => events.push(event));

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
    expect(first.dispose).toHaveBeenCalled();
    // Events leaking from the abandoned attempt must not reach the controller.
    first.emit({ type: 'error', message: 'late failure', at: 2 });
    expect(events).toEqual([]);
    second.emit({ type: 'connected', at: 3 });
    expect(events).toEqual([{ type: 'connected', at: 3 }]);
    // Sticky failover: the failed provider entered cooldown.
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-volcengine-sauc-asr')).toBe(true);
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(false);
  });

  it('falls back when candidate creation itself throws', async () => {
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', async () => {
        throw new Error('missing credential');
      }),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ]);

    await fallback.start();

    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
  });

  it('rejects with an aggregate of every candidate failure when the whole chain fails', async () => {
    const volcengineError = new Error('Volcengine SAUC ASR handshake failed: HTTP 404 (gw.example.com/volcengine/api/v3/sauc/bigmodel_async)');
    const qwenError = new Error('missing credential');
    const whisperError = new Error('Realtime ASR handshake failed: HTTP 404 (gw.example.com/openai/passthrough/v1/realtime)');
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ startError: volcengineError })),
      candidate('litellm-qwen3-asr-flash-realtime', async () => {
        throw qwenError;
      }),
      candidate('litellm-gpt-realtime-whisper', makeMockProvider({ startError: whisperError })),
    ]);

    const startError = await fallback.start().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    expect(startError).not.toBeNull();
    expect(startError!.message).toContain('All 3 voice input ASR providers failed to start');
    expect(startError!.message).toContain(
      '[litellm-volcengine-sauc-asr start] Volcengine SAUC ASR handshake failed: HTTP 404 (gw.example.com/volcengine/api/v3/sauc/bigmodel_async)',
    );
    expect(startError!.message).toContain('[litellm-qwen3-asr-flash-realtime create] missing credential');
    expect(startError!.message).toContain(
      '[litellm-gpt-realtime-whisper start] Realtime ASR handshake failed: HTTP 404 (gw.example.com/openai/passthrough/v1/realtime)',
    );
    // Original error objects (stack/cause, e.g. ECONNREFUSED) must survive
    // aggregation for logging/telemetry.
    expect(startError).toBeInstanceOf(AggregateError);
    expect((startError as AggregateError).errors).toEqual([volcengineError, qwenError, whisperError]);
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('keeps the original error object when a single-candidate chain fails', async () => {
    const original = new Error('only candidate down');
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', makeMockProvider({ startError: original })),
    ]);

    await expect(fallback.start()).rejects.toBe(original);
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('replays audio buffered before connect once a provider becomes active', async () => {
    const provider = makeMockProvider();
    const fallback = new FallbackAsrProvider([candidate('litellm-volcengine-sauc-asr', provider)]);

    fallback.appendAudio(chunk(1));
    fallback.appendAudio(chunk(2));
    await fallback.start();

    expect(provider.appended).toHaveLength(2);
    fallback.appendAudio(chunk(3));
    expect(provider.appended).toHaveLength(3);
  });

  it('dispose() during candidate creation prevents the provider from ever dialing', async () => {
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const provider = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      {
        kind: 'litellm-volcengine-sauc-asr' as VoiceInputProviderKind,
        create: async () => {
          await gate;
          return provider;
        },
      },
    ]);

    const startPromise = fallback.start();
    await fallback.dispose();
    releaseCreate();

    await expect(startPromise).rejects.toThrow('disposed during start');
    // The provider was created after disposal: it must be disposed without
    // start() ever being invoked.
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('dispose() during start() prevents committing a late-connecting candidate', async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const provider = makeMockProvider();
    (provider.start as ReturnType<typeof vi.fn>).mockImplementation(async () => gate);
    const fallback = new FallbackAsrProvider([candidate('litellm-volcengine-sauc-asr', provider)]);

    const startPromise = fallback.start();
    // Let the loop pass the create/pre-start guards and suspend inside
    // provider.start() before disposing — this exercises the post-connect
    // guard, not the cheaper pre-dial ones.
    while ((provider.start as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
      await Promise.resolve();
    }
    await fallback.dispose();
    releaseStart();

    await expect(startPromise).rejects.toThrow('disposed during start');
    // The late connection must be shut down, not leaked as a live session.
    expect(provider.stop).toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBeNull();
  });

  it('only exposes recover() when the active provider supports it, and marks cooldown on recover failure', async () => {
    const noRecover = makeMockProvider();
    const fallbackWithoutRecover = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', noRecover),
    ]);
    await fallbackWithoutRecover.start();
    expect(fallbackWithoutRecover.recover).toBeUndefined();

    resetVoiceInputProviderHealthForTests();
    const failingRecover = makeMockProvider({
      recover: async () => {
        throw new Error('recover exhausted');
      },
    });
    const fallbackWithRecover = new FallbackAsrProvider([
      candidate('litellm-qwen3-asr-flash-realtime', failingRecover),
    ]);
    await fallbackWithRecover.start();
    expect(typeof fallbackWithRecover.recover).toBe('function');
    await expect(fallbackWithRecover.recover!()).rejects.toThrow('recover exhausted');
    expect(isVoiceInputProviderCoolingDown('asr', 'litellm-qwen3-asr-flash-realtime')).toBe(true);
  });

  it('starts a delayed hedge when the primary is slow and disposes the losing attempt', async () => {
    let releasePrimary!: () => void;
    const primaryGate = new Promise<void>((resolve) => { releasePrimary = resolve; });
    const primary = makeMockProvider({ startGate: primaryGate });
    const backup = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', primary),
      candidate('litellm-qwen3-asr-flash-realtime', backup),
    ], { hedgeDelayMs: 10 });

    const startPromise = fallback.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backup.start).toHaveBeenCalledTimes(1);
    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
    expect(primary.stop).toHaveBeenCalled();
    expect(primary.dispose).toHaveBeenCalled();
    releasePrimary();
    await startPromise;
  });

  it('launches the next candidate immediately after an explicit start failure', async () => {
    const first = makeMockProvider({ startError: new Error('connection refused') });
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ], { hedgeDelayMs: 10_000 });

    await fallback.start();

    expect(second.start).toHaveBeenCalledTimes(1);
    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
  });

  it('does not wait for failed-candidate cleanup before starting the fallback', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const first = makeMockProvider({
      startError: new Error('connection refused'),
      stopGate,
    });
    const second = makeMockProvider();
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', first),
      candidate('litellm-qwen3-asr-flash-realtime', second),
    ], { hedgeDelayMs: null });

    await fallback.start();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(fallback.activeProviderKind).toBe('litellm-qwen3-asr-flash-realtime');
    releaseStop();
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
  });

  it('lets a slow single candidate finish on its own deadline instead of imposing a wrapper timeout', async () => {
    let releaseStart!: () => void;
    const slow = makeMockProvider({
      startGate: new Promise<void>((resolve) => {
        releaseStart = resolve;
      }),
    });
    const fallback = new FallbackAsrProvider([
      candidate('litellm-volcengine-sauc-asr', slow),
    ]);

    const startPromise = fallback.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fallback.activeProviderKind).toBeNull();
    expect(slow.stop).not.toHaveBeenCalled();

    releaseStart();
    await startPromise;

    expect(slow.start).toHaveBeenCalledTimes(1);
    expect(slow.stop).not.toHaveBeenCalled();
    expect(slow.dispose).not.toHaveBeenCalled();
    expect(fallback.activeProviderKind).toBe('litellm-volcengine-sauc-asr');
  });
});
