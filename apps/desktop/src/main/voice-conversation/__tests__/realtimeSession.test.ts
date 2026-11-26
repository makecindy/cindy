import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { VoiceCallContext } from '@cindy/maker-core';
import { RealtimeVoiceSession } from '../realtimeSession.js';
import { RealtimePcmResampler } from '../realtimeProtocol.js';
import type { RealtimeProtocol } from '../../../shared/realtimeVoice.js';

vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({
  createOutboundHttpAgent: async () => undefined,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
});

async function fixture(protocol: RealtimeProtocol) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener');
  const received: any[] = [];
  const events: any[] = [];
  const turns: any[] = [];
  let current = true;
  let peer!: WebSocket;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (bytes) => {
      const e = JSON.parse(bytes.toString());
      received.push(e);
      if (e.type === 'session.update')
        socket.send(JSON.stringify({ type: 'session.updated', session: e.session }));
    });
  });
  const handoff = vi.fn(async () => true);
  const context = new VoiceCallContext({
    callId: 'test', identity: 'Buddy', reference: '', changed: () => {},
    generate: vi.fn(), handoff: vi.fn(),
  });
  const session = new RealtimeVoiceSession({
    selection: {
      mode: 'realtime',
      protocol,
      providerId: 'test',
      agent: 'codex',
      modelId: protocol === 'glm-realtime' ? 'glm-realtime-flash' : protocol === 'openai-realtime' ? 'gpt-realtime-2' : 'qwen-audio-3.0-realtime-plus',
      voice: 'voice',
    },
    connection: () => ({ protocol, url: `ws://127.0.0.1:${address.port}`, headers: {} }),
    assertCurrent: () => {
      if (!current) throw new Error('owner_changed');
    },
    reference: 'Buddy reference',
    emit: (e) => events.push(e),
    beginTurn: (id) => context.beginNativeTurn(id),
    turn: (...args) => {
      turns.push(args);
      return context.recordNativeTurn(...args);
    },
    handoff,
    interrupted: vi.fn(),
  });
  cleanups.push(async () => {
    session.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await session.start();
  const send = (e: object) => peer.send(JSON.stringify(e));
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return {
    session,
    received,
    record: context.record,
    events,
    turns,
    handoff,
    send,
    flush,
    async drainEvents() {
      const pong = once(peer, 'pong');
      peer.ping();
      await pong;
    },
    changeOwner: () => {
      current = false;
    },
  };
}

describe.each<RealtimeProtocol>(['openai-realtime', 'qwen-audio-realtime', 'glm-realtime'])(
  '%s real loopback WebSocket',
  (protocol) => {
    it('configures the native protocol and streams 24 kHz audio without TTS', async () => {
      const f = await fixture(protocol);
      const config = f.received[0].session;
      if (protocol === 'openai-realtime') {
        expect(config.audio.input.format.rate).toBe(24000);
        expect(config.tools[0].name).toBe('handoff_task');
      } else if (protocol === 'glm-realtime') {
        expect(config).toMatchObject({ model: 'glm-realtime-flash', input_audio_format: 'pcm16',
          output_audio_format: 'pcm', turn_detection: { type: 'server_vad', create_response: false } });
        expect(config.tools[0].name).toBe('handoff_task');
      } else {
        expect(config.input_audio_format).toBe('pcm');
        expect(config.tools[0].function.name).toBe('handoff_task');
      }
      f.session.audio(new ArrayBuffer(640));
      await f.flush();
      const audio = f.received.find((e) => e.type === 'input_audio_buffer.append');
      expect(Buffer.from(audio.audio, 'base64').length).toBe(
        protocol === 'openai-realtime' ? 958 : 640,
      );
      f.send({ type: 'response.created', response: { id: 'response' } });
      f.send({
        type:
          protocol === 'openai-realtime' ? 'response.output_audio.delta' : 'response.audio.delta',
        response_id: 'response',
        item_id: 'answer',
        content_index: 0,
        delta: Buffer.alloc(480).toString('base64'),
      });
      f.send({ type: 'response.done', response: { id: 'response', status: 'completed' } });
      await f.flush();
      expect(f.events).toContainEqual({ type: 'realtime-audio', itemId: 'answer' });
      expect(await f.session.read('answer')).toEqual({ pcm: new ArrayBuffer(480), done: true });
    });

    it('keeps native turns in speaking order when multiple transcripts arrive late', async () => {
      const f = await fixture(protocol);
      const reply = (id: string, text: string, done = true) => f.send({
        type: (protocol === 'openai-realtime' ? 'response.output_audio_transcript.' : 'response.audio_transcript.') + (done ? 'done' : 'delta'),
        item_id: id, response_id: 'response-' + id, ...(done ? { transcript: text } : { delta: text }),
      });
      const transcribe = (id: string, text: string) => f.send({
        type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text,
      });
      reply('greeting', 'Hello');
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'q1' });
      f.send({ type: 'input_audio_buffer.committed', item_id: 'q1' });
      f.send({ type: 'response.output_item.added', item: { id: 'a1', type: 'message' }, response_id: 'response-a1' });
      // A second utterance can be committed before either transcript is ready.
      f.send({ type: 'input_audio_buffer.committed', item_id: 'q2' });
      transcribe('q2', 'Second question');
      reply('a2', 'Second answer');
      reply('a1', 'First', false);
      reply('a1', 'First answer');
      transcribe('q1', 'First question');
      f.send({ type: 'input_audio_buffer.committed', item_id: 'silence' });
      transcribe('silence', '');
      await f.flush();
      expect(f.record.turns.map(turn => turn.id)).toEqual(['greeting', 'q1', 'a1', 'q2', 'a2']);
      expect(f.record.turns[2]).toMatchObject({ text: 'First answer', complete: true });
    });

    it('releases a pending audio reader on provider failure without forwarding private diagnostics', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'response.created', response: { id: 'stream' } });
      f.send({ type: 'response.audio.delta', response_id: 'stream', item_id: 'answer', delta: Buffer.alloc(48).toString('base64') });
      await f.flush();
      await f.session.read('answer');
      const pending = f.session.read('answer');
      f.send({ type: 'error', error: { code: 'server_error', message: 'private diagnostics' } });
      expect(await pending).toEqual({ pcm: new ArrayBuffer(0), done: true });
      expect(f.events.at(-1)).toEqual({ type: 'error', text: '' });
    });

    it('fails an active call when its required original transcript cannot be produced', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'input' });
      f.send({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'input' });
      await f.flush();
      expect(f.events.at(-1)).toEqual({ type: 'error', text: '' });
      expect(f.handoff).not.toHaveBeenCalled();
    });

    it('waits for the matching late transcript and deduplicates function calls', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
      f.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'user-1' });
      f.send({ type: 'input_audio_buffer.committed', item_id: 'user-1' });
      f.send({ type: 'response.created', response: { id: 'response' } });
      const tool = {
        type: 'response.function_call_arguments.done',
        response_id: 'response',
        item_id: 'tool-item',
        ...(protocol === 'glm-realtime' ? { output_index: 0 } : { call_id: 'tool' }),
        name: 'handoff_task',
        arguments: JSON.stringify({ supplement: 'model context', original: 'forged' }),
      };
      f.send(tool);
      f.send(tool);
      f.send({ type: 'response.done', response: { id: 'response', status: 'completed' } });
      await f.flush();
      expect(f.handoff).not.toHaveBeenCalled();
      f.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'user-1',
        transcript: '实际用户原话',
      });
      await f.flush();
      expect(f.turns).toContainEqual(['user-1', 'user', '实际用户原话']);
      expect(f.handoff).toHaveBeenCalledExactlyOnceWith('user-1', 'model context');
      expect(f.received.filter((e) => e.item?.type === 'function_call_output')).toHaveLength(1);
      if (protocol === 'glm-realtime')
        expect(f.received.find(e => e.item?.type === 'function_call_output').item).not.toHaveProperty('call_id');
      f.session.deliverResult('task-1', 'actual result');
      f.session.deliverResult('task-1', 'actual result');
      await f.flush();
      expect(
        f.received.filter((e) => e.item?.content?.[0]?.text?.includes('actual result')),
      ).toHaveLength(1);
    });

    it('stops local reads and reconciles unheard audio on interrupt', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'response.created', response: { id: 'response' } });
      f.send({
        type:
          protocol === 'openai-realtime' ? 'response.output_audio.delta' : 'response.audio.delta',
        response_id: 'response',
        item_id: 'answer',
        content_index: 0,
        delta: Buffer.alloc(48_000).toString('base64'),
      });
      await f.flush();
      f.session.interrupt({ itemId: 'answer', playedMs: 250 });
      f.send({ type: 'response.done', response: { id: 'response', status: 'cancelled' } });
      await f.flush();
      expect((await f.session.read('answer')).pcm.byteLength).toBe(0);
      expect(f.received).toContainEqual(
        expect.objectContaining(
          protocol === 'openai-realtime'
            ? { type: 'conversation.item.truncate', item_id: 'answer', audio_end_ms: 250 }
            : { type: 'conversation.item.delete', item_id: 'answer' },
        ),
      );
    });

    it('keeps question answers out of task handoff and drops all output after ownership changes', async () => {
      const f = await fixture(protocol);
      f.session.setQuestion(true);
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'question-answer' });
      f.send({ type: 'input_audio_buffer.committed', item_id: 'question-answer' });
      f.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'question-answer',
        transcript: '选第一个',
      });
      await f.flush();
      expect(f.events).toContainEqual({
        type: 'realtime-utterance',
        itemId: 'question-answer',
        text: '选第一个',
        question: true,
      });
      expect(f.turns).toHaveLength(0);
      f.changeOwner();
      f.send({ type: 'response.created', response: { id: 'late' } });
      await f.flush();
      expect(f.events.at(-1)).toEqual({ type: 'error', text: '' });
      expect(f.handoff).not.toHaveBeenCalled();
    });

    it('does not cancel the next response when the renderer acknowledges an earlier interruption late', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'response.created', response: { id: 'old' } });
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'next-input' });
      f.send({ type: 'response.done', response: { id: 'old', status: 'cancelled' } });
      f.send({ type: 'response.created', response: { id: 'next' } });
      f.send({
        type: 'response.audio.delta',
        response_id: 'next',
        item_id: 'next-answer',
        delta: Buffer.alloc(480).toString('base64'),
      });
      f.send({ type: 'response.done', response: { id: 'next', status: 'completed' } });
      await f.flush();
      const interrupt = f.events.find((e) => e.type === 'realtime-interrupt');
      f.session.interrupt(undefined, interrupt.throughResponse);
      expect((await f.session.read('next-answer')).pcm.byteLength).toBe(480);
      await f.flush();
      expect(f.received.filter((e) => e.type === 'response.cancel')).toHaveLength(0);
    });

    it('keeps the first resumed utterance even when VAD includes audio from before its onset', async () => {
      const f = await fixture(protocol);
      f.session.audio(new ArrayBuffer(32_000));
      f.session.setMuted(true);
      f.session.setMuted(false);
      await f.flush();

      // A provider reports the start of its buffered prefix, not the first voiced sample.
      const bytesPerMs = protocol === 'openai-realtime' ? 48 : 32;
      const resumedAt = f.received.filter(e => e.type === 'input_audio_buffer.append')
        .reduce((ms, e) => ms + Buffer.from(e.audio, 'base64').length / bytesPerMs, 0);
      f.session.audio(new ArrayBuffer(640));
      for (const [id, start] of [['late', 100], ['fresh', resumedAt - 300]] as const) {
        f.send({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: start });
        f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: id });
      }
      await f.flush();
      expect(f.turns).toEqual([['fresh', 'user', 'fresh']]);
    });

    it('suppresses a muted unfinished utterance and its automatic response after unmute', async () => {
      const f = await fixture(protocol);
      f.send({ type: 'input_audio_buffer.speech_started', item_id: 'muted-input' });
      await f.flush();
      f.session.setMuted(true);
      f.session.setMuted(false);
      f.send({ type: 'input_audio_buffer.committed', item_id: 'muted-input' });
      f.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'muted-input',
        transcript: '旧音频',
      });
      await f.flush();
      expect(f.turns).toHaveLength(0);
      expect(f.events.some((e) => e.type === 'realtime-utterance')).toBe(false);
      f.send({ type: 'response.created', response: { id: 'stream' } });
      f.send({
        type: 'response.audio.delta',
        response_id: 'stream',
        item_id: 'stream-answer',
        delta: Buffer.alloc(48).toString('base64'),
      });
      await f.flush();
      // The suppressed automatic response is discarded, and no audio escapes.
      expect((await f.session.read('stream-answer')).done).toBe(true);
    });
  },
);

