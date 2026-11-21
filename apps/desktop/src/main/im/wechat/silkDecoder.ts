import { randomUUID } from 'node:crypto';
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- SILK decoding is CPU-isolated and never touches the database.
import { Worker } from 'node:worker_threads';

const SILK_SAMPLE_RATE = 24_000;
const SILK_DECODE_TIMEOUT_MS = 30_000;
const SILK_MAGIC = '#!SILK';

/**
 * WeChat voice bytes are SILK v3 streams in practice, but Tencent variants
 * exist with a single 0x02 byte before the magic (seen in QQ/WeChat exports).
 * Detect by content so staging never gates on the wire-side encode_type.
 */
export function isSilkStream(bytes: Uint8Array): boolean {
  if (startsWithAscii(bytes, SILK_MAGIC)) return true;
  return (
    bytes.length >= 1 + SILK_MAGIC.length &&
    bytes[0] === 0x02 &&
    startsWithAscii(bytes.subarray(1), SILK_MAGIC)
  );
}

export async function decodeWechatSilkToWav(
  silk: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw new Error('WECHAT_SILK_DECODE_ABORTED');
  const worker = new Worker(path.join(__dirname, 'silkWorker.js'));
  const id = randomUUID();
  const bytes = copySilkBytes(stripSilkPrefix(silk));
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        operation();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error('WECHAT_SILK_DECODE_TIMEOUT')));
      }, SILK_DECODE_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = (): void => finish(() => reject(new Error('WECHAT_SILK_DECODE_ABORTED')));
      signal.addEventListener('abort', onAbort, { once: true });
      worker.once('error', (error) => finish(() => reject(error)));
      worker.once(
        'message',
        (response: { id?: unknown; ok?: unknown; bytes?: unknown; errorCode?: unknown }) => {
          if (response.id !== id) {
            finish(() => reject(new Error('WECHAT_SILK_DECODE_FAILED')));
            return;
          }
          if (response.ok !== true) {
            const errorCode =
              typeof response.errorCode === 'string' && response.errorCode.length > 0
                ? response.errorCode
                : 'WECHAT_SILK_DECODE_FAILED';
            finish(() => reject(new Error(errorCode)));
            return;
          }
          const responseBytes = response.bytes;
          if (!(responseBytes instanceof ArrayBuffer)) {
            finish(() => reject(new Error('WECHAT_SILK_DECODE_FAILED')));
            return;
          }
          finish(() => resolve(new Uint8Array(responseBytes)));
        },
      );
      worker.once('exit', (code) => {
        if (code !== 0) {
          finish(() => reject(new Error('WECHAT_SILK_WORKER_EXITED')));
        }
      });
      worker.postMessage({ id, bytes: bytes.buffer, sampleRate: SILK_SAMPLE_RATE }, [bytes.buffer]);
    });
  } finally {
    await worker.terminate();
  }
}

function stripSilkPrefix(silk: Uint8Array): Uint8Array {
  return !startsWithAscii(silk, SILK_MAGIC) && isSilkStream(silk)
    ? silk.subarray(1)
    : silk;
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function copySilkBytes(silk: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(silk.byteLength));
  bytes.set(silk);
  return bytes;
}

export const __testing = {
  copySilkBytes,
  isSilkStream,
  stripSilkPrefix,
};
