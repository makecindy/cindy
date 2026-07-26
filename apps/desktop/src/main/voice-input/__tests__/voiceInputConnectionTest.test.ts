import type { AsrProvider } from '@cindy/voice-input-core';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyVoiceInputConnectionTestError,
  runVoiceInputConnectionTest,
  runSerializedVoiceInputConnectionTest,
} from '../voiceInputConnectionTest.js';

function providerWith(options?: {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  dispose?: () => Promise<void>;
}): AsrProvider {
  return {
    start: options?.start ?? vi.fn(async () => undefined),
    stop: options?.stop ?? vi.fn(async () => undefined),
    dispose: options?.dispose,
  } as unknown as AsrProvider;
}

describe('voice input connection test', () => {
  it.each([
    ['HTTP 401 Unauthorized', 'authentication-failed'],
    ['API key is required for LiteLLM realtime voice input.', 'credentials-missing'],
    ['Realtime ASR handshake failed: HTTP 404 Not Found', 'route-unavailable'],
    ['Realtime ASR connection timed out after 5000ms', 'timeout'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'network'],
    ['upstream rejected the session', 'service-error'],
  ] as const)('classifies %s', (message, expected) => {
    expect(classifyVoiceInputConnectionTestError(new Error(message))).toBe(expected);
  });

  it('starts and closes the selected provider without sending audio', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const createProvider = vi.fn(async () => providerWith({ start, stop, dispose }));

    await expect(runVoiceInputConnectionTest({
      provider: 'litellm-qwen3-asr-flash-realtime',
      providerModel: 'qwen3-asr-flash-realtime',
      createProvider,
    })).resolves.toEqual({
      ok: true,
      provider: 'litellm-qwen3-asr-flash-realtime',
      providerModel: 'qwen3-asr-flash-realtime',
    });
    expect(createProvider).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns a sanitized failure and still closes the provider', async () => {
    const stop = vi.fn(async () => undefined);
    const onError = vi.fn();
    const upstreamError = new Error('Realtime ASR handshake failed: HTTP 403 Forbidden, secret detail');

    await expect(runVoiceInputConnectionTest({
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
      createProvider: async () => providerWith({
        start: async () => {
          throw upstreamError;
        },
        stop,
      }),
      onError,
    })).resolves.toEqual({
      ok: false,
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
      reason: 'authentication-failed',
    });
    expect(onError).toHaveBeenCalledWith(upstreamError);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent connection probes in Main', async () => {
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStart = vi.fn(async () => {
      await firstStarted;
    });
    const secondStart = vi.fn(async () => undefined);
    const firstCreate = vi.fn(async () => providerWith({ start: firstStart }));
    const secondCreate = vi.fn(async () => providerWith({ start: secondStart }));

    const first = runSerializedVoiceInputConnectionTest({
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
      createProvider: firstCreate,
    });
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledOnce());
    const second = runSerializedVoiceInputConnectionTest({
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
      createProvider: secondCreate,
    });

    await Promise.resolve();
    expect(secondCreate).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toEqual({
      ok: true,
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
    });
    await expect(second).resolves.toEqual({
      ok: true,
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
    });
    expect(secondCreate).not.toHaveBeenCalled();
  });

  it('rejects a concurrent probe for a different active configuration', async () => {
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstCreate = vi.fn(async () => {
      await firstStarted;
      return {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      } as unknown as AsrProvider;
    });
    const secondCreate = vi.fn(async () => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    } as unknown as AsrProvider));

    const first = runSerializedVoiceInputConnectionTest({
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
      configurationKey: 'selection-a',
      createProvider: firstCreate,
    });
    await Promise.resolve();

    await expect(runSerializedVoiceInputConnectionTest({
      provider: 'elevenlabs-scribe-realtime',
      providerModel: 'scribe_v2_realtime',
      configurationKey: 'selection-b',
      createProvider: secondCreate,
    })).resolves.toEqual({
      ok: false,
      provider: 'elevenlabs-scribe-realtime',
      providerModel: 'scribe_v2_realtime',
      reason: 'service-error',
    });
    expect(secondCreate).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toEqual({
      ok: true,
      provider: 'litellm-gpt-realtime-whisper',
      providerModel: 'gpt-realtime-whisper',
    });
  });
});
