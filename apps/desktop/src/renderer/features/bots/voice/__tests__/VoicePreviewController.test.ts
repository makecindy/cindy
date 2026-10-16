import { expect, it, vi } from 'vitest';
import { VoicePreviewController } from '../VoicePreviewController';

function fixture() {
  const api = {
    preview: vi.fn(async () => ({ sampleRate: 24000 })),
    readPreview: vi.fn(async () => ({ pcm: new ArrayBuffer(2), done: true })),
    stopPreview: vi.fn<(id: string) => Promise<void>>(async () => {}),
  };
  const player = {
    play: vi.fn(async (read: () => Promise<unknown>) => {
      await read();
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

it('previews through the selected model and closes playback after draining', async () => {
  const { controller, api, player } = fixture();
  await controller.start(choice, 'sample');
  expect(api.preview).toHaveBeenCalledWith({
    ...choice,
    botId: 'bot',
    sessionId: 'task',
    previewId: expect.any(String),
    text: 'sample',
  });
  expect(api.readPreview).toHaveBeenCalledOnce();
  expect(player.play).toHaveBeenCalledWith(expect.any(Function), 24000);
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
  fail(new Error('cancelled'));
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
