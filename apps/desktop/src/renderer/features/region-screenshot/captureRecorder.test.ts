import { afterEach, expect, it, vi } from 'vitest';
import { CaptureRecorder } from './captureRecorder';
import { finalizeWebmDuration } from './webmDuration';

// Real playback reported Infinity and could not show a timeline. Existing tests
// only decoded pixels. Minimal streaming WebM Info without Duration; tier: unit.
it('finalizes streaming WebM duration without changing its encoded frames', () => {
  const stream = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x1f, 0x43, 0xb6, 0x75, 0x83, 1, 2, 3]);
  const result = finalizeWebmDuration(stream, 1234);
  expect(result[9]).toBe(0x92); // Info grows by the eleven-byte Duration element.
  expect(new DataView(result.buffer).getFloat64(20)).toBe(1234);
  expect(result.subarray(28)).toEqual(stream.subarray(17));
  expect(finalizeWebmDuration(result, 999)).toBe(result);
  expect(() => finalizeWebmDuration(stream.subarray(0, 12), 100)).toThrow('Invalid WebM metadata');
});

// Unit regression: the UI matrix produced an empty short WebM that was reported
// as saved. Exercise the encoder's real finish boundary with an empty browser
// stop event; geometry and browser playback tests do not cover this outcome.
afterEach(() => vi.unstubAllGlobals());

it('rejects a recording when the browser stops without encoded frames', async () => {
  class EmptyRecorder {
    static isTypeSupported() { return true; }
    state = 'recording';
    onstop: (() => void) | null = null;
    start() {}
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  vi.stubGlobal('MediaRecorder', EmptyRecorder);
  const track = { stop: vi.fn(), requestFrame: vi.fn() };
  const canvas = { captureStream: () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } as unknown as HTMLCanvasElement;
  const recorder = new CaptureRecorder(canvas, 'webm', () => {});
  recorder.add(0);
  await expect(recorder.finish(1)).rejects.toThrow('No video frames were encoded');
  expect(track.stop).toHaveBeenCalled();
});

// Unit: consecutive identical GIF frames may coalesce, but their display time
// and a one-pixel change must survive pause/resume. WebM tests miss this path.
// Read standard GIF block metadata independently of the encoder's state.
function frameDelays(bytes: Uint8Array): number[] {
  let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  const delays: number[] = [];
  let delay = 0;
  const skipBlocks = () => { while (bytes[at]) { at += bytes[at] + 1; } at++; };
  while (bytes[at] !== 0x3b && at < bytes.length) {
    const block = bytes[at++];
    if (block === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9) delay = (bytes[at + 2] | (bytes[at + 3] << 8)) * 10;
      skipBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[at + 8];
      at += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      at++; // LZW code size
      skipBlocks();
      delays.push(delay);
    } else throw new Error(`Unexpected GIF block ${block}`);
  }
  expect(bytes[at]).toBe(0x3b);
  return delays;
}

it('coalesces identical GIF frames without losing elapsed time or changes after resume', async () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]);
  const canvas = { width: 2, height: 1, getContext: () => ({
    getImageData: () => ({ data: pixels.slice() }),
  }) } as unknown as HTMLCanvasElement;
  const recorder = new CaptureRecorder(canvas, 'gif', () => {});
  recorder.add(0);
  recorder.add(100);
  recorder.add(200);
  pixels.set([0, 0, 255, 255], 4);
  recorder.add(300);
  recorder.pause(400);
  recorder.resume();
  recorder.add(400);
  recorder.add(500);
  const bytes = await recorder.finish(600);
  expect(frameDelays(bytes)).toEqual([300, 100, 200]);
  recorder.dispose();
});
