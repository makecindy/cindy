/**
 * x.media.* 分块转传帧与 turn.end.xMediaIds。
 * 依据：两端各自校验同一份协议，帧形状错了会被对端丢弃，上传只能等到超时。
 * 缺口：新增帧。最小失败输入：缺字段或非数字 media id。tier：unit，构造 → 序列化 → 解析。
 */
import { describe, expect, it } from 'vitest';

import {
  makeTurnEnd, makeXMediaAbort, makeXMediaAppend, makeXMediaFinalize, makeXMediaInit, makeXMediaResult,
  parseHookMessage, serializeHookMessage,
  X_MEDIA_SEGMENT_MAX_BYTES,
} from '../index';

const target = { uploadId: 'up-1', requestId: 'req-1' };
const parsed = (frame: Parameters<typeof serializeHookMessage>[0]) => parseHookMessage(serializeHookMessage(frame));
const turnEnd = (xMediaIds: string[]) => makeTurnEnd({
  requestId: 'req-1', externalKey: 'x:1', sessionId: 's', status: 'ok', finalText: '', errorMessage: null,
  usage: { durationMs: 1 }, xMediaIds,
});

describe('x.media frames', () => {
  it.each([
    ['init', makeXMediaInit({ ...target, mimeType: 'video/mp4', totalBytes: 9 })],
    ['append', makeXMediaAppend({ ...target, segmentIndex: 0, dataBase64: 'YQ==' })],
    ['finalize', makeXMediaFinalize(target)],
    ['abort', makeXMediaAbort(target)],
    ['append result', makeXMediaResult({ uploadId: 'up-1', step: 'append', segmentIndex: 0, mediaId: null, error: null })],
    ['finalize result', makeXMediaResult({ uploadId: 'up-1', step: 'finalize', segmentIndex: null, mediaId: '700', error: null })],
    ['failed result', makeXMediaResult({ uploadId: 'up-1', step: 'init', segmentIndex: null, mediaId: null,
      error: { code: 'X_MEDIA_REJECTED', message: 'no', retryable: false } })],
    ['turn.end ids', turnEnd(['700'])],
  ])('round-trips %s', (_name, frame) => {
    expect(parsed(frame)).toMatchObject({ ok: true, message: { type: frame.type, payload: frame.payload } });
  });

  it.each([
    ['init without size', makeXMediaInit({ ...target, mimeType: 'video/mp4', totalBytes: 0 })],
    ['append without bytes', makeXMediaAppend({ ...target, segmentIndex: 0, dataBase64: '' })],
    ['append with a negative segment', makeXMediaAppend({ ...target, segmentIndex: -1, dataBase64: 'YQ==' })],
    ['append with invalid base64', makeXMediaAppend({ ...target, segmentIndex: 0, dataBase64: '!!!!' })],
    ['append with malformed padding', makeXMediaAppend({ ...target, segmentIndex: 0, dataBase64: 'YQ=' })],
    ['finalize without a task', makeXMediaFinalize({ uploadId: 'up-1', requestId: '' })],
    ['result with an unknown step', makeXMediaResult({ uploadId: 'up-1', step: 'status' as 'init', segmentIndex: null, mediaId: null, error: null })],
    ['result with a non-numeric id', makeXMediaResult({ uploadId: 'up-1', step: 'finalize', segmentIndex: null, mediaId: 'abc', error: null })],
    ['turn.end with a non-numeric id', turnEnd(['abc'])],
    ['turn.end with too many ids', turnEnd(['1', '2', '3', '4', '5'])],
  ])('rejects %s', (_name, frame) => {
    expect(parsed(frame).ok).toBe(false);
  });

  // 协议声明单段解码后最多 4 MiB；+1 字节与上限的编码长度相同，不能只按编码长度校验。
  it.each([X_MEDIA_SEGMENT_MAX_BYTES, X_MEDIA_SEGMENT_MAX_BYTES + 1])('enforces the decoded segment byte limit (%i)', (bytes) => {
    const frame = makeXMediaAppend({ ...target, segmentIndex: 0, dataBase64: Buffer.alloc(bytes).toString('base64') });
    expect(parsed(frame).ok).toBe(bytes === X_MEDIA_SEGMENT_MAX_BYTES);
  });
});
