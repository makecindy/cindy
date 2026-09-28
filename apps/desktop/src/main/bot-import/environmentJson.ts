import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const LARGE_JSON = 256 * 1024;
function isLarge(value: unknown): boolean {
  let bytes = 0;
  const visit = (part: unknown): boolean => {
    if (typeof part === 'string') bytes += part.length;
    else if (part && typeof part === 'object') {
      for (const [key, child] of Object.entries(part)) { bytes += key.length; if (visit(child)) return true; }
    }
    return bytes > LARGE_JSON;
  };
  return visit(value);
}

// Static, self-contained Node code so packaged Main needs no external worker
// asset or runtime module import. Imported data is a message, never source code.
const JSON_WORKER = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
parentPort.once('message', ({ operation, value }) => {
  try {
    const result = operation === 'decode' ? JSON.parse(value) : (() => {
      const text = JSON.stringify(value);
      return { text, revision: createHash('sha256').update(text).digest('hex') };
    })();
    parentPort.postMessage({ result });
  } catch { parentPort.postMessage({ failed: true }); }
});`;

async function convert<T>(operation: 'encode' | 'decode', value: unknown, assertOwner: () => void): Promise<T> {
  assertOwner();
  const worker = new Worker(JSON_WORKER, { eval: true });
  let fence: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = () => reject(new Error('CREDENTIAL_STORAGE_INVALID'));
      worker.once('error', fail);
      worker.once('exit', fail);
      worker.once('message', message => {
        try { assertOwner(); if (message.failed) fail(); else resolve(message.result as T); } catch (error) { reject(error); }
      });
      fence = setInterval(() => { try { assertOwner(); } catch (error) { reject(error); } }, 100);
      fence.unref();
      worker.postMessage({ operation, value });
    });
  } finally { clearInterval(fence); await worker.terminate(); }
}

export async function encodeEnvironment(value: unknown, assertOwner: () => void): Promise<{ text: string; revision: string }> {
  assertOwner();
  if (isLarge(value)) return convert('encode', value, assertOwner);
  const text = JSON.stringify(value);
  return { text, revision: createHash('sha256').update(text).digest('hex') };
}
export async function decodeEnvironment<T>(value: string, assertOwner: () => void): Promise<T> {
  assertOwner();
  return value.length > LARGE_JSON ? convert<T>('decode', value, assertOwner) : JSON.parse(value) as T;
}
