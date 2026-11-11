import { afterEach, expect, it, vi } from 'vitest';
import { nativeAudioStream } from '../nativeAudioStream';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  const track = { stop: vi.fn() };
  const close = vi.fn(async () => {});
  const suspend = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const channels: Float32Array[] = [];
  const nodes: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0;
      close = close;
      resume = resume;
      suspend = suspend;
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
      }
      createBuffer(_channels: number, frames: number) {
        const data = [new Float32Array(frames), new Float32Array(frames)];
        channels.push(...data);
        return { getChannelData: (channel: number) => data[channel] };
      }
      createBufferSource() {
        const node = { connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn() };
        nodes.push(node);
        return node;
      }
    },
  );
  return { track, close, suspend, resume, channels, nodes };
}
it('deinterleaves bounded stereo PCM and erases sources and polling on stop', async () => {
  const h = setup();
  const pcm = new Uint8Array(new Float32Array([0.5, -0.25, NaN, 2]).buffer);
  const read = vi.fn(async () => pcm);
  const owner = await nativeAudioStream(read, () => true);
  expect([...h.channels[0]]).toEqual([0.5, 0]);
  expect([...h.channels[1]]).toEqual([-0.25, 1]);
  owner.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledOnce();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.nodes[0].stop).toHaveBeenCalledOnce();
  expect(h.close).toHaveBeenCalledOnce();
});

// Unit regression: pausing MediaRecorder alone left PCM polling and AudioContext
// running. Existing stop tests did not cover retaining the muxer's live track.
it('suspends all PCM work while paused and resumes with the same live track', async () => {
  const h = setup();
  const read = vi.fn(async () => new Uint8Array(80));
  const owner = await nativeAudioStream(read, () => true);
  await owner.pause();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledOnce();
  expect(h.nodes).toHaveLength(1);
  expect(h.nodes[0].stop).toHaveBeenCalledOnce();
  expect(h.suspend).toHaveBeenCalledOnce();
  expect(h.track.stop).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
  await owner.resume();
  expect(owner.track).toBe(h.track);
  expect(h.resume).toHaveBeenCalledTimes(2);
  expect(h.nodes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(20);
  expect(read).toHaveBeenCalledTimes(3);
  owner.stop();
});

it.each(['resolve', 'reject'] as const)('discards a stale read that %s after pause and resume', async (outcome) => {
  const h = setup();
  let resolve!: (bytes: Uint8Array<ArrayBuffer>) => void;
  let reject!: (reason: Error) => void;
  const read = vi.fn(async () => new Uint8Array(80));
  const onError = vi.fn();
  const owner = await nativeAudioStream(read, () => true, onError);
  read.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  await vi.advanceTimersByTimeAsync(20);
  await owner.pause();
  await owner.resume();
  if (outcome === 'resolve') resolve(new Uint8Array(800));
  else reject(new Error('old host closed'));
  await vi.advanceTimersByTimeAsync(20);
  expect(onError).not.toHaveBeenCalled();
  expect(h.track.stop).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(4);
  expect(h.nodes).toHaveLength(3);
  expect(h.channels.every((channel) => channel.length === 10)).toBe(true);
  owner.stop();
});

it('does not restart polling when stopped during context resume', async () => {
  const h = setup();
  const read = vi.fn(async () => new Uint8Array(80));
  const owner = await nativeAudioStream(read, () => true);
  await owner.pause();
  let release!: () => void;
  h.resume.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const resuming = owner.resume();
  const rejected = expect(resuming).rejects.toThrow('DESKTOP_AUDIO_UNAVAILABLE');
  owner.stop();
  release();
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledOnce();
  expect(h.close).toHaveBeenCalledOnce();
});

it('reports a current read failure once and releases the track', async () => {
  const h = setup();
  const read = vi.fn(async () => new Uint8Array(80));
  const onError = vi.fn();
  await nativeAudioStream(read, () => true, onError);
  read.mockRejectedValueOnce(new Error('device disconnected'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(onError).toHaveBeenCalledOnce();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
});
it('discards a read that completes after authorization ends', async () => {
  const h = setup();
  let valid = true;
  let finish!: (value: Uint8Array) => void;
  const pending = nativeAudioStream(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => valid,
  );
  const rejected = expect(pending).rejects.toThrow('DESKTOP_AUDIO_UNAVAILABLE');
  await Promise.resolve();
  valid = false;
  finish(new Uint8Array(80));
  await rejected;
  expect(h.nodes).toHaveLength(0);
  expect(h.close).toHaveBeenCalledOnce();
});
