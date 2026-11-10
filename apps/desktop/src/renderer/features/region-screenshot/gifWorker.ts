import EncodingWorker from './gifEncoding.worker?worker';
import type { GifRequest, GifResponse } from './gifEncoding';

/** At most one frame is in flight. Pixels and final bytes are transferred, not
 * cloned. Cancelling terminates work immediately and settles the awaiting sample. */
export class GifWorker {
  private readonly worker: Worker;
  private sequence = 0;
  private failure: Error | null = null;
  private pending: { id: number; resolve: (response: GifResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(width: number, height: number, createWorker = () => new EncodingWorker()) {
    this.worker = createWorker();
    this.worker.onmessage = ({ data }: MessageEvent<GifResponse>) => {
      if (data.kind === 'error') { this.fail(new Error(data.message)); return; }
      if (this.pending?.id !== data.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(data);
    };
    this.worker.onerror = () => this.fail(new Error('GIF worker failed'));
    this.worker.onmessageerror = () => this.fail(new Error('GIF worker response failed'));
    try { this.worker.postMessage({ kind: 'init', width, height } satisfies GifRequest); }
    catch (error) { this.worker.terminate(); throw error; }
  }

  private request(message: GifRequest & { id: number }, transfer: Transferable[] = []): Promise<GifResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('GIF frame still in flight'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('GIF encoding timed out')), 15_000);
      this.pending = { id: message.id, resolve, reject, timer };
      try { this.worker.postMessage(message, transfer); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('GIF worker unavailable')); }
    });
  }

  async add(pixels: Uint8ClampedArray<ArrayBuffer>, at: number): Promise<boolean> {
    const result = await this.request({ kind: 'add', id: ++this.sequence, pixels, at }, [pixels.buffer]);
    if (result.kind !== 'added') throw new Error('Invalid GIF frame response');
    return result.limit;
  }

  pause(at: number): void {
    if (this.failure) return;
    try { this.worker.postMessage({ kind: 'pause', at } satisfies GifRequest); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('GIF worker unavailable')); }
  }

  async finish(at: number): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const result = await this.request({ kind: 'finish', id: ++this.sequence, at });
      if (result.kind !== 'finished') throw new Error('Invalid GIF finish response');
      return result.bytes;
    } finally { this.dispose(); }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.worker.terminate();
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
  }

  dispose(): void { this.fail(new Error('GIF recording disposed')); }
}
