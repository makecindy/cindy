import type { Duplex } from 'node:stream';
import type { ParentPortLike } from './nodeWorker.js';

/** Private bootstrap FD, separate from a plugin's public JSON-RPC stdio.
 * This is process isolation, not an OS sandbox. No credentials enter logs. */
export function createControlPort(stream: Duplex, failed: () => void): ParentPortLike {
  const listeners = new Set<(event: { data: unknown }) => void>();
  let pending = Buffer.alloc(0);
  const limit = 2 * 1024 * 1024;
  stream.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      const end = pending.indexOf(10);
      if (end < 0) { if (pending.length > limit) failed(); return; }
      if (end > limit) { failed(); return; }
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      let data: unknown;
      try { data = JSON.parse(line.toString('utf8')); } catch { failed(); return; }
      for (const listener of listeners) listener({ data });
    }
  });
  stream.on('error', failed);
  return {
    on(_event, listener) { listeners.add(listener); },
    postMessage(message) {
      const line = JSON.stringify(message);
      if (Buffer.byteLength(line) > limit) throw new Error('PLUGIN_CONTROL_FRAME_TOO_LARGE');
      if (stream.destroyed || !stream.writable) throw new Error('PLUGIN_CONTROL_CLOSED');
      stream.write(`${line}\n`);
    },
  };
}
