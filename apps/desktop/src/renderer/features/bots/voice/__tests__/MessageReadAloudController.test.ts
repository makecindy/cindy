import { expect, it, vi } from 'vitest';
import type { VoiceConversationApi, VoiceConversationEvent } from '@/../shared/voiceConversation';
import type { SpeechPlayer } from '../PcmSpeechPlayer';
import { speechText } from '../VoiceReplyTracker';
import { MessageReadAloudController } from '../MessageReadAloudController';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => log }));
const selection = {
  providerId: 'mine',
  agent: 'codex' as const,
  modelId: 'tts',
  voice: 'my-voice',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const listeners = new Set<(event: VoiceConversationEvent) => void>();
  const api = {
    startPlayback: vi.fn<VoiceConversationApi['startPlayback']>(async ({ callId }) => ({ callId })),
    speak: vi.fn<VoiceConversationApi['speak']>(async () => ({ sampleRate: 24000 })),
    readSpeech: vi.fn<VoiceConversationApi['readSpeech']>(async () => ({
      pcm: new ArrayBuffer(2),
      done: true,
    })),
    end: vi.fn<VoiceConversationApi['end']>(async () => {}),
    onEvent: vi.fn<VoiceConversationApi['onEvent']>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const makePlayer = () => ({
    play: vi.fn<SpeechPlayer['play']>(async (read, _rate, onStarted) => {
      await read();
      onStarted?.();
    }),
    close: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  const players: ReturnType<typeof makePlayer>[] = [];
  const createPlayer = vi.fn(() => {
    const player = makePlayer();
    players.push(player);
    return player;
  });
  const controller = new MessageReadAloudController({
    api,
    botId: 'bot',
    sessionId: 'canonical',
    player: createPlayer,
  });
  return {
    api,
    controller,
    players,
    createPlayer,
    emit: (event: VoiceConversationEvent) => listeners.forEach((listener) => listener(event)),
  };
}

it('reads all completed reply text in bounded order with the saved route and cleans up', async () => {
  const f = fixture();
  log.info.mockClear();
  const markdown =
    '**Hello.** [Reference](https://example.test)\n```js\nprivateCode();\n```\n' +
    'A whole sentence. '.repeat(400);
  await f.controller.start('reply', markdown, async () => selection);
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('idle'));
  expect(f.api.startPlayback).toHaveBeenCalledWith({
    ...selection,
    callId: expect.any(String),
    botId: 'bot',
    sessionId: 'canonical',
  });
  const parts = f.api.speak.mock.calls.map(([input]) => input.text);
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.every((text) => text.length <= 500)).toBe(true);
  expect(parts.join(' ')).toBe(speechText(markdown));
  expect(f.api.speak.mock.calls.every(([input]) => input.streaming === undefined)).toBe(true);
  expect(f.players[0].close).toHaveBeenCalledOnce();
  expect(f.api.end).toHaveBeenCalled();
  expect(JSON.stringify(log.info.mock.calls)).not.toContain('privateCode');
  expect(JSON.stringify(log.info.mock.calls)).not.toContain('A whole sentence');
});

it('does not invent a route or synthesize unreadable content', async () => {
  const f = fixture();
  await f.controller.start('code', '```js\nx();\n```', async () => selection);
  expect(f.createPlayer).not.toHaveBeenCalled();
  await f.controller.start('reply', 'text', async () => undefined);
  expect(f.controller.getSnapshot().phase).toBe('error');
  expect(f.api.startPlayback).not.toHaveBeenCalled();
  expect(f.api.speak).not.toHaveBeenCalled();
  expect(f.players[0].close).toHaveBeenCalledOnce();
});

it('drops selection loaded after Stop without opening a lease or sending text', async () => {
  const f = fixture();
  const configuration = deferred<typeof selection>();
  const pending = f.controller.start('reply', 'text', () => configuration.promise);
  expect(f.createPlayer).toHaveBeenCalledOnce();
  await f.controller.stop();
  configuration.resolve(selection);
  await pending;
  expect(f.api.startPlayback).not.toHaveBeenCalled();
  expect(f.api.speak).not.toHaveBeenCalled();
});

it('keeps replacement playback alive when a cancelled Main start settles late', async () => {
  const f = fixture();
  const open = deferred<{ callId: string }>();
  f.api.startPlayback.mockReturnValueOnce(open.promise);
  const old = f.controller.start('old', 'old text', async () => selection);
  await vi.waitFor(() => expect(f.api.startPlayback).toHaveBeenCalledOnce());
  const oldId = f.api.startPlayback.mock.calls[0][0].callId;
  const drain = deferred<void>();
  const current = f.controller.start('new', 'new text', async () => selection);
  f.players[1].play.mockImplementationOnce(async (_read, _rate, onStarted) => {
    onStarted?.();
    await drain.promise;
  });
  await current;
  await vi.waitFor(() =>
    expect(f.controller.getSnapshot()).toEqual({ messageId: 'new', phase: 'playing' }),
  );
  open.resolve({ callId: oldId });
  await old;
  expect(f.controller.getSnapshot().messageId).toBe('new');
  expect(f.api.speak).toHaveBeenCalledOnce();
  expect(f.api.speak.mock.calls[0][0].text).toBe('new text');
  expect(f.api.end.mock.calls.every(([id]) => id === oldId)).toBe(true);
  drain.resolve();
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('idle'));
});