it('resamples continuously across odd capture frame boundaries', () => {
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < 320; ++i) pcm.writeInt16LE(i, i * 2);
  const full = new RealtimePcmResampler().convert(Uint8Array.from(pcm).buffer);
  const split = new RealtimePcmResampler();
  const parts = [pcm.subarray(0, 214), pcm.subarray(214)].map((p) =>
    split.convert(Uint8Array.from(p).buffer),
  );
  expect(Buffer.concat(parts)).toEqual(full);
});

it.each(['cancelled', 'ambiguous', 'superseded'])('does not dispatch a %s untagged GLM tool', async scenario => {
  const f = await fixture('glm-realtime');
  f.send({ type: 'input_audio_buffer.committed', item_id: 'one' });
  await vi.waitFor(() => expect(f.received.some(e => e.type === 'response.create')).toBe(true));
  f.send({ type: 'response.created', response: { id: 'reply' } });
  const tool = { type: 'response.function_call_arguments.done', response_id: 'reply',
    name: 'handoff_task', arguments: '{"supplement":"one"}', output_index: 0 };
  f.send(tool);
  if (scenario === 'ambiguous') f.send({ ...tool, output_index: 1 });
  if (scenario === 'superseded') f.send({ type: 'input_audio_buffer.committed', item_id: 'two' });
  f.send({ type: 'response.done', response: { id: 'reply', status: scenario === 'cancelled' ? 'cancelled' : 'completed' } });
  f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'original' });
  await f.flush();
  expect(f.handoff).not.toHaveBeenCalled();
});

