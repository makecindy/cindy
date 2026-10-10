import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PcmSpeechPlayer } from '../PcmSpeechPlayer';

function createTestSource() {
  return {
    buffer: null,
    onended: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

class TestAudioContext {
  static latest: TestAudioContext;
  state = 'running';
  destination = {};
  sources: ReturnType<typeof createTestSource>[] = [];
  get currentTime() {
    return Date.now() / 1000;
  }
  constructor() {
    TestAudioContext.latest = this;
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
  createBufferSource() {
    const source = createTestSource();
    this.sources.push(source);
    return source;
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', TestAudioContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('bounds scheduled playback and immediately stops every source when the user interrupts', async () => {
  const level = vi.fn();
  const player = new PcmSpeechPlayer(level);
  const pcm = new Int16Array(24_000).fill(1000).buffer;
  const playing = player.play(
    vi.fn(async () => ({ pcm, done: true })),
    24000,
  );
  const rejected = expect(playing).rejects.toThrow('Playback interrupted');
  await vi.advanceTimersByTimeAsync(0);
  const context = TestAudioContext.latest;
  expect(context.sources.length).toBeGreaterThan(0);
  expect(context.sources.length).toBeLessThanOrEqual(4);
  player.cancel();
  expect(context.sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
  const count = context.sources.length;
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(context.sources).toHaveLength(count);
  expect(level).toHaveBeenLastCalledWith(0);
  player.close();
  expect(context.close).toHaveBeenCalledOnce();
});

it('fences an IPC read that finishes after cancellation', async () => {
  const player = new PcmSpeechPlayer(vi.fn());
  let resolve!: (value: { pcm: ArrayBuffer; done: boolean }) => void;
  const playing = player.play(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    24000,
  );
  const rejected = expect(playing).rejects.toThrow('Playback interrupted');
  await vi.advanceTimersByTimeAsync(0);
  player.cancel();
  resolve({ pcm: new Int16Array(2400).buffer, done: true });
  await rejected;
  expect(TestAudioContext.latest.sources).toHaveLength(0);
  player.close();
});
