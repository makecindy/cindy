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
    const ack = makeTransportAck('desktop', 'stream-1', 7);
    expect(ack).toMatchObject({
      kind: 'push',
      dst: 'desktop',
      payload: { channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL },
    });
    expect(parseTransportAck({ ...ack, src: 'mobile' })).toEqual({
      streamId: 'stream-1',
      ackSeq: 7,
    });
  });
});
