import { afterEach, expect, it, vi } from 'vitest';
import { CaptureRecorder } from './captureRecorder';
import { finalizeWebmDuration } from './webmDuration';
import { GifEncoding, type GifRequest } from './gifEncoding';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  await recorder.add(0);
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
  const recorder = new CaptureRecorder(canvas, 'gif', () => {}, () => new TestGifWorker() as unknown as Worker);
  await recorder.add(0);
  await recorder.add(100);
  await recorder.add(200);
  pixels.set([0, 0, 255, 255], 4);
  await recorder.add(300);
  recorder.pause(400);
  recorder.resume();
  await recorder.add(400);
  await recorder.add(500);
  const bytes = await recorder.finish(600);
  expect(frameDelays(bytes)).toEqual([300, 100, 200]);
  recorder.dispose();
});

// The unit transport delivers the actual encoder's results; the Electron benchmark
// exercises the real Worker separately. Structured clone models buffer ownership.
class TestGifWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  terminated = false;
  messages: GifRequest[] = [];
  private encoder: GifEncoding | null = null;
  constructor(private readonly automatic = true) {}
  postMessage(message: GifRequest, transfer: Transferable[] = []) {
    this.messages.push(structuredClone(message, { transfer }));
    if (this.automatic) queueMicrotask(() => this.deliver());
  }
  deliver() {
    if (this.terminated) return;
    for (const data of this.messages.splice(0)) {
      if (data.kind === 'init') this.encoder = new GifEncoding(data.width, data.height);
      else if (data.kind === 'pause') this.encoder!.pause(data.at);
      else {
        const response = data.kind === 'add'
          ? { kind: 'added', id: data.id, limit: this.encoder!.add(data.pixels, data.at) }
          : { kind: 'finished', id: data.id, bytes: this.encoder!.finish(data.at) };
        this.onmessage?.call(this as unknown as Worker, { data: response } as MessageEvent);
      }
    }
  }
  terminate() { this.terminated = true; }
}

const gifCanvas = () => ({ width: 2, height: 1, getContext: () => ({
  getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }),
}) }) as unknown as HTMLCanvasElement;

// Unit: equal rgb444 bin counts alone do not imply equal palettes. Compare the
// real worker-facing encoder with independent, unconditionally quantized frames.
// Spatial permutations may reuse quantization; RGB-sum changes must invalidate it.
it('preserves every GIF byte for moved colors, same-bin color changes and resume', () => {
  const encoder = new GifEncoding(32, 16), reference = GIFEncoder();
  const original = new Uint8ClampedArray(32 * 16 * 4);
  for (let i = 0; i < original.length; i += 4) {
    original[i] = (i * 13) % 256; original[i + 1] = (i >>> 2) % 256;
    original[i + 2] = (i >>> 4) % 256; original[i + 3] = 255;
  }
  const moved = new Uint8ClampedArray(original.length);
  moved.set(original.subarray(4)); moved.set(original.subarray(0, 4), moved.length - 4);
  const changed = moved.slice(); changed[0] += 1;
  const alpha = changed.slice(); alpha[3] = 120;
  const frames = [original, moved, changed, alpha, original];
  frames.forEach((pixels, i) => {
    encoder.add(pixels, i * 100);
    if (i === 2) encoder.pause((i + 1) * 100);
    const palette = quantize(pixels, 256, { format: 'rgb444' });
    reference.writeFrame(applyPalette(pixels, palette, 'rgb444'), 32, 16, { palette, delay: 100, repeat: 0 });
  });
  reference.finish();
  expect(encoder.finish(500)).toEqual(reference.bytes());
});

// Worker migration creates new timing boundaries. Existing synchronous GIF tests
// cannot cover pause/finish during encoding, cancellation or worker failure. Unit:
// one accepted 2x1 frame must settle before finish, without buffering a second frame.
it('orders pause and finish behind an in-flight GIF frame and bounds the queue', async () => {
  const worker = new TestGifWorker(false);
  const recorder = new CaptureRecorder(gifCanvas(), 'gif', () => {}, () => worker as unknown as Worker);
  const adding = recorder.add(0);
  await expect(recorder.add(100)).rejects.toThrow('still in flight');
  recorder.pause(200);
  const finishing = recorder.finish(300);
  worker.deliver();
  await adding;
  worker.deliver();
  expect(frameDelays(await finishing)).toEqual([200]);
  expect(worker.terminated).toBe(true);
  await expect(recorder.finish(400)).rejects.toThrow('already stopped');
});

it.each(['cancel', 'error', 'messageerror', 'timeout'] as const)('settles a pending GIF frame on %s and releases its worker', async (cause) => {
  vi.useFakeTimers();
  const worker = new TestGifWorker(false);
  const recorder = new CaptureRecorder(gifCanvas(), 'gif', () => {}, () => worker as unknown as Worker);
  const rejected = expect(recorder.add(0)).rejects.toThrow(/disposed|failed|timed out/);
  if (cause === 'cancel') recorder.dispose();
  else if (cause === 'error') worker.onerror?.call(worker as unknown as Worker, {} as ErrorEvent);
  else if (cause === 'messageerror') worker.onmessageerror?.call(worker as unknown as Worker, {} as MessageEvent);
  else await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(worker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  recorder.dispose();
});
