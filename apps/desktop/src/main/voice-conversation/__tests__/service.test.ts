import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrSegment, AudioGate, AudioGateEmit } from '@cindy/voice-input-core';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { speechModels, resolveSpeechConnection, type SpeechCatalogDeps } from '../models.js';
import { VoiceConversationService } from '../service.js';
import type { SpeechConnection } from '../speech.js';
import { hasVoiceConversationLease } from '../lease.js';
import type { VoiceExitDecision } from '../../../shared/voiceConversation.js';
import type { VoiceExitClassification } from '../semanticExit.js';

const active: VoiceConversationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.end(1)));
  vi.useRealTimers();
});

const previewSelection = {
  previewId: 'preview-1',
  botId: 'bot',
  sessionId: 'canonical',
  modelId: 'tts',
  voice: 'alloy',
  text: 'voice sample',
};
// Unit regression: Gateway catalogs were empty for these authorized speech models.
// Exercise the service entrance so same-ID BYOK connections cannot inherit Gateway
// references; catalog reads must not trigger a paid preview or allocate ASR.
it.each(['elevenlabs/eleven_multilingual_v2', 'elevenlabs/eleven_v3', 'minimax/speech-2.8-turbo'])(
  'offers named references only on the Gateway route for %s',
  async (modelId) => {
    const { service, deps } = fixture();
    const catalog = await service.voices({ modelId });
    expect(catalog.source).toBe('reference');
    expect(catalog.voices).toHaveLength(4);
    expect(catalog.voices.every(({ id, name }) => id && name && id !== name)).toBe(true);
    expect(await service.voices({ providerId: 'xd', modelId })).toEqual(catalog);
    expect(await service.voices({ providerId: 'custom', agent: 'codex', modelId })).toEqual({
      source: 'manual',
      voices: [],
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createProvider).not.toHaveBeenCalled();
  },
);

describe('voice preview ownership', () => {
  it('synthesizes the exact selection without allocating ASR, and excludes concurrent calls', async () => {
    const { service, deps } = fixture();
    expect(await service.startPreview(1, { ...previewSelection, speed: 0.8 })).toEqual({ sampleRate: 24000 });
    expect(deps.assertCompanion).toHaveBeenCalledWith('bot', 'canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledWith(
      new URL('https://gateway.test/v1/audio/speech'),
      expect.objectContaining({
        body: JSON.stringify({
          model: 'tts',
          voice: 'alloy',
          input: 'voice sample',
          response_format: 'pcm',
          speed: 0.8,
        }),
      }),
    );
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    await expect(service.readPreview(2, 'preview-1')).rejects.toThrow('preview_ended');
    service.stopPreview(2, 'preview-1');
    expect(hasVoiceConversationLease()).toBe(true);
    expect((await service.readPreview(1, 'preview-1')).pcm.byteLength).toBe(2);
    service.stopPreview(1, 'preview-1');
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('cancels while companion authorization is pending without issuing a late paid request', async () => {
    const { service, deps } = fixture();
    let release!: () => void;
    deps.assertCompanion.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = service.startPreview(1, previewSelection);
    service.stopPreview(1, 'preview-1');
    release();
    await expect(pending).rejects.toThrow('preview_ended');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('checks eligibility and canonical ownership before preview execution', async () => {
    const { service, deps } = fixture();
    await expect(
      service.startPreview(1, { ...previewSelection, modelId: 'invented' }),
    ).rejects.toThrow('model_unavailable');
    deps.assertCompanion.mockRejectedValueOnce(new Error('not canonical'));
    await expect(service.startPreview(1, previewSelection)).rejects.toThrow('not canonical');
    deps.hasDictation.mockReturnValueOnce(true);
    await expect(service.startPreview(1, previewSelection)).rejects.toThrow('busy');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it.each(['owner', 'connection'] as const)('releases playback on a changed %s', async (change) => {
    const { service, deps } = fixture();
    await service.startPreview(1, previewSelection);
    if (change === 'owner') deps.owner.mockReturnValue('owner-b');
    else
      deps.connection.mockImplementation(() => {
        throw new Error('model_unavailable');
      });
    await expect(service.readPreview(1, 'preview-1')).rejects.toThrow();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('releases the lease on sender teardown and on the bounded preview deadline', async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    await service.startPreview(1, previewSelection);
    await service.end(1);
    expect(hasVoiceConversationLease()).toBe(false);
    await service.startPreview(1, previewSelection);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasVoiceConversationLease()).toBe(false);
  });
});
const selection = {
  callId: 'call-1',
  botId: 'bot',
  sessionId: 'canonical',
  modelId: 'tts',
  voice: 'alloy',
};

// The real call and message-playback entrances previously dropped speed before
// the shared transport. Both must carry the same preference on every sentence.
it.each(['start', 'startPlayback'] as const)('keeps synthesis speed through %s and sentence prefetch', async (method) => {
  const { service, deps } = fixture();
  await service[method](1, { ...selection, speed: 1.15 });
  await service.speak(1, selection.callId, 'sentence-1', 'First sentence.');
  await service.speak(1, selection.callId, 'sentence-2', 'Second sentence.');
  expect(deps.fetch).toHaveBeenCalledTimes(2);
  for (const [, request] of vi.mocked(deps.fetch as typeof fetch).mock.calls) {
    expect(JSON.parse(String(request?.body))).toMatchObject({ speed: 1.15 });
  }
});
function fixture() {
  const provider = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    appendAudio: vi.fn(),
    flushAudio: vi.fn(async () => {}),
    onSegment: vi.fn<(callback: (segment: AsrSegment) => void) => void>(),
    onEvent: vi.fn(),
  };
  const deps = {
    owner: vi.fn(() => 'owner-a'),
    hasDictation: vi.fn(() => false),
    hasReplyHook: vi.fn(() => false),
    classifyExit: vi.fn<(input: VoiceExitClassification) => Promise<VoiceExitDecision>>(
      async () => true,
    ),
    assertCompanion: vi.fn(async () => {}),
    models: vi.fn(() => [{ id: 'tts', name: 'Speech' }]),
    createProvider: vi.fn(async () => provider),
    createAudioGate: vi.fn<(onFiltered: () => void) => AudioGate | undefined>(() => undefined),
    connection: vi.fn<() => SpeechConnection>(() => ({
      baseUrl: 'https://gateway.test/v1',
      protocol: 'openai' as const,
      headers: { authorization: 'Bearer test-key' },
    })),
    fetch: vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
    ),
    emit: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  const service = new VoiceConversationService(deps);
  active.push(service);
  return { service, deps, provider };
}

// Production call service + real ASR finalization; only classification/network
// seams are mocked. Rule: semantic judgments belong to one call/input/final.
// Unit tier, fake time; no account data, audio devices or paid requests.
describe('semantic exit call ownership', () => {
  const final = async (
    f: ReturnType<typeof fixture>,
    text = 'Talk later',
    segmentId: string = crypto.randomUUID(),
  ) => {
    f.provider.onSegment.mock.calls.at(-1)![0]({ id: segmentId, text, final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    return f.deps.emit.mock.calls.filter(([, e]) => e.event.type === 'utterance').at(-1)![1].event
      .id as string;
  };

  it('only judges a recognized final once, on its exact active call and capture generation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.start(1, selection);
    const id = await final(f);
    await expect(f.service.classifyExit(2, selection.callId, id, 0)).rejects.toThrow();
    expect(await f.service.classifyExit(1, selection.callId, id, 1)).toBe(false);
    expect(await f.service.classifyExit(1, selection.callId, 'invented', 0)).toBe(false);
    expect(f.deps.classifyExit).not.toHaveBeenCalled();
    expect(await f.service.classifyExit(1, selection.callId, id, 0)).toBe(true);
    expect(f.deps.classifyExit).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot',
        sessionId: 'canonical',
        text: 'Talk later',
        callId: selection.callId,
      }),
    );
    expect(await f.service.classifyExit(1, selection.callId, id, 0)).toBe(false);
    expect(f.deps.classifyExit).toHaveBeenCalledOnce();
    expect(f.provider.stop).not.toHaveBeenCalled(); // classification alone never exits
  });

  it.each(
    (['speech', 'mute', 'end', 'owner'] as const).flatMap((change) =>
      ([true, 'submit_then_exit'] as const).map((decision) => ({ change, decision })),
    ),
  )('discards late $decision after $change', async ({ change, decision }) => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (result: VoiceExitDecision) => void;
    f.deps.classifyExit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.service.start(1, selection);
    const id = await final(f);
    const pending = f.service.classifyExit(1, selection.callId, id, 0);
    const request = f.deps.classifyExit.mock.calls[0]![0];
    if (change === 'speech')
      f.provider.onSegment.mock.calls[0]![0]({ id: 'next', text: 'wait', final: false });
    else if (change === 'mute') await f.service.setInputMuted(1, selection.callId, true);
    else if (change === 'owner') f.deps.owner.mockReturnValue('another-owner');
    else {
      await f.service.end(1, selection.callId);
      await f.service.start(1, { ...selection, callId: 'new-call' });
    }
    expect(request.isCurrent()).toBe(false);
    if (change !== 'owner') expect(request.signal.aborted).toBe(true);
    finish(decision);
    expect(await pending).toBe(false);
  });

  it('returns submit-then-exit only for the recognized final without ending the call itself', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.classifyExit.mockResolvedValue('submit_then_exit');
    await f.service.start(1, selection);
    const id = await final(f, '帮我查资料，然后退出语音模式');
    expect(await f.service.classifyExit(1, selection.callId, id, 0)).toBe('submit_then_exit');
    expect(await f.service.classifyExit(1, selection.callId, id, 0)).toBe(false);
    expect(f.provider.stop).not.toHaveBeenCalled();
  });

  it('skips playback-only calls, drafts and over-budget text without truncating it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.service.startPlayback(1, selection);
    expect(await f.service.classifyExit(1, selection.callId, '1', 0)).toBe(false);
    await f.service.end(1);
    await f.service.start(1, selection);
    f.provider.onSegment.mock.calls[0]![0]({ id: 'partial', text: 'Talk later', final: false });
    expect(await f.service.classifyExit(1, selection.callId, 'partial', 0)).toBe(false);
    const id = await final(f, 'a'.repeat(513), 'partial');
    expect(await f.service.classifyExit(1, selection.callId, id, 0)).toBe(false);
    expect(f.deps.classifyExit).not.toHaveBeenCalled();
  });
});

describe('message read-aloud ownership', () => {
  it('reuses synthesis without creating ASR and cannot be unmuted into a conversation', async () => {
    const { service, deps } = fixture();
    await service.startPlayback(1, selection);
    expect(deps.assertCompanion).toHaveBeenCalledWith('bot', 'canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createAudioGate).not.toHaveBeenCalled();
    await expect(service.setInputMuted(1, selection.callId, false)).rejects.toThrow(
      'playback_only',
    );
    service.audio(1, selection.callId, new ArrayBuffer(2));
    service.finishUtterance(1, selection.callId);
    await service.speak(1, selection.callId, 'reply', 'existing reply');
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect((await service.readSpeech(1, selection.callId, 'reply')).pcm.byteLength).toBe(2);
    expect(deps.createProvider).not.toHaveBeenCalled();
    await service.end(1, selection.callId);
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('retains exclusive ownership against calls, previews, dictation and other renderers', async () => {
    const { service, deps } = fixture();
    deps.hasDictation.mockReturnValueOnce(true);
    await expect(service.startPlayback(1, selection)).rejects.toThrow('busy');
    await service.startPlayback(1, selection);
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    await expect(service.startPreview(1, previewSelection)).rejects.toThrow('busy');
    await expect(service.startPlayback(2, selection)).rejects.toThrow('busy');
    await expect(service.speak(2, selection.callId, 'reply', 'text')).rejects.toThrow('call_ended');
    await service.end(2, selection.callId);
    expect(hasVoiceConversationLease()).toBe(true);
    deps.owner.mockReturnValue('owner-b');
    await expect(service.speak(1, selection.callId, 'reply', 'text')).rejects.toThrow('call_ended');
    await vi.waitFor(() => expect(hasVoiceConversationLease()).toBe(false));
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('validates the model and canonical companion, and drops a cancelled pending open', async () => {
    const { service, deps } = fixture();
    await expect(service.startPlayback(1, { ...selection, modelId: 'missing' })).rejects.toThrow(
      'model_unavailable',
    );
    deps.assertCompanion.mockRejectedValueOnce(new Error('not canonical'));
    await expect(service.startPlayback(1, selection)).rejects.toThrow('not canonical');
    let release!: () => void;
    deps.assertCompanion.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const old = service.startPlayback(1, selection);
    await service.end(1, selection.callId);
    await service.startPlayback(1, { ...selection, callId: 'replacement' });
    release();
    await expect(old).rejects.toThrow('call_ended');
    await service.speak(1, 'replacement', 'reply', 'current');
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.createProvider).not.toHaveBeenCalled();
  });
});

describe('local companion call ownership', () => {
  // Startup failure must release the real service's ASR and lease before retry.
  // Existing ownership tests did not cover rejection after ASR allocation.
  // Unit tier, failed provider only; diagnostics must not expose its error text.
  it('cleans up a failed input start, logs its stage, and allows another call', async () => {
    const { service, deps, provider } = fixture();
    provider.start.mockRejectedValueOnce(new Error('private upstream response'));
    await expect(service.start(1, selection)).rejects.toThrow();
    expect(hasVoiceConversationLease()).toBe(false);
    expect(deps.log.warn).toHaveBeenCalledWith('call start failed', {
      callId: selection.callId, stage: 'input', elapsedMs: expect.any(Number),
    });
    expect(JSON.stringify(deps.log.warn.mock.calls)).not.toContain('private upstream response');
    expect(deps.emit).toHaveBeenCalledWith(1, {
      callId: selection.callId, event: { type: 'ended' },
    });
    expect(provider.dispose).toHaveBeenCalled();
    await expect(service.start(1, { ...selection, callId: 'retry' })).resolves.toEqual({ callId: 'retry' });
    expect(hasVoiceConversationLease()).toBe(true);
  });

  it('checks outgoing reply hooks before every unfinished request without issuing paid synthesis', async () => {
    const { service, deps } = fixture();
    await service.start(1, selection);
    deps.hasReplyHook.mockReturnValue(true);
    expect(await service.speak(1, selection.callId, 'early', 'original', true)).toEqual({
      deferred: true,
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await service.speak(1, selection.callId, 'final', 'processed')).toEqual({
      sampleRate: 24000,
    });
    expect(deps.fetch).toHaveBeenCalledOnce();
    await expect(service.speak(2, selection.callId, 'other', 'private', true)).rejects.toThrow(
      'call_ended',
    );
  });

  it('keeps playing and prefetched streams independent, bounds lookahead, and releases completed slots', async () => {
    const { service, deps } = fixture();
    await service.start(1, selection);
    await service.speak(1, selection.callId, 'one', 'one', true);
    await service.speak(1, selection.callId, 'two', 'two', true);
    await expect(service.speak(1, selection.callId, 'three', 'three', true)).rejects.toThrow();
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect((await service.readSpeech(1, selection.callId, 'one')).pcm.byteLength).toBe(2);
    expect((await service.readSpeech(1, selection.callId, 'one')).done).toBe(true);
    await service.speak(1, selection.callId, 'three', 'three', true);
    expect((await service.readSpeech(1, selection.callId, 'two')).pcm.byteLength).toBe(2);
    service.interrupt(1, selection.callId);
    await expect(service.readSpeech(1, selection.callId, 'two')).rejects.toThrow();
    await expect(service.readSpeech(1, selection.callId, 'three')).rejects.toThrow();
  });

  // Unit regression: MP3 completes during start/prefetch rather than readSpeech.
  // Retaining those slots would make the third sentence fail as a full queue.
  it('releases completed MP3 prefetch slots without requiring a PCM read', async () => {
    const { service, deps } = fixture();
    const modelId = 'minimax/speech-2.8-turbo';
    deps.models.mockReturnValue([{ id: modelId, name: 'MiniMax speech' }]);
    deps.connection.mockReturnValue({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', headers: {} });
    deps.fetch.mockImplementation(async () => new Response(new Uint8Array([0xff, 0xfb, 1]), {
      headers: { 'Content-Type': 'audio/mpeg' },
    }));
    await service.start(1, { ...selection, modelId });
    const ready = await Promise.all(['one', 'two'].map(id => service.speak(1, selection.callId, id, id, true)));
    expect(ready).toEqual(Array.from({ length: 2 }, () => ({ format: 'mp3', data: new Uint8Array([0xff, 0xfb, 1]).buffer })));
    await expect(service.speak(1, selection.callId, 'three', 'three', true)).resolves.toHaveProperty('format', 'mp3');
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    await expect(service.readSpeech(1, selection.callId, 'three')).rejects.toThrow('cancelled');
  });

  it('cancels pending lookahead headers and prevents their late audio from joining a new reply', async () => {
    const { service, deps } = fixture();
    let headers!: (response: Response) => void;
    await service.start(1, selection);
    await service.speak(1, selection.callId, 'playing', 'one', true);
    deps.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          headers = resolve;
        }),
    );
    const pending = service.speak(1, selection.callId, 'lookahead', 'two', true);
    const rejected = expect(pending).rejects.toThrow();
    service.interrupt(1, selection.callId);
    await service.speak(1, selection.callId, 'new', 'three', true);
    headers(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }));
    await rejected;
    expect((await service.readSpeech(1, selection.callId, 'new')).pcm.byteLength).toBe(2);
    await expect(service.readSpeech(1, selection.callId, 'lookahead')).rejects.toThrow();
  });

  it('logs send timing and speech stages through the injected logger without content or credentials', async () => {
    vi.useFakeTimers();
    const { service, deps, provider } = fixture();
    await service.start(1, selection);
    provider.onSegment.mock.calls[0][0]({ id: 'segment', text: 'private utterance', final: true });
    await vi.advanceTimersByTimeAsync(1_250);
    expect(deps.log.info).toHaveBeenCalledWith('input settled', {
      callId: selection.callId,
      inputGeneration: 0,
      trigger: 'silence',
      inactiveMs: 1_250,
      pauseBasis: 'text-fallback',
      endpointing: 'segment-final',
      endSignal: 'segment-final',
      finalStableMs: 1_250,
      segments: 1,
      characters: 17,
    });
    await service.speak(1, selection.callId, 'request-1', 'private reply');
    await service.readSpeech(1, selection.callId, 'request-1');
    await service.readSpeech(1, selection.callId, 'request-1');
    expect(deps.log.info).toHaveBeenCalledWith(
      'speech transport',
      expect.objectContaining({
        callId: selection.callId,
        requestId: 'request-1',
        protocol: 'openai',
        stage: 'complete',
        bytes: 2,
      }),
    );
    const logs = JSON.stringify([
      ...deps.log.debug.mock.calls, ...deps.log.info.mock.calls, ...deps.log.warn.mock.calls,
    ]);
    for (const privateValue of [
      'private utterance',
      'private reply',
      'test-key',
      'gateway.test',
      'alloy',
    ])
      expect(logs).not.toContain(privateValue);
  });

  // Office-noise report: settled-only logs had no evidence while ASR was pending.
  // Real service/input + one partial segment, unit/fake time; verify the logger
  // boundary and cleanup without recording speech, IDs or provider credentials.
  // Measured: this file runs in 0.60s wall time (39 tests, 192ms test time).
  it('writes rate-limited blocked input diagnostics to the existing debug logger', async () => {
    vi.useFakeTimers();
    const { service, deps, provider } = fixture();
    await service.start(1, selection);
    provider.onSegment.mock.calls[0][0]({
      id: 'private-segment', text: 'private utterance', final: false,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(deps.log.debug).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.log.debug).toHaveBeenCalledExactlyOnceWith(
      'input settlement blocked',
      expect.objectContaining({
        callId: selection.callId, inputGeneration: 0,
        reasons: ['asr-final'], pendingFinalSegments: 1, characters: 17,
      }),
    );
    const logs = JSON.stringify(deps.log.debug.mock.calls);
    for (const value of ['private-segment', 'private utterance', 'test-key', 'gateway.test'])
      expect(logs).not.toContain(value);
    await service.end(1, selection.callId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.log.debug).toHaveBeenCalledOnce();
  });

  // 14:39 acceptance failure: every ASR error previously looked like
  // "connection". Real service/input, fake clock and upstream events verify
  // reason classification, preserved draft and the existing logger's privacy
  // boundary. Earlier coverage only checked waiting, never terminal causes.
  it.each(['final_timeout', 'upstream_disconnected', 'upstream_error'] as const)(
    'diagnoses %s once and preserves the unsent text without logging provider content',
    async (reason) => {
      vi.useFakeTimers();
      const { service, deps, provider } = fixture();
      await service.start(1, selection);
      const segment = provider.onSegment.mock.calls[0][0];
      const event = provider.onEvent.mock.calls[0][0];
      segment({ id: 'private-segment', text: 'private utterance', final: false });
      if (reason === 'final_timeout') {
        service.finishUtterance(1, selection.callId);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(deps.log.warn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else {
        event({ type: reason === 'upstream_error' ? 'error' : 'disconnected',
          message: 'private upstream error Bearer test-key', at: Date.now() });
      }
      expect(deps.log.warn).toHaveBeenCalledWith('input failed', {
        callId: selection.callId, inputGeneration: 0,
        reason, endpointing: 'segment-final', generation: 1,
        manual: reason === 'final_timeout', rotating: false, speaking: false,
        segments: 1, pendingFinalSegments: 1, characters: 17,
        pendingMs: reason === 'final_timeout' ? 8_000 : 0,
        finalWaitMs: reason === 'final_timeout' ? 8_000 : null,
        asrUpdateAgeMs: reason === 'final_timeout' ? 8_000 : 0,
        bufferedAudioMs: 0,
      });
      expect(deps.emit).toHaveBeenCalledWith(1, {
        callId: selection.callId, inputGeneration: 0,
        event: { type: 'error', text: 'private utterance' },
      });
      event({ type: 'disconnected', at: Date.now() });
      segment({ id: 'private-segment', text: 'late final', final: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(deps.log.warn.mock.calls.filter(([name]) => name === 'input failed')).toHaveLength(1);
      expect(deps.emit.mock.calls.some(([, value]) => value.event.type === 'utterance')).toBe(false);
      const logs = JSON.stringify([...deps.log.debug.mock.calls, ...deps.log.info.mock.calls, ...deps.log.warn.mock.calls]);
      for (const value of ['private-segment', 'private utterance', 'private upstream error', 'test-key'])
        expect(logs).not.toContain(value);
    },
  );

  it('requires a real available speech model and the canonical companion task before allocating ASR', async () => {
    const { service, deps } = fixture();
    await expect(service.start(1, { ...selection, modelId: 'invented' })).rejects.toThrow(
      'model_unavailable',
    );
    deps.assertCompanion.mockRejectedValueOnce(new Error('not canonical'));
    await expect(service.start(1, selection)).rejects.toThrow('not canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('blocks concurrent dictation/calls and binds all operations to the initiating renderer', async () => {
    const { service, deps, provider } = fixture();
    deps.hasDictation.mockReturnValueOnce(true);
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    const { callId } = await service.start(1, selection);
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    expect(() => service.audio(2, callId, new ArrayBuffer(2))).toThrow('call_ended');
    await service.end(2, callId);
    expect(provider.stop).not.toHaveBeenCalled();
    await service.end(1, callId);
    expect(provider.stop).toHaveBeenCalledOnce();
  });

  it('invalidates the old call and releases the microphone on account change', async () => {
    const { service, deps, provider } = fixture();
    const { callId } = await service.start(1, selection);
    deps.owner.mockReturnValue('owner-b');
    expect(() => service.audio(1, callId, new ArrayBuffer(2))).toThrow('call_ended');
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledOnce());
    expect(deps.emit).toHaveBeenCalledWith(1, { callId, event: { type: 'ended' } });
  });

  it('rechecks catalog eligibility before speech dispatch', async () => {
    const { service, deps } = fixture();
    const { callId } = await service.start(1, selection);
    deps.connection.mockImplementation(() => {
      throw new Error('model_unavailable');
    });
    await expect(service.speak(1, callId, 'request', 'hello')).rejects.toThrow('model_unavailable');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('cancels a pending provider allocation without starting a stale microphone session', async () => {
    const { service, deps, provider } = fixture();
    let resolve!: (value: typeof provider) => void;
    deps.createProvider.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const starting = service.start(1, selection);
    await vi.waitFor(() => expect(deps.createProvider).toHaveBeenCalledOnce());
    await service.end(1);
    resolve(provider);
    await expect(starting).rejects.toThrow('call_ended');
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalledOnce();
  });
});

it('pins the selected connection and stops before sending to changed credentials or endpoints', async () => {
  const { service, deps } = fixture();
  await service.start(1, selection);
  deps.connection.mockReturnValue({
    baseUrl: 'https://changed.test/v1',
    protocol: 'openai',
    headers: { authorization: 'Bearer different-key' },
  });
  await expect(service.speak(1, selection.callId, 'req', 'private reply')).rejects.toThrow(
    'connection_changed',
  );
  expect(deps.fetch).not.toHaveBeenCalled();
});

it('cancels an existing body when credentials change before a PCM read', async () => {
  const { service, deps } = fixture();
  const cancelled = vi.fn();
  deps.fetch.mockImplementation(
    async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
        headers: { 'Content-Type': 'audio/pcm' },
      }),
  );
  await service.start(1, selection);
  await service.speak(1, selection.callId, 'req', 'hello');
  deps.connection.mockImplementation(() => {
    throw new Error('model_unavailable');
  });
  await expect(service.readSpeech(1, selection.callId, 'req')).rejects.toThrow('model_unavailable');
  expect(cancelled).toHaveBeenCalledOnce();
});

describe('input-only mute', () => {
  // Real call service/input; a held gate callback models delayed inference.
  // Existing mute tests only delayed ASR, so they missed pre-ASR voiceprint work.
  // Unit, in-memory: a 200ms held voice must not revive a muted/ended/other-owner
  // call, interrupt TTS, or reach the new microphone's ASR after unmute. Its
  // late "ignored another voice" notice is fenced the same way.
  it.each(['mute', 'end', 'owner'] as const)(
    'fences delayed filtered audio and its notice on %s and rereads filter availability on unmute',
    async (action) => {
      const { service, deps, provider } = fixture();
      let release!: AudioGateEmit;
      const audioGate = {
        begin: (callback: AudioGateEmit) => {
          release = callback;
        },
        push: vi.fn(),
        finish: vi.fn(async () => {}),
        abort: vi.fn(),
      };
      let filtered!: () => void;
      deps.createAudioGate.mockImplementationOnce((onFiltered) => {
        filtered = onFiltered;
        return audioGate;
      });
      await service.start(1, selection);
      await service.speak(1, selection.callId, 'reply', 'keep reading');
      const voice = new Int16Array(3_200).fill(2_000).buffer;
      service.audio(1, selection.callId, voice);
      expect(provider.appendAudio).not.toHaveBeenCalled();
      filtered();
      expect(deps.emit).toHaveBeenCalledWith(1, expect.objectContaining({
        callId: selection.callId,
        event: { type: 'speaker-filtered' },
      }));
      if (action === 'mute') await service.setInputMuted(1, selection.callId, true);
      else if (action === 'end') await service.end(1, selection.callId);
      else deps.owner.mockReturnValue('owner-b');
      deps.emit.mockClear();
      release(voice);
      filtered();
      expect(provider.appendAudio).not.toHaveBeenCalled();
      expect(deps.emit).not.toHaveBeenCalled();
      expect(audioGate.finish).not.toHaveBeenCalled();
      if (action !== 'owner') expect(audioGate.abort).toHaveBeenCalledOnce();
      if (action === 'mute') {
        expect((await service.readSpeech(1, selection.callId, 'reply')).pcm.byteLength).toBe(2);
        // The shared switch/profile may have changed while muted: undefined
        // retains normal input, with no second companion setting to override it.
        const { inputGeneration } = await service.setInputMuted(1, selection.callId, false);
        expect(deps.createAudioGate).toHaveBeenCalledTimes(2);
        release(voice);
        expect(provider.appendAudio).not.toHaveBeenCalled();
        service.audio(1, selection.callId, voice, undefined, inputGeneration);
        expect(provider.appendAudio).toHaveBeenCalledExactlyOnceWith(voice, undefined);
        expect(deps.emit).toHaveBeenCalledWith(1, {
          callId: selection.callId,
          inputGeneration,
          event: { type: 'speech-started' },
        });
        expect(deps.log.info).toHaveBeenCalledWith('input filter configured', {
          callId: selection.callId,
          inputGeneration,
          speakerFilterActive: false,
        });
      }
    },
  );

  it('releases ASR, keeps synthesis and lease, and isolates resumed input from old PCM/results', async () => {
    vi.useFakeTimers();
    const { service, deps, provider } = fixture();
    await service.start(1, selection);
    const oldSegment = provider.onSegment.mock.calls[0][0];
    oldSegment({ id: 'old', text: 'do not send', final: true });
    await service.speak(1, selection.callId, 'reply', 'keep reading');
    await expect(service.setInputMuted(2, selection.callId, true)).rejects.toThrow('call_ended');
    expect(await service.setInputMuted(1, selection.callId, true)).toEqual({ inputGeneration: 1 });
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(provider.dispose).toHaveBeenCalledOnce();
    expect(hasVoiceConversationLease()).toBe(true);
    expect((await service.readSpeech(1, selection.callId, 'reply')).pcm.byteLength).toBe(2);
    deps.emit.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.emit).not.toHaveBeenCalled();
    expect(await service.setInputMuted(1, selection.callId, false)).toEqual({ inputGeneration: 2 });
    expect(provider.start).toHaveBeenCalledTimes(2);
    oldSegment({ id: 'late', text: 'stale result', final: true });
    service.audio(1, selection.callId, new ArrayBuffer(2), undefined, 0);
    expect(provider.appendAudio).not.toHaveBeenCalled();
    service.audio(1, selection.callId, new ArrayBuffer(2), undefined, 2);
    expect(provider.appendAudio).toHaveBeenCalledOnce();
    deps.emit.mockClear();
    provider.onSegment.mock.calls[1][0]({ id: 'new', text: 'new input', final: true });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(deps.emit.mock.calls.filter(([, e]) => e.event.type === 'utterance')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.emit).toHaveBeenCalledWith(1, {
      callId: selection.callId,
      inputGeneration: 2,
      event: { type: 'utterance', id: '1', text: 'new input' },
    });
  });

  it('keeps the call usable for speech after an ASR resume failure', async () => {
    const { service, deps } = fixture();
    await service.start(1, selection);
    await service.setInputMuted(1, selection.callId, true);
    deps.createProvider.mockRejectedValueOnce(new Error('offline'));
    await expect(service.setInputMuted(1, selection.callId, false)).rejects.toThrow('offline');
    expect(hasVoiceConversationLease()).toBe(true);
    expect(await service.speak(1, selection.callId, 'reply', 'still reading')).toEqual({
      sampleRate: 24000,
    });
    await service.setInputMuted(1, selection.callId, false);
    expect(deps.createProvider).toHaveBeenCalledTimes(3);
  });

  it.each(['mute', 'end'] as const)(
    'disposes a late ASR allocation after %s without blocking the action',
    async (action) => {
      const { service, deps, provider } = fixture();
      await service.start(1, selection);
      await service.setInputMuted(1, selection.callId, true);
      let allocated!: (value: typeof provider) => void;
      deps.createProvider.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            allocated = resolve;
          }),
      );
      const restoring = service.setInputMuted(1, selection.callId, false);
      const rejected = expect(restoring).rejects.toThrow('input_ended');
      await vi.waitFor(() => expect(deps.createProvider).toHaveBeenCalledTimes(2));
      if (action === 'end') await service.end(1);
      else await service.setInputMuted(1, selection.callId, true);
      allocated(provider);
      await rejected;
      expect(provider.start).toHaveBeenCalledOnce();
      expect(provider.dispose).toHaveBeenCalledTimes(2);
      expect(hasVoiceConversationLease()).toBe(action === 'mute');
      if (action === 'mute') await service.setInputMuted(1, selection.callId, false);
    },
  );
});

// Review regression: real catalog admission + service starts, not a direct resolver
// assertion. Hiding a saved route must not revoke it; disabling it must. Unit tier,
// mock ASR/transport only, no devices, credentials or paid network requests.
it.each(['startPreview', 'start', 'startPlayback'] as const)(
  'keeps a hidden saved speech route usable through %s, but rejects a disabled route',
  async (method) => {
    const { service, deps } = fixture();
    const catalog: SpeechCatalogDeps = {
      catalog: { ...BUNDLED_CATALOG, providers: [buildUserProvider({
        id: 'speech', name: 'Speech', runtimes: { codex: {
          baseUrl: 'https://api.openai.com/v1', models: [{ id: 'tts', name: 'Speech', mode: 'audio_speech', defaultEnabled: false }],
        } },
      })] },
      gatewayAllowed: false, disabled: () => false, visibilityOverride: () => false,
      gatewayConnection: () => ({ baseUrl: '', apiKey: '' }), readKey: () => 'fake-test-key',
    };
    const saved = { ...selection, ...previewSelection, providerId: 'speech', agent: 'codex' as const };
    deps.models.mockImplementation(() => speechModels(catalog));
    deps.connection.mockImplementation(() => resolveSpeechConnection(catalog, saved));
    await expect(service[method](1, saved)).resolves.toBeDefined();
    expect(deps.connection).toHaveBeenCalled();
    await service.end(1);
    deps.fetch.mockClear();
    deps.createProvider.mockClear();
    catalog.disabled = () => true;
    await expect(service[method](1, saved)).rejects.toThrow('model_unavailable');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  },
);