it('does not bind a GLM task to the last of two unanswered inputs', async () => {
  const f = await fixture('glm-realtime');
  const commit = (id: string) => {
    f.send({ type: 'input_audio_buffer.committed', item_id: id });
    f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: id });
  };
  commit('first');
  f.send({ type: 'response.created', response: { id: 'busy' } });
  commit('second');
  commit('third');
  f.send({ type: 'response.done', response: { id: 'busy', status: 'completed' } });
  await vi.waitFor(() => expect(f.received.filter(e => e.type === 'response.create')).toHaveLength(2));
  f.send({ type: 'response.created', response: { id: 'combined' } });
  f.send({ type: 'response.function_call_arguments.done', response_id: 'combined', output_index: 0,
    name: 'handoff_task', arguments: '{"supplement":"context"}' });
  f.send({ type: 'response.done', response: { id: 'combined', status: 'completed' } });
  await vi.waitFor(() => expect(f.received.find(e => e.item?.type === 'function_call_output')?.item.output)
    .toBe(JSON.stringify({status: 'not_accepted'})));
  expect(f.handoff).not.toHaveBeenCalled();
});

it('requests one GLM response for speech and an already delivered task result, retaining the input ID', async () => {
  const f = await fixture('glm-realtime');
  const requests = () => f.received.filter(e => e.type === 'response.create');
  f.send({ type: 'input_audio_buffer.speech_started', item_id: 'current-input' });
  await f.drainEvents();
  f.session.deliverResult('earlier-task', 'Earlier task completed');
  f.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'current-input' });
  f.send({ type: 'input_audio_buffer.committed', item_id: 'current-input' });
  await f.drainEvents();
  expect(requests()).toHaveLength(1);

  f.send({ type: 'response.created', response: { id: 'combined' } });
  f.send({ type: 'response.function_call_arguments.done', response_id: 'combined', output_index: 0,
    name: 'handoff_task', arguments: '{"supplement":"follow up"}' });
  f.send({ type: 'response.done', response: { id: 'combined', status: 'completed' } });
  await f.drainEvents();
  expect(requests()).toHaveLength(1);

  // Only the later tool result needs another generation. It must still use the
  // original utterance, even when its transcript arrives after response.done.
  f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'current-input', transcript: 'current request' });
  await vi.waitFor(() => expect(requests()).toHaveLength(2));
  expect(f.handoff).toHaveBeenCalledExactlyOnceWith('current-input', 'follow up');
});

