import { describe, expect, it } from 'vitest';
import type { Envelope } from '../protocol.js';
import {
  DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
  MAX_TRANSPORT_CHUNK_BYTES,
  byteLength,
  decodeTransportJson,
  encodeReliableFrames,
  makeTransportAck,
  parseTransportAck,
  parseTransportPayload,
  reliableRetryDelayMs,
  retransmitBaseMs,
  TRANSPORT_ADAPTIVE_RETRY_MAX_MS,
  updateRetransmitEstimate,
  updateDeliveryEstimate,
  type RetransmitEstimate,
} from '../transport.js';

describe('device-link reliable transport codec', () => {
  it('UTF-8 字节计数不依赖 TextEncoder，兼容 Hermes', () => {
    expect(byteLength('ascii')).toBe(5);
    expect(byteLength('弱网')).toBe(6);
    expect(byteLength('😀')).toBe(4);
    expect(byteLength('\ud800')).toBe(3);
  });

  it('小 payload 保持一个逻辑帧并可还原', () => {
    const env: Envelope = {
      v: 1,
      kind: 'invoke-result',
      id: 'req-1',
      dst: 'controller',
      payload: { ok: true, result: ['hello'] },
    };
    const frames = encodeReliableFrames(env, 'stream-1', 1);
    expect(frames).toHaveLength(1);
    const parsed = parseTransportPayload(frames[0].payload);
    expect(parsed?.meta).toMatchObject({ streamId: 'stream-1', seq: 1 });
    expect(parsed?.meta.segment).toBeUndefined();
    expect(decodeTransportJson(parsed!.data)).toEqual(env.payload);
  });

  it('baseSeq 可随重放基线编码，并拒绝越过当前 seq', () => {
    const env: Envelope = {
      v: 1,
      kind: 'push',
      dst: 'controller',
      payload: { channel: 'maker:event', payload: { ok: true } },
    };
    const [frame] = encodeReliableFrames(env, 'stream-1', 101, 100);
    expect(parseTransportPayload(frame.payload)?.meta).toMatchObject({
      streamId: 'stream-1',
      seq: 101,
      baseSeq: 100,
    });
    expect(() => encodeReliableFrames(env, 'stream-1', 101, 102)).toThrow(
      'invalid transport stream metadata',
    );
  });

  it('大 CJK payload 按 UTF-8 字节切片且完整重组', () => {
    const payload = { text: '弱'.repeat(MAX_TRANSPORT_CHUNK_BYTES) };
    const frames = encodeReliableFrames(
      { v: 1, kind: 'push', dst: 'controller', payload },
      'stream-2',
      8,
    );
    expect(frames.length).toBeGreaterThan(1);
    const parsed = frames.map((frame) => parseTransportPayload(frame.payload)!);
    expect(parsed.every((part) => part.meta.segment?.total === frames.length)).toBe(true);
    const json = parsed
      .sort((a, b) => a.meta.segment!.index - b.meta.segment!.index)
      .map((part) => part.data)
      .join('');
    expect(decodeTransportJson(json, parsed[0].meta.segment!.totalBytes)).toEqual(payload);
  });

  it('拒绝越界 segment 元数据', () => {
    expect(parseTransportPayload({
      __cindyDeviceLinkTransport: {
        version: 1,
        streamId: 'stream',
        seq: 1,
        segment: { index: 2, total: 2, totalBytes: 1 },
      },
      data: '{}',
    })).toBeNull();
  });

  it('ACK 是普通 push 且可解析', () => {
    const ack = makeTransportAck('desktop', 'stream-1', 7, 'link-open-1');
    expect(ack).toMatchObject({
      kind: 'push',
      dst: 'desktop',
      payload: { channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL },
    });
    expect(parseTransportAck({ ...ack, src: 'mobile' })).toEqual({
      streamId: 'stream-1',
      ackSeq: 7,
      linkRequestId: 'link-open-1',
    });
  });
});

