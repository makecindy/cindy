import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { MAX_RECORDING_BYTES } from '../../../shared/regionCapture';

/** The original GIF algorithm, isolated from Canvas and scheduling. One instance
 * owns one recording; no approximate palettes, frame dropping or quality changes. */
export class GifEncoding {
  private readonly gif = GIFEncoder();
  private histogram = new Uint32Array(4096 * 4);
  private nextHistogram = new Uint32Array(4096 * 4);
  private palette: number[][] | null = null;
  private previous: { pixels: Uint8ClampedArray; index: Uint8Array; palette: number[][]; at: number } | null = null;

  constructor(private readonly width: number, private readonly height: number) {}

  add(pixels: Uint8ClampedArray, at: number): boolean {
    if (this.previous && samePixels(this.previous.pixels, pixels)) return false;
    this.pause(at);
    // gifenc's rgb444 quantizer depends only on each bin's count and RGB sums.
    // Compare all integers, not a hash or approximate palette. Spatially moved
    // colors can reuse quantization while still mapping and encoding every frame.
    const bins = this.nextHistogram;
    bins.fill(0);
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const at = (((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)) * 4;
      bins[at]++; bins[at + 1] += r; bins[at + 2] += g; bins[at + 3] += b;
    }
    if (!this.palette || !bins.every((value, i) => value === this.histogram[i])) {
      this.palette = quantize(pixels, 256, { format: 'rgb444' });
    }
    [this.histogram, this.nextHistogram] = [bins, this.histogram];
    const palette = this.palette;
    this.previous = { pixels, palette, index: applyPalette(pixels, palette, 'rgb444'), at };
    return this.gif.bytesView().length > MAX_RECORDING_BYTES - 4 * 1024 * 1024;
  }

  pause(at: number): void {
    if (!this.previous) return;
    this.gif.writeFrame(this.previous.index, this.width, this.height, {
      palette: this.previous.palette, delay: Math.max(20, at - this.previous.at), repeat: 0,
    });
    this.previous = null;
  }

  finish(at: number): Uint8Array<ArrayBuffer> {
    this.pause(at);
    this.gif.finish();
    const bytes = this.gif.bytes();
    if (bytes.length > MAX_RECORDING_BYTES) throw new Error('Recording size limit');
    return bytes;
  }
}

function samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

export type GifRequest =
  | { kind: 'init'; width: number; height: number }
  | { kind: 'add'; id: number; pixels: Uint8ClampedArray<ArrayBuffer>; at: number }
  | { kind: 'pause'; at: number }
  | { kind: 'finish'; id: number; at: number };
export type GifResponse =
  | { kind: 'added'; id: number; limit: boolean }
  | { kind: 'finished'; id: number; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'error'; message: string };