it.each(['before mute', 'before stop', 'after stop'] as const)(
  'resumes a pending GLM task result once when muted speech ends (commit %s)', async commitOrder => {
    const f = await fixture('glm-realtime');
    const requests = () => f.received.filter(e => e.type === 'response.create');
    const input = 'muted-input';
    const commit = () => f.send({ type: 'input_audio_buffer.committed', item_id: input });
    f.send({ type: 'input_audio_buffer.speech_started', item_id: input });
    await f.drainEvents();

    f.session.deliverResult('earlier-task', 'Earlier task completed');
    if (commitOrder === 'before mute') {
      commit();
      await f.drainEvents();
    }
    f.session.setMuted(true);
    if (commitOrder === 'before stop') commit();
    await f.drainEvents();
    expect(requests()).toHaveLength(0);

    f.send({ type: 'input_audio_buffer.speech_stopped', item_id: input });
    await f.drainEvents();
    expect(requests()).toHaveLength(1);

    if (commitOrder === 'after stop') commit();
    f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: input, transcript: 'muted speech' });
    f.send({ type: 'response.created', response: { id: 'task-result' } });
    f.send({ type: 'response.audio.delta', response_id: 'task-result', item_id: 'answer', delta: Buffer.alloc(48).toString('base64') });
    f.send({ type: 'response.done', response: { id: 'task-result', status: 'completed' } });
    await f.drainEvents();
    expect(requests()).toHaveLength(1);
    expect(f.events).toContainEqual({ type: 'realtime-audio', itemId: 'answer' });
    expect(f.turns.some(([, role]) => role === 'user')).toBe(false);
    expect(f.received.some(e => e.type === 'response.cancel')).toBe(false);
  },
);

