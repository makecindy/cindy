import { GifEncoding, type GifRequest, type GifResponse } from './gifEncoding';

let encoder: GifEncoding | null = null;
const send = (response: GifResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

// A worker processes these messages in order. Pause cannot overtake an accepted
// frame, and finish cannot overtake pause, even while encoding blocks this thread.
self.onmessage = ({ data }: MessageEvent<GifRequest>) => {
  try {
    if (data.kind === 'init') encoder = new GifEncoding(data.width, data.height);
    else if (!encoder) throw new Error('GIF encoder unavailable');
    else if (data.kind === 'add') send({ kind: 'added', id: data.id, limit: encoder.add(data.pixels, data.at) });
    else if (data.kind === 'pause') encoder.pause(data.at);
    else {
      const bytes = encoder.finish(data.at);
      send({ kind: 'finished', id: data.id, bytes }, [bytes.buffer]);
      encoder = null;
    }
  } catch (error) {
    encoder = null;
    send({ kind: 'error', message: error instanceof Error ? error.message : 'GIF encoding failed' });
  }
};
