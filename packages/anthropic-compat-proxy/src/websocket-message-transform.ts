import { randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/** Opt-in RFC6455 message filter. Negotiation must exclude compression/extensions. */
export function createWebSocketMessageTransform(
  masked: boolean,
  filter: (message: Buffer) => Buffer,
  maxBytes = 128 * 1024 * 1024,
): Transform {
  // Queue incoming chunks: a large frame arriving in small packets must not
  // repeatedly copy its entire accumulated prefix (quadratic in frame size).
  let chunks: Array<Buffer | undefined> = [];
  let head = 0;
  let headOffset = 0;
  let buffered = 0;
  const peek = (length: number): Buffer => {
    const first = chunks[head]!;
    if (first.length - headOffset >= length) return first.subarray(headOffset, headOffset + length);
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    for (let index = head; written < length; index++) {
      const chunk = chunks[index]!;
      const offset = index === head ? headOffset : 0;
      written += chunk.copy(out, written, offset, offset + length - written);
    }
    return out;
  };
  const take = (length: number): Buffer => {
    const out = peek(length);
    buffered -= length;
    while (length > 0) {
      const available = chunks[head]!.length - headOffset;
      if (length < available) { headOffset += length; break; }
      length -= available; chunks[head++] = undefined; headOffset = 0;
    }
    if (head === chunks.length) { chunks = []; head = 0; }
    else if (head > 1024) { chunks = chunks.slice(head); head = 0; }
    return out;
  };
  let fragments: Buffer[] = [];
  let originalFrames: Buffer[] = [];
  let size = 0;
  let opcode = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        if (chunk.length) { chunks.push(chunk); buffered += chunk.length; }
        while (buffered >= 2) {
          const prefix = peek(Math.min(buffered, 10));
          const first = prefix[0]!;
          const second = prefix[1]!;
          const op = first & 15;
          const fin = (first & 128) !== 0;
          if (first & 112 || Boolean(second & 128) !== masked) throw new Error('Invalid websocket framing');
          let length = second & 127;
          let offset = 2;
          if (length === 126) {
            if (buffered < 4) break;
            length = prefix.readUInt16BE(2); offset = 4;
          } else if (length === 127) {
            if (buffered < 10) break;
            const value = prefix.readBigUInt64BE(2);
            if (value > BigInt(maxBytes)) throw new Error('Websocket message too large');
            length = Number(value); offset = 10;
          }
          if (length > maxBytes || (op < 8 && size + length > maxBytes)) throw new Error('Websocket message too large');
          const maskOffset = offset;
          if (masked) offset += 4;
          if (buffered < offset + length) break;
          const frame = take(offset + length);
          const payload = Buffer.from(frame.subarray(offset));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= frame[maskOffset + i % 4]!;
          if (op >= 8) {
            if (!fin || length > 125 || ![8, 9, 10].includes(op)) throw new Error('Invalid websocket control frame');
            this.push(frame); continue;
          }
          if (op === 0 ? opcode === 0 : opcode !== 0 || op !== 1) throw new Error('Expected a websocket text message');
          if (op !== 0) opcode = op;
          if (originalFrames.length >= 65536) throw new Error('Too many websocket fragments');
          fragments.push(payload); originalFrames.push(frame); size += length;
          if (!fin) continue;
          const message = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, size);
          const filtered = filter(message);
          if (filtered.length > maxBytes) throw new Error('Websocket message too large');
          if (filtered === message) for (const original of originalFrames) this.push(original);
          else {
            const extra = filtered.length < 126 ? 0 : filtered.length <= 65535 ? 2 : 8;
            const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
            header[0] = 129;
            header[1] = (masked ? 128 : 0) | (extra === 0 ? filtered.length : extra === 2 ? 126 : 127);
            if (extra === 2) header.writeUInt16BE(filtered.length, 2);
            if (extra === 8) header.writeBigUInt64BE(BigInt(filtered.length), 2);
            const body = Buffer.from(filtered);
            if (masked) {
              const mask = randomBytes(4); mask.copy(header, 2 + extra);
              for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]!;
            }
            this.push(header); this.push(body);
          }
          fragments = []; originalFrames = []; size = 0; opcode = 0;
        }
        callback();
      } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      callback(buffered || opcode ? new Error('Incomplete websocket message') : undefined);
    },
  });
}