it('waits for the GLM handoff receipt before generating a pending background reply', async () => {
  const f = await fixture('glm-realtime');
  const requests = () => f.received.filter(e => e.type === 'response.create');
  let accept!: (accepted: boolean) => void;
  f.handoff.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.send({ type: 'input_audio_buffer.committed', item_id: 'new-request' });
  f.send({ type: 'response.created', response: { id: 'tool-reply' } });
  f.send({ type: 'response.function_call_arguments.done', response_id: 'tool-reply', output_index: 0,
    name: 'handoff_task', arguments: '{"supplement":"context"}' });
  f.send({ type: 'response.done', response: { id: 'tool-reply', status: 'completed' } });
  await f.drainEvents();
  f.session.deliverResult('earlier-task', 'finished');
  await f.drainEvents();
  expect(requests()).toHaveLength(1);

  f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-request', transcript: 'start this task' });
  await f.drainEvents();
  expect(f.handoff).toHaveBeenCalledExactlyOnceWith('new-request', 'context');
  expect(requests()).toHaveLength(1);
  accept(true);
  await f.drainEvents();
  const output = f.received.filter(e => e.item?.type === 'function_call_output');
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0].item.output)).toEqual({ status: 'accepted' });
  expect(requests()).toHaveLength(2);
  expect(f.received.indexOf(output[0])).toBeLessThan(f.received.indexOf(requests()[1]));
  f.send({ type: 'response.created', response: { id: 'continuation' } });
  f.send({ type: 'response.done', response: { id: 'continuation', status: 'completed' } });
  await f.drainEvents();
  expect(requests()).toHaveLength(2);
});

it('starts one merged GLM reply when the final committed speaker stops after response.done', async () => {
  const f = await fixture('glm-realtime');
  const requests = () => f.received.filter(e => e.type === 'response.create');
  f.send({ type: 'input_audio_buffer.committed', item_id: 'first' });
  f.send({ type: 'response.created', response: { id: 'busy' } });
  for (const id of ['second', 'third']) {
    f.send({ type: 'input_audio_buffer.speech_started', item_id: id });
    f.send({ type: 'input_audio_buffer.committed', item_id: id });
    f.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: id });
    if (id === 'second') f.send({ type: 'input_audio_buffer.speech_stopped', item_id: id });
  }
  f.send({ type: 'response.done', response: { id: 'busy', status: 'completed' } });
  await f.drainEvents();
  expect(requests()).toHaveLength(1);
  f.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'third' });
  await f.drainEvents();
  expect(requests()).toHaveLength(2);

  f.send({ type: 'response.created', response: { id: 'merged' } });
  f.send({ type: 'response.function_call_arguments.done', response_id: 'merged', output_index: 0,
    name: 'handoff_task', arguments: '{"supplement":"ambiguous"}' });
  f.send({ type: 'response.done', response: { id: 'merged', status: 'completed' } });
  await f.drainEvents();
  expect(f.handoff).not.toHaveBeenCalled();
  expect(f.received.find(e => e.item?.type === 'function_call_output')?.item.output)
    .toBe(JSON.stringify({ status: 'not_accepted' }));
});
