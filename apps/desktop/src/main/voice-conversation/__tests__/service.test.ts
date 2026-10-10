import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceConversationService } from '../service.js';
import { hasVoiceConversationLease } from '../lease.js';

const active: VoiceConversationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.end(1)));
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
    onSegment: vi.fn(),
    onEvent: vi.fn(),
  };
  const deps = {
    owner: vi.fn(() => 'owner-a'),
    hasDictation: vi.fn(() => false),
    assertCompanion: vi.fn(async () => {}),
    models: vi.fn(() => [{ id: 'tts', name: 'Speech' }]),
    createProvider: vi.fn(async () => provider),
    connection: () => ({ baseUrl: 'https://gateway.test/v1', apiKey: 'test-key' }),
    fetch: vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
    ),
    emit: vi.fn(),
  };
  const service = new VoiceConversationService(deps);
  active.push(service);
  return { service, deps, provider };
}

describe('local companion call ownership', () => {
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
    deps.models.mockReturnValue([]);
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
