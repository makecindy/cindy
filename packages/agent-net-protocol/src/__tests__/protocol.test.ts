/**
 * Wire-contract unit tests: complete length validation and bounded batches protect atomic forwarding.
 * V1/Rust suites do not parse V2 relay envelopes. Minimal failure: one trailing byte after a valid packet.
 * 实测耗时：2026-11-07 独立 workspace 运行约 0.3–0.9 秒。
 */
import { expect, it } from 'vitest';
import { encodeDatagrams, decodeDatagrams, MAX_FRAME_BYTES, buildAgentNetMediaKey, parseAgentNetMediaKey, isAgentNetMediaReference } from '../index.js';
it('round trips an addressed batch and rejects every incomplete boundary before delivering anything', () => {
  const packets = [Uint8Array.of(3, 4), Uint8Array.of(5, 6, 7)];
  const frame = encodeDatagrams('peer', packets);
  expect(decodeDatagrams(frame)).toEqual({ deviceId: 'peer', datagrams: packets });
  for (const length of [0, 1, 2, 5, 7, frame.length - 1]) expect(decodeDatagrams(frame.subarray(0, length))).toBeNull();
  const malformed = new Uint8Array(frame.length + 1); malformed.set(frame); malformed[frame.length] = 255;
  expect(decodeDatagrams(malformed)).toBeNull();
});
it('rejects invalid identifiers, empty packets and over-limit encoded batches', () => {
  expect(() => encodeDatagrams('../peer', [Uint8Array.of(1)])).toThrow();
  expect(() => encodeDatagrams('peer', [])).toThrow();
  expect(() => encodeDatagrams('peer', [new Uint8Array()])).toThrow();
  expect(() => encodeDatagrams('peer', [new Uint8Array(MAX_FRAME_BYTES)])).toThrow();
  const invalidId = Uint8Array.of(1, 1, 255, 0, 1, 1);
  expect(decodeDatagrams(invalidId)).toBeNull();
});
// Existing attachment ACLs require a task-owned path. A new encrypted receipt
// must retain that namespace without becoming an ordinary public-OSS request.
// Unit: production encoder/parser, malformed envelope and legacy compatibility.
it.each([false, true])('preserves encrypted attachment receipts and their task scope (shared=%s)', shared => {
  const value = { slot: '11111111-1111-4111-8111-111111111111', networkId: 'private:unit',
    grantId: '22222222-2222-4222-8222-222222222222', id: '33333333-3333-4333-8333-333333333333',
    headerSha256: 'a'.repeat(64), contentType: 'image/png',
    ...(shared ? { sharedTask: { sharedTaskId: 'task-a', deviceId: 'device-a' } } : {}) };
  const encoded = buildAgentNetMediaKey(value);
  expect(parseAgentNetMediaKey(encoded)).toEqual(value); expect(isAgentNetMediaReference(encoded)).toBe(true);
  if (shared) {
    expect(encoded.split('/').slice(0, 5)).toEqual(['cindy', 'device-link', 'shared-task', 'task-a', 'device-a']);
    expect(parseAgentNetMediaKey(encoded + 'z')).toBeNull();
    expect(isAgentNetMediaReference(encoded + 'z')).toBe(true);
    expect(parseAgentNetMediaKey(encoded.replace('/task-a/', '/../'))).toBeNull();
  } else expect(encoded.startsWith('agent-net-v3/')).toBe(true);
});
