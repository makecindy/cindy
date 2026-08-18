/**
 * Electron utility-process entry for the local DSH ESM runtime.
 *
 * Production builds disable RunAsNode, so the desktop host cannot spawn process.execPath as a
 * Node executable. This small host-owned entry supplies virtual stdin, then imports DSH in the
 * Node service process that Electron officially exposes for this purpose.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installVirtualStdin } from '../cindy-brain/nodeRuntimeVirtualStdin.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const entryPath = process.argv[2];
const configPath = process.argv[3];

if (!parentPort) throw new Error('DSH utility process is missing parentPort');
if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath) || !entryPath.endsWith('.js')) {
  throw new Error('DSH utility process entry is invalid');
}
if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
  throw new Error('DSH utility process config path is invalid');
}

const virtualStdin = installVirtualStdin(process);
parentPort.on('message', (event) => {
  const data = event.data;
  if (!isRecord(data)) return;
  if (data.type === 'stdin-b64' && typeof data.chunk === 'string') {
    if (data.chunk.length <= 32 * 1024 * 1024) {
      virtualStdin.feed(Buffer.from(data.chunk, 'base64'));
    }
  } else if (data.type === 'stdin-end') {
    virtualStdin.end();
  }
});

process.argv = [process.argv[0], entryPath, configPath];
parentPort.postMessage({ type: 'ready' });
try {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
  });
} catch {
  // The runtime has no supported use for the private host control port.
}

void import(/* @vite-ignore */ pathToFileURL(entryPath).href).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`DSH runtime failed to load: ${message}\n`);
  setImmediate(() => process.exit(1));
});
