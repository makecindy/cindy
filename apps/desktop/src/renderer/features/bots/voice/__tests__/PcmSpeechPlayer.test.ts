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
  private elapsed = 0;
  private runningAt = Date.now();
  get currentTime() {
    return this.elapsed + (this.state === 'running' ? (Date.now() - this.runningAt) / 1000 : 0);
  }
  constructor() {
    TestAudioContext.latest = this;
  }
  resume = vi.fn(async () => {
    if (this.state === 'running') return;
    this.runningAt = Date.now();
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.elapsed = this.currentTime;
    this.state = 'suspended';
  });
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

it('freezes the audio clock and queued samples during a false onset, then continues without rereading', async () => {
  const player = new PcmSpeechPlayer(vi.fn());
  const read = vi.fn(async () => ({ pcm: new Int16Array(24_000).buffer, done: true }));
  const started = vi.fn();
  const playing = player.play(read, 24_000, started);
  await vi.advanceTimersByTimeAsync(100);
  const context = TestAudioContext.latest;
  const sourcesBefore = [...context.sources];
  player.pause();
  await vi.advanceTimersByTimeAsync(0);
  const position = context.currentTime;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(context.currentTime).toBe(position);
  expect(context.sources).toEqual(sourcesBefore);
  expect(sourcesBefore.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
  player.resume();
  await vi.advanceTimersByTimeAsync(1_100);
  await playing;
  expect(read).toHaveBeenCalledOnce();
  expect(started).toHaveBeenCalledOnce();
  expect(context.sources.slice(0, sourcesBefore.length)).toEqual(sourcesBefore);
  player.close();
});

it('holds a synthesis response that arrives during noise and cancels a suspended player on teardown', async () => {
  const player = new PcmSpeechPlayer(vi.fn());
  player.pause();
  const read = vi.fn(async () => ({ pcm: new Int16Array(2_400).buffer, done: true }));
  const playing = player.play(read, 24_000);
  const rejected = expect(playing).rejects.toThrow('Playback interrupted');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).not.toHaveBeenCalled();
  expect(TestAudioContext.latest.sources).toHaveLength(0);
  player.close();
  await rejected;
  player.resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(TestAudioContext.latest.state).toBe('closed');
});