describe('adaptive retransmit interval', () => {
  it('keeps the configured interval until the first round-trip sample', () => {
    const estimate: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    expect(retransmitBaseMs(estimate, 2_000)).toBe(2_000);
  });

  it('never retries faster than configured on a fast link', () => {
    const estimate: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    for (let i = 0; i < 10; i += 1) updateRetransmitEstimate(estimate, 40);
    expect(retransmitBaseMs(estimate, 2_000)).toBe(2_000);
  });

  it('widens to SRTT + 4·RTTVAR on a slow link and is capped', () => {
    const estimate: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    updateRetransmitEstimate(estimate, 1_500);
    expect(retransmitBaseMs(estimate, 2_000)).toBe(1_500 + 4 * 750);
    updateRetransmitEstimate(estimate, 60_000);
    expect(retransmitBaseMs(estimate, 2_000)).toBe(TRANSPORT_ADAPTIVE_RETRY_MAX_MS);
  });

  it('recovers toward the configured interval once the link speeds up', () => {
    const estimate: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    updateRetransmitEstimate(estimate, 6_000);
    for (let i = 0; i < 40; i += 1) updateRetransmitEstimate(estimate, 100);
    expect(retransmitBaseMs(estimate, 2_000)).toBe(2_000);
  });

  it('matches the fixed schedule until a round trip is measured', () => {
    const unknown: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    expect([1, 2, 3, 4].map((attempts) => reliableRetryDelayMs(unknown, 2_000, 1, attempts)))
      .toEqual([2_000, 4_000, 8_000, 8_000]);
    expect(reliableRetryDelayMs(unknown, 2_000, 13, 1)).toBe(26_000);
  });

  it('paces large retries by confirmed goodput without stretching small requests', () => {
    const slow: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    updateDeliveryEstimate(slow, 128 * 1024, 60_000);
    expect(reliableRetryDelayMs(slow, 2_000, 8, 1, 128 * 1024)).toBe(90_000);
    expect(reliableRetryDelayMs(slow, 2_000, 60, 4, 1_852_521)).toBe(120_000);
    expect(reliableRetryDelayMs(slow, 2_000, 1, 1, 100)).toBe(2_000);
    const prior = slow.deliveryBytesPerMs;
    updateDeliveryEstimate(slow, 100, 1);
    updateDeliveryEstimate(slow, 128 * 1024, 0);
    expect(slow.deliveryBytesPerMs).toBe(prior);
    updateDeliveryEstimate(slow, 128 * 1024, 1_000);
    expect(reliableRetryDelayMs(slow, 2_000, 8, 1, 128 * 1024)).toBeLessThan(90_000);
    const healthy: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    expect(reliableRetryDelayMs(healthy, 2_000, 8, 1, 128 * 1024)).toBe(16_000);
  });

  it('does not multiply byte pacing by the slow round trip', () => {
    const slow: RetransmitEstimate = { srttMs: 4_000, rttVarMs: 1_000 };
    expect(reliableRetryDelayMs(slow, 2_000, 1, 1)).toBe(8_000);
    expect(reliableRetryDelayMs(slow, 2_000, 13, 1)).toBe(26_000);
    expect(reliableRetryDelayMs(slow, 2_000, 13, 3)).toBe(32_000);
  });

  it('clamps an outlier sample so one stalled ACK cannot pin the interval at the cap', () => {
    const estimate: RetransmitEstimate = { srttMs: null, rttVarMs: 0 };
    for (let i = 0; i < 10; i += 1) updateRetransmitEstimate(estimate, 300);
    updateRetransmitEstimate(estimate, 120_000);
    expect(estimate.srttMs).toBeLessThan(1_600);
    for (let i = 0; i < 20; i += 1) updateRetransmitEstimate(estimate, 300);
    expect(retransmitBaseMs(estimate, 2_000)).toBe(2_000);
  });
});
