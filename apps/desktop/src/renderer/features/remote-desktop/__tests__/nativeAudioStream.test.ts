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
  const channels: Float32Array[] = [];
  const nodes: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0;
      close = close;
      async resume() {}
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
  return { track, close, channels, nodes };
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
