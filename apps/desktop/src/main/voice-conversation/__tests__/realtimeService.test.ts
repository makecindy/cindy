import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { VoiceConversationService } from '../service.js';
import { hasVoiceConversationLease } from '../lease.js';
import type { CompanionCallDialogue } from '../dialogue.js';

vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({
  createOutboundHttpAgent: async () => undefined,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(protocol: 'qwen-audio-realtime' | 'openai-realtime' = 'qwen-audio-realtime') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener');
  const received: any[] = [];
  let peer!: WebSocket;
  const dialogue = {
    start: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    nativeContext: () => 'companion',
    beginNativeTurn: vi.fn(),
    nativeTurn: vi.fn(() => true),
    nativeHandoff: vi.fn(async () => true),
    nativeInterrupt: vi.fn(),
  };
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (bytes) => {
      const e = JSON.parse(bytes.toString());
      received.push(e);
      if (e.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
    });
  });
  const deps = {
    owner: vi.fn(() => 'owner-a'),
    hasDictation: () => false,
    assertCompanion: vi.fn(async () => {}),
    models: () => [],
    createDialogue: () => dialogue as unknown as CompanionCallDialogue,
    // The resolved route must override a forged/stale renderer protocol.
    realtimeConnection: () => ({
      protocol,
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    }),
    createProvider: vi.fn(async (): Promise<never> => {
      throw new Error('ASR must not start');
    }),
    connection: vi.fn((): never => {
      throw new Error('TTS must not start');
    }),
    fetch: vi.fn(),
    emit: vi.fn(),
  };
  const service = new VoiceConversationService(deps);
  cleanups.push(async () => {
    service.stopPreview(1);
    await service.end(1);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const selection = {
    mode: 'realtime' as const,
    providerId: 'byok',
    agent: 'codex' as const,
    modelId: 'qwen-audio-3.0-realtime-plus',
    protocol: 'openai-realtime' as const,
    voice: 'longanqian',
    botId: 'buddy',
    sessionId: 'canonical',
    callId: 'native-service',
  };
  return {
    service,
    deps,
    dialogue,
    selection,
    received,
    server,
    send: (e: object) => peer.send(JSON.stringify(e)),
  };
}

it('uses the native production call entrance with exact ownership, mute generations and lease cleanup', async () => {
  const f = await fixture();
  await f.service.start(1, f.selection);
  expect(f.deps.assertCompanion).toHaveBeenCalledWith('buddy', 'canonical');
  expect(f.received[0].session.input_audio_format).toBe('pcm');
  expect(f.deps.connection).not.toHaveBeenCalled();
  expect(f.deps.createProvider).not.toHaveBeenCalled();
  expect(hasVoiceConversationLease()).toBe(true);
  await expect(f.service.start(2, { ...f.selection, callId: 'second' })).rejects.toThrow('busy');
  expect(() => f.service.audio(2, f.selection.callId, new ArrayBuffer(640))).toThrow('call_ended');
  const muted = await f.service.setInputMuted(1, f.selection.callId, true);
  const unmuted = await f.service.setInputMuted(1, f.selection.callId, false);
  f.service.audio(1, f.selection.callId, new ArrayBuffer(640), undefined, muted.inputGeneration);
  f.service.audio(1, f.selection.callId, new ArrayBuffer(640), undefined, unmuted.inputGeneration);
  await vi.waitFor(() =>
    expect(f.received.filter((e) => e.type === 'input_audio_buffer.append')).toHaveLength(1),
  );
  f.deps.owner.mockReturnValue('owner-b');
  expect(() => f.service.audio(1, f.selection.callId, new ArrayBuffer(640))).toThrow('call_ended');
  await vi.waitFor(() => expect(hasVoiceConversationLease()).toBe(false));
  expect(f.dialogue.end).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(f.server.clients.size).toBe(0));
});

it('rejects a noncanonical companion before opening a socket or retaining the lease', async () => {
  const f = await fixture();
  f.deps.assertCompanion.mockRejectedValue(new Error('not_canonical'));
  await expect(f.service.start(1, f.selection)).rejects.toThrow('not_canonical');
  expect(f.received).toEqual([]);
  expect(f.server.clients.size).toBe(0);
  expect(hasVoiceConversationLease()).toBe(false);
});


it.each(['qwen-audio-realtime', 'openai-realtime'] as const)(
  'auditions over %s with a single text turn, no microphone or task, and streamed PCM',
  async (protocol) => {
    const f = await fixture(protocol);
    const preview = { ...f.selection, previewId: 'sample', text: 'Hello' };
    const started = f.service.startPreview(1, preview);
    await vi.waitFor(() => expect(f.received.map(e => e.type)).toEqual([
      'session.update', 'conversation.item.create', 'response.create',
    ]));
    const session = f.received[0].session;
    expect(session.voice ?? session.audio.output.voice).toBe(preview.voice);
    expect(session.tools).toBeUndefined();
    expect(f.received[1].item.content[0]).toMatchObject({type: 'input_text', text: expect.stringContaining('Hello')});
    const delta = protocol === 'openai-realtime' ? 'response.output_audio.delta' : 'response.audio.delta';
    f.send({ type: delta, delta: 'AQI=' });
    await expect(started).resolves.toEqual({sampleRate: 24000});
    await expect(f.service.readPreview(2, 'sample')).rejects.toThrow();
    expect(new Uint8Array((await f.service.readPreview(1, 'sample')).pcm)).toEqual(Uint8Array.of(1, 2));
    f.send({ type: 'response.done', response: { status: 'completed' } });
    await expect(f.service.readPreview(1, 'sample')).resolves.toMatchObject({done: true});
    f.service.stopPreview(1, 'sample');
    expect(hasVoiceConversationLease()).toBe(false);
    expect(f.dialogue.start).not.toHaveBeenCalled();
    expect(f.deps.createProvider).not.toHaveBeenCalled();
    expect(f.deps.connection).not.toHaveBeenCalled();
  },
);

it('cancels a realtime audition before audio and releases the socket and voice lease', async () => {
  const f = await fixture();
  const started = f.service.startPreview(1, { ...f.selection, previewId: 'first', text: 'Hello' });
  const rejected = expect(started).rejects.toThrow();
  await vi.waitFor(() => expect(f.received.at(-1)?.type).toBe('response.create'));
  f.service.stopPreview(1, 'first');
  await rejected;
  await vi.waitFor(() => expect(f.server.clients.size).toBe(0));
  expect(hasVoiceConversationLease()).toBe(false);
});
