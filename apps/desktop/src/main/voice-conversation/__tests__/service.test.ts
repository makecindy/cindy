import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrSegment } from '@cindy/voice-input-core';
import { VoiceConversationService } from '../service.js';
import { hasVoiceConversationLease } from '../lease.js';

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
describe('voice preview ownership', () => {
  it('synthesizes the exact selection without allocating ASR, and excludes concurrent calls', async () => {
    const { service, deps } = fixture();
    expect(await service.startPreview(1, previewSelection)).toEqual({ sampleRate: 24000 });
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
    assertCompanion: vi.fn(async () => {}),
    models: vi.fn(() => [{ id: 'tts', name: 'Speech' }]),
    createProvider: vi.fn(async () => provider),
    connection: vi.fn(() => ({
      baseUrl: 'https://gateway.test/v1',
      protocol: 'openai' as const,
      headers: { authorization: 'Bearer test-key' },
    })),
    fetch: vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
    ),
    emit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const service = new VoiceConversationService(deps);
  active.push(service);
  return { service, deps, provider };
}

describe('message read-aloud ownership', () => {
  it('reuses synthesis without creating ASR and cannot be unmuted into a conversation', async () => {
    const { service, deps } = fixture();
    await service.startPlayback(1, selection);
    expect(deps.assertCompanion).toHaveBeenCalledWith('bot', 'canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
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
    const logs = JSON.stringify([...deps.log.info.mock.calls, ...deps.log.warn.mock.calls]);
    for (const privateValue of [
      'private utterance',
      'private reply',
      'test-key',
      'gateway.test',
      'alloy',
    ])
      expect(logs).not.toContain(privateValue);
  });

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