it('stops output immediately and waits for the previous lease before replacing a reply', async () => {
  const f = fixture();
  const audio = deferred<void>();
  const started = f.controller.start('first', 'first', async () => selection);
  f.players[0].play.mockReturnValueOnce(audio.promise);
  await started;
  await vi.waitFor(() => expect(f.players[0].play).toHaveBeenCalledOnce());
  const ended = deferred<void>();
  f.api.end.mockReturnValueOnce(ended.promise);
  const replacement = f.controller.start('second', 'second', async () => selection);
  expect(f.players[0].close).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(f.api.startPlayback).toHaveBeenCalledOnce();
  ended.resolve();
  await replacement;
  expect(f.api.startPlayback).toHaveBeenCalledTimes(2);
  audio.resolve();
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('idle'));
});

it('only marks playing after the player schedules audio and allows cancellation while preparing', async () => {
  const f = fixture();
  const request = deferred<{ sampleRate: number }>();
  f.api.speak.mockReturnValueOnce(request.promise);
  await f.controller.start('reply', 'text', async () => selection);
  expect(f.controller.getSnapshot()).toEqual({ messageId: 'reply', phase: 'preparing' });
  await f.controller.stop();
  request.resolve({ sampleRate: 24000 });
  await Promise.resolve();
  expect(f.players[0].play).not.toHaveBeenCalled();
  expect(f.api.readSpeech).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().phase).toBe('idle');
});

it('ends failed synthesis without retries, raw errors or a provider fallback', async () => {
  const f = fixture();
  log.warn.mockClear();
  f.api.speak.mockRejectedValueOnce(new Error('secret provider payload'));
  await f.controller.start('reply', 'private reply', async () => selection);
  await vi.waitFor(() => expect(f.controller.getSnapshot().phase).toBe('error'));
  expect(f.api.speak).toHaveBeenCalledOnce();
  expect(f.api.end).toHaveBeenCalled();
  expect(f.players[0].close).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret|private reply/);
});

it('releases local playback when Main ends the owned call', async () => {
  const f = fixture();
  const audio = deferred<void>();
  const start = f.controller.start('reply', 'text', async () => selection);
  f.players[0].play.mockReturnValueOnce(audio.promise);
  await start;
  const callId = f.api.startPlayback.mock.calls[0][0].callId;
  f.emit({ callId: 'other', event: { type: 'ended' } });
  expect(f.controller.getSnapshot().messageId).toBe('reply');
  f.emit({ callId, event: { type: 'ended' } });
  expect(f.controller.getSnapshot().phase).toBe('idle');
  expect(f.players[0].close).toHaveBeenCalledOnce();
  audio.resolve();
});
