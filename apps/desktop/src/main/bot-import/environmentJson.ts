import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { CompanionEnvironment, CompanionDiscoveryEnvironment } from './environment.js';

/** Only live connection inputs belong in discovery, never original files or retry archives. */
export function projectEnvironmentDiscovery(value: CompanionEnvironment): CompanionDiscoveryEnvironment {
  return { env: value.env, mcp: value.mcp, pendingImport: !!value.pendingImport,
    identity: createHash('sha256').update(JSON.stringify([value.env, value.mcp, value.credentials])).digest('hex') };
}

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
    const result = operation === 'discovery' ? (() => {
      const data = JSON.parse(value);
      if (data.version !== 1 || !data.env || !Array.isArray(data.mcp) || !Array.isArray(data.credentials)) throw new Error();
      return { env: data.env, mcp: data.mcp, pendingImport: !!data.pendingImport,
        identity: createHash('sha256').update(JSON.stringify([data.env, data.mcp, data.credentials])).digest('hex') };
    })() : operation === 'decode' ? JSON.parse(value) : (() => {
      const text = JSON.stringify(value);
      return { text, revision: createHash('sha256').update(text).digest('hex') };
    })();
    parentPort.postMessage({ result });
  } catch { parentPort.postMessage({ failed: true }); }
});`;

async function convert<T>(operation: 'encode' | 'decode' | 'discovery', value: unknown, assertOwner: () => void): Promise<T> {
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

/** Legacy recovery parses the archive in a worker but clones only connection metadata back to Main. */
export async function decodeEnvironmentDiscovery(value: string, assertOwner: () => void): Promise<CompanionDiscoveryEnvironment> {
  assertOwner();
  if (value.length > LARGE_JSON) return convert('discovery', value, assertOwner);
  const data = JSON.parse(value) as CompanionEnvironment;
  if (data.version !== 1 || !data.env || !Array.isArray(data.mcp) || !Array.isArray(data.credentials)) throw new Error('CREDENTIAL_STORAGE_INVALID');
  return projectEnvironmentDiscovery(data);
}
