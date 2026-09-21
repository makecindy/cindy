import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createWebSocketMessageTransform } from './websocket-message-transform';

function frame(payload: Buffer, masked: boolean, opcode = 1, fin = true): Buffer {
  const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = (fin ? 128 : 0) | opcode;
  header[1] = (masked ? 128 : 0) | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(payload.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  const encoded = Buffer.from(payload);
  if (masked) {
    const mask = Buffer.from([1, 4, 9, 16]); mask.copy(header, 2 + extra);
    for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i % 4]!;
  }
  return Buffer.concat([header, encoded]);
}

it.each([0, 125, 126, 65535, 65536])('retains unchanged messages at frame length %i', async length => {
  for (const masked of [false, true]) {
    const input = frame(Buffer.alloc(length, 120), masked);
    const chunks: Buffer[] = [];
    const transform = createWebSocketMessageTransform(masked, payload => { expect(payload).toEqual(Buffer.alloc(length, 120)); return payload; });
    transform.on('data', chunk => chunks.push(chunk));
    const ended = once(transform, 'end');
    for (let offset = 0; offset < input.length; offset += 101) transform.write(input.subarray(offset, offset + 101));
    transform.end(); await ended;
    expect(Buffer.concat(chunks)).toEqual(input);
  }
});

it('rewrites a fragmented masked request while preserving interleaved control frames', async () => {
  const original = Buffer.concat([frame(Buffer.from('hel'), true, 1, false), frame(Buffer.from('ping'), true, 9), frame(Buffer.from('lo'), true, 0)]);
  const rewritten: Buffer[] = [];
  const writer = createWebSocketMessageTransform(true, message => { expect(message.toString()).toBe('hello'); return Buffer.from('changed'); });
  writer.on('data', chunk => rewritten.push(chunk)); const ended = once(writer, 'end'); writer.end(original); await ended;
  const messages: string[] = [];
  const reader = createWebSocketMessageTransform(true, message => { messages.push(message.toString()); return message; });
  reader.resume(); const readEnd = once(reader, 'end'); reader.end(Buffer.concat(rewritten)); await readEnd;
  expect(messages).toEqual(['changed']);
  expect(Buffer.concat(rewritten).subarray(0, 10)).toEqual(frame(Buffer.from('ping'), true, 9));
});

it.each([
  Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), // extension without negotiation
  frame(Buffer.from('unmasked'), false),
  frame(Buffer.from('orphan continuation'), true, 0),
  frame(Buffer.from('binary'), true, 2),
  frame(Buffer.alloc(126), true, 9),
  Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 4, 1]),
])('rejects malformed or oversized input before delivery', async input => {
  const transform = createWebSocketMessageTransform(true, message => message, 1024);
  const output: Buffer[] = []; transform.on('data', chunk => output.push(chunk));
  const failed = once(transform, 'error'); transform.end(input); await failed;
  expect(output).toEqual([]);
});

it('does not forward a partial message if the connection closes before FIN', async () => {
  const transform = createWebSocketMessageTransform(true, message => message);
  const output: Buffer[] = []; transform.on('data', chunk => output.push(chunk));
  const failed = once(transform, 'error'); transform.end(frame(Buffer.from('partial'), true, 1, false)); await failed;
  expect(output).toEqual([]);
});
