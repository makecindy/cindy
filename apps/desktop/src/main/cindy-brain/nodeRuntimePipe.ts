import { serialize, deserialize } from 'node:v8';
import type { Duplex } from 'node:stream';
import { GHOST_FETCH_RESPONSE_MAX_BYTES } from '../../shared/ghost.js';

// The private transport must accommodate the existing text-fetch limit in its
// UTF-16 representation plus framing. It does not widen any capability limit.
const MAX_FRAME_BYTES = GHOST_FETCH_RESPONSE_MAX_BYTES * 2 + 1024 * 1024;

/** Node-launcher equivalent of the private utilityProcess parent port. Plugin
 * stdio remains on separate descriptors; none of these frames enter stdout. */
export function createPluginControlPipe(
  stream: Duplex,
  onMessage: (message: unknown) => void,
  onFailure: () => void,
) {
  const header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let body: Buffer | null = null;
  let bodyBytes = 0;
  let closed = false;
  function fail() {
    if (closed) return;
    closed = true;
    body = null;
    stream.destroy();
    onFailure();
  }
  function receive(chunk: Buffer) {
    let offset = 0;
    while (!closed && offset < chunk.length) {
      if (!body) {
        const copied = chunk.copy(header, headerBytes, offset, offset + 4 - headerBytes);
        offset += copied;
        headerBytes += copied;
        if (headerBytes < 4) return;
        const length = header.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) { fail(); return; }
        body = Buffer.allocUnsafe(length);
        bodyBytes = 0;
      }
      const copied = chunk.copy(body, bodyBytes, offset, offset + body.length - bodyBytes);
      offset += copied;
      bodyBytes += copied;
      if (bodyBytes < body.length) return;
      const frame = body;
      body = null;
      headerBytes = 0;
      try { onMessage(deserialize(frame)); } catch { fail(); return; }
    }
  }
  stream.on('data', receive);
  stream.once('error', fail);
  stream.once('end', fail);
  // A destroyed descriptor need not emit end (e.g. a killed worker). Pending
  // calls must settle through the same failure path, exactly once.
  stream.once('close', fail);
  return {
    send(message: unknown): void {
      if (closed || stream.destroyed) throw new Error('Plugin control pipe is closed');
      const body = serialize(message);
      if (body.length > MAX_FRAME_BYTES || stream.writableLength > MAX_FRAME_BYTES * 4) {
        fail();
        throw new Error('Plugin control pipe capacity exceeded');
      }
      const frame = Buffer.allocUnsafe(body.length + 4);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      stream.write(frame);
    },
    dispose(): void {
      closed = true;
      body = null;
      stream.removeListener('data', receive);
      stream.destroy();
    },
  };
}
