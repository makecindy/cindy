import { recordGunzip } from '@/debug/jankMetrics';
import { base64ToUint8Array, decodeGzipBase64TextBounded } from './gzipBase64';
import { gunzipBase64Worklet, type GunzipWorkletResult } from './gunzipBase64Worklet';

/** Below this a runtime hop costs about as much as decoding in place. */
export const OFF_THREAD_GUNZIP_MIN_BASE64_CHARS = 64 * 1024;
/**
 * Output-aware twin of the threshold above: repetitive JSON can be a few KB on the wire and
 * megabytes once inflated, which is the case that blocks the JS thread longest.
 */
export const OFF_THREAD_GUNZIP_MIN_OUTPUT_BYTES = 256 * 1024;
/** Runs are serial, so this also has to cover a short backlog of large results. */
export const OFF_THREAD_GUNZIP_TIMEOUT_MS = 10_000;

type Schedule = (base64: string, maxChars: number, done: (result: GunzipWorkletResult) => void) => void;

/** Uses the worklets package every build already ships, so this needs no native change. */
function createWorkletSchedule(): Schedule | null {
  try {
    const { createWorkletRuntime, scheduleOnRN, scheduleOnRuntime } =
      require('react-native-worklets') as typeof import('react-native-worklets');
    const runtime = createWorkletRuntime({ name: 'cindy-gunzip' });
    return (base64, maxChars, done) => {
      scheduleOnRuntime(runtime, (input: string, limit: number) => {
        'worklet';
        scheduleOnRN(done, gunzipBase64Worklet(input, limit));
      }, base64, maxChars);
    };
  } catch {
    return null;
  }
}

/**
 * The gzip trailer ends with ISIZE, the uncompressed length mod 2^32, so the size is known from
 * the last 12 base64 characters without inflating. It only routes the work; the decoder still
 * enforces the real limit, and a lying trailer just picks the other (correct) path.
 */
export function gzipUncompressedSizeHint(base64: string): number | null {
  if (base64.length < 12 || base64.length % 4 !== 0) return null;
  try {
    const tail = base64ToUint8Array(base64.slice(-12));
    const n = tail.length;
    if (n < 4) return null;
    return (tail[n - 4] | (tail[n - 3] << 8) | (tail[n - 2] << 16) | (tail[n - 1] << 24)) >>> 0;
  } catch {
    return null;
  }
}

function clock(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function createOffThreadGunzip(options: {
  createSchedule: () => Schedule | null;
  decodeOnThread?: (base64: string, maxChars: number) => string;
  minBase64Chars?: number;
  minOutputBytes?: number;
  timeoutMs?: number;
}): (base64: string, maxChars: number) => Promise<string> {
  const decodeOnThread = options.decodeOnThread ?? decodeGzipBase64TextBounded;
  const minChars = options.minBase64Chars ?? OFF_THREAD_GUNZIP_MIN_BASE64_CHARS;
  const minOutput = options.minOutputBytes ?? OFF_THREAD_GUNZIP_MIN_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? OFF_THREAD_GUNZIP_TIMEOUT_MS;
  let schedule: Schedule | null | undefined;

  const onThread = (base64: string, maxChars: number, fallback: boolean) => {
    const startedAt = clock();
    try {
      return decodeOnThread(base64, maxChars);
    } finally {
      recordGunzip({ offThread: false, onThreadMs: clock() - startedAt, fallback });
    }
  };

  return async (base64, maxChars) => {
    if (base64.length < minChars && (gzipUncompressedSizeHint(base64) ?? 0) < minOutput) {
      return onThread(base64, maxChars, false);
    }
    if (schedule === undefined) schedule = options.createSchedule();
    const run = schedule;
    if (!run) return onThread(base64, maxChars, true);
    const result = await new Promise<GunzipWorkletResult | null>((resolve) => {
      const timer = setTimeout(() => {
        // A runtime that stopped answering would delay every later result by the full timeout.
        if (schedule === run) schedule = null;
        resolve(null);
      }, timeoutMs);
      try {
        run(base64, maxChars, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (result?.ok) {
      recordGunzip({ offThread: true });
      return result.text;
    }
    if (result?.limitExceeded) throw new RangeError(result.message);
    // pako stays the authority: an unexpected failure here must not fail a valid response.
    return onThread(base64, maxChars, true);
  };
}

export const gunzipBase64OffThread = createOffThreadGunzip({ createSchedule: createWorkletSchedule });
