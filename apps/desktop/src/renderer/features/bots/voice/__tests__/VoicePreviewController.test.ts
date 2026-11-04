import { expect, it, vi } from 'vitest';
import { VoicePreviewController } from '../VoicePreviewController';
import type { VoiceConversationApi } from '@/../shared/voiceConversation';
import type { SpeechPlayer } from '../PcmSpeechPlayer';

function fixture() {
  const api = {
    preview: vi.fn<VoiceConversationApi['preview']>(async () => ({ sampleRate: 24000 })),
    readPreview: vi.fn(async () => ({ pcm: new ArrayBuffer(2), done: true })),
    stopPreview: vi.fn<(id: string) => Promise<void>>(async () => {}),
  };
  const player = {
    play: vi.fn<SpeechPlayer['play']>(async (read, audio) => {
      if (typeof audio === 'number') await read();
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  };
  const controller = new VoicePreviewController({
    api,
    botId: 'bot',
    sessionId: 'task',
    player: () => player,
  });
  return { api, player, controller };
}
const choice = {
  providerId: 'mine',
  agent: 'codex' as const,
  modelId: 'speech',
  voice: 'voice-id',
};

// Unit: preview must preserve the host-selected encoded format as well as PCM;
// otherwise a successful MiniMax request still fails at the preview player.
it.each(['pcm', 'mp3'] as const)('previews %s through the selected model and closes playback after draining', async format => {
  const { controller, api, player } = fixture();
  const encoded = { format: 'mp3' as const, data: new Uint8Array([1]).buffer };
  if (format === 'mp3') api.preview.mockResolvedValue(encoded);
  await controller.start(choice, 'sample');
  expect(api.preview).toHaveBeenCalledWith({
    ...choice,
    botId: 'bot',
    sessionId: 'task',
    previewId: expect.any(String),
    text: 'sample',
  });
  expect(api.readPreview).toHaveBeenCalledTimes(format === 'mp3' ? 0 : 1);
  expect(player.play).toHaveBeenCalledWith(expect.any(Function), format === 'mp3' ? encoded : 24000);
  expect(player.close).toHaveBeenCalled();
  expect(api.stopPreview).toHaveBeenCalled();
  expect(controller.getSnapshot()).toBe('complete');
});

it('drops a late start after stopping while synthesis is pending', async () => {
  const { controller, api, player } = fixture();
  let release!: (value: { sampleRate: number }) => void;
  api.preview.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = controller.start(choice, 'sample');
  await vi.waitFor(() => expect(api.preview).toHaveBeenCalledOnce());
  await controller.stop();
  release({ sampleRate: 24000 });
  await pending;
  expect(player.play).not.toHaveBeenCalled();
  expect(api.readPreview).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toBe('idle');
});

it('keeps the current preview alive when an earlier request settles late', async () => {
  const { controller, api, player } = fixture();
  let fail!: (reason: Error) => void;
  api.preview.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const old = controller.start(choice, 'old');
  await vi.waitFor(() => expect(api.preview).toHaveBeenCalledOnce());
  let drain!: () => void;
  player.play.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      drain = resolve;
    }),
  );
  const current = controller.start({ ...choice, voice: 'second' }, 'new');
  await vi.waitFor(() => expect(controller.getSnapshot()).toBe('playing'));
  fail(new Error('[VOICE_SPEECH_TIMEOUT] Speech timed out'));
  await old;
  expect(controller.getSnapshot()).toBe('playing');
  drain();
  await current;
  expect(controller.getSnapshot()).toBe('complete');
});

it('shows errors without retrying or changing the selected model', async () => {
  const { controller, api } = fixture();
  api.preview.mockRejectedValueOnce(new Error('unavailable'));
  await controller.start(choice, 'sample');
  expect(controller.getSnapshot()).toBe('error');
  expect(api.preview).toHaveBeenCalledOnce();
  expect(api.stopPreview).toHaveBeenCalledOnce();
});
