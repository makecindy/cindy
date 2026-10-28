import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { MAX_RECORDING_BYTES } from '../../../shared/regionCapture';
import { finalizeWebmDuration } from './webmDuration';

/** Bounded, local-only encoding. Source pixels are supplied by the host's selected region. */
export class CaptureRecorder {
  private readonly gif;
  private readonly recorder: MediaRecorder | null;
  private readonly stream: MediaStream | null;
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private previous: { pixels: Uint8ClampedArray; index: Uint8Array; palette: number[][]; at: number } | null = null;
  private stopped = false;
  private failure: Error | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, readonly format: 'webm' | 'gif', private readonly onLimit: () => void) {
    this.gif = format === 'gif' ? GIFEncoder() : null;
    this.stream = format === 'webm' ? canvas.captureStream(0) : null;
    if (this.stream) {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) { this.dispose(); throw new Error('WebM recording unavailable'); }
      this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      this.recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        if (this.bytes + data.size > MAX_RECORDING_BYTES) {
          this.failure = new Error('Recording size limit');
          this.onLimit();
          return;
        }
        this.chunks.push(data);
        this.bytes += data.size;
        if (this.bytes > MAX_RECORDING_BYTES - 4 * 1024 * 1024) this.onLimit();
      };
      this.recorder.onerror = () => { this.failure = new Error('Recording failed'); this.onLimit(); };
      this.recorder.start(1000);
    } else this.recorder = null;
  }

  add(at: number): void {
    if (this.stopped) return;
    if (this.recorder) {
      (this.stream!.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
    } else if (this.gif) {
      const pixels = this.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, this.canvas.width, this.canvas.height);
      // Hold identical frames until the next change, pause or finish. Exact RGBA
      // comparison preserves small cursor/text changes and the full hold duration.
      if (this.previous && samePixels(this.previous.pixels, pixels.data)) return;
      this.flushGif(at);
      const palette = quantize(pixels.data, 256, { format: 'rgb444' });
      this.previous = { pixels: pixels.data, palette, index: applyPalette(pixels.data, palette, 'rgb444'), at };
      if (this.gif.bytesView().length > MAX_RECORDING_BYTES - 4 * 1024 * 1024) this.onLimit();
    }
  }

  private flushGif(at: number): void {
    if (!this.previous || !this.gif) return;
    this.gif.writeFrame(this.previous.index, this.canvas.width, this.canvas.height, {
      palette: this.previous.palette, delay: Math.max(20, at - this.previous.at), repeat: 0,
    });
    this.previous = null;
  }

  pause(at: number): void {
    if (this.recorder?.state === 'recording') this.recorder.pause();
    this.flushGif(at);
  }
  resume(): void { if (this.recorder?.state === 'paused') this.recorder.resume(); }

  async finish(at: number): Promise<Uint8Array<ArrayBuffer>> {
    if (this.stopped) throw new Error('Recording already stopped');
    this.stopped = true;
    if (this.recorder) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.stream?.getTracks().forEach((track) => track.stop()); reject(new Error('Recording finalization timed out')); }, 5000);
        this.recorder!.onstop = () => { clearTimeout(timer); resolve(); };
        this.recorder!.stop();
      });
      this.stream?.getTracks().forEach((track) => track.stop());
      if (this.failure) throw this.failure;
      if (!this.bytes) throw new Error('No video frames were encoded');
      const bytes = finalizeWebmDuration(new Uint8Array(await new Blob(this.chunks, { type: 'video/webm' }).arrayBuffer()), at);
      if (bytes.length > MAX_RECORDING_BYTES) throw new Error('Recording size limit');
      return bytes;
    }
    this.flushGif(at);
    this.gif!.finish();
    const bytes = this.gif!.bytes();
    if (bytes.length > MAX_RECORDING_BYTES) throw new Error('Recording size limit');
    return bytes;
  }

  dispose(): void {
    this.stopped = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.chunks.length = 0;
    this.previous = null;
  }
}

function samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}
