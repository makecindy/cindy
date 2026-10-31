import { GifWorker } from './gifWorker';
import { MAX_RECORDING_BYTES } from '../../../shared/regionCapture';
import { finalizeWebmDuration } from './webmDuration';

/** Bounded, local-only encoding. Source pixels are supplied by the host's selected region. */
export class CaptureRecorder {
  private readonly gif: GifWorker | null;
  private inFlight: Promise<void> | null = null;
  private readonly recorder: MediaRecorder | null;
  private readonly stream: MediaStream | null;
  private readonly chunks: Blob[] = [];
  private bytes = 0;
  private stopped = false;
  private failure: Error | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, readonly format: 'webm' | 'gif', private readonly onLimit: () => void, createGifWorker?: () => Worker) {
    this.gif = format === 'gif' ? new GifWorker(canvas.width, canvas.height, createGifWorker) : null;
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

  add(at: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return Promise.reject(new Error('Recording frame still in flight'));
    if (this.recorder) {
      (this.stream!.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
      return Promise.resolve();
    }
    const pixels = this.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.inFlight = this.gif!.add(pixels.data, at).then((limit) => {
      if (limit && !this.stopped) this.onLimit();
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  pause(at: number): void {
    if (this.recorder?.state === 'recording') this.recorder.pause();
    this.gif?.pause(at);
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
    await this.inFlight;
    return this.gif!.finish(at);
  }

  dispose(): void {
    this.stopped = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.chunks.length = 0;
    this.gif?.dispose();
  }
}
