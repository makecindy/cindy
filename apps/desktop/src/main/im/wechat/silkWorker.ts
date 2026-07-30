// eslint-disable-next-line no-restricted-imports -- dedicated non-DB worker entry for bounded SILK/WASM decoding.
import { parentPort } from 'node:worker_threads';

import { decode } from 'silk-wasm';
import { pcmS16leToWav, WavOutputLimitError } from './silkWav';

const port = parentPort;
if (!port) throw new Error('WeChat SILK decoder must run in a worker thread.');

const SILK_OUTPUT_LIMIT_ERROR = 'SILK_OUTPUT_LIMIT_EXCEEDED';
const SILK_OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;

port.once('message', async (request: { id: string; bytes: ArrayBuffer; sampleRate: number }) => {
  try {
    const decoded = await decode(new Uint8Array(request.bytes), request.sampleRate);
    const wav = pcmS16leToWav(decoded.data, request.sampleRate, SILK_OUTPUT_LIMIT_BYTES);
    const transferable = new Uint8Array(wav.byteLength);
    transferable.set(wav);
    port.postMessage({ id: request.id, ok: true, bytes: transferable.buffer }, [
      transferable.buffer,
    ]);
  } catch (error) {
    const errorCode =
      error instanceof WavOutputLimitError ? SILK_OUTPUT_LIMIT_ERROR : 'SILK_DECODE_FAILED';
    port.postMessage({ id: request.id, ok: false, errorCode });
  }
});
