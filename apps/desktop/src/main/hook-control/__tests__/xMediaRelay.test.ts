/**
 * 生产入口 createXMediaRelay：视频分段发送、等确认、失败时收口，用户要么得到 media id，要么得到明确的失败。
 * 依据：内联受 48 MiB 单帧限制，X 视频改走 x.media.* 分块转传。缺口：新增模块。
 * 最小失败输入：跨段边界的文件、中途失败的分段。tier：unit，真实 temp 文件，send 注入。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { X_MEDIA_SEGMENT_MAX_BYTES, type HookMessage } from '@cindy/slack-hook-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createXMediaRelay } from '../xMediaRelay';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-x-relay-')); });
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

async function video(bytes: Buffer) {
  const file = path.join(dir, 'clip.mp4');
  await fs.writeFile(file, bytes);
  return file;
}

/** 按帧类型自动回执的假 server；fail 决定哪一步失败。 */
function setup(fail?: (message: HookMessage) => boolean) {
  const relay = createXMediaRelay();
  const sent: HookMessage[] = [];
  const send = (message: HookMessage): boolean => {
    sent.push(message);
    const { type, payload } = message as { type: string; payload: { uploadId: string; segmentIndex?: number } };
    if (type === 'x.media.abort') return true;
    const step = type.split('.').at(-1) as 'init' | 'append' | 'finalize';
    const failed = fail?.(message);
    queueMicrotask(() => relay.handleResult('conn-1', {
      uploadId: payload.uploadId, step, segmentIndex: step === 'append' ? payload.segmentIndex! : null,
      mediaId: step === 'finalize' && !failed ? '700' : null,
      error: failed ? { code: 'X_MEDIA_REJECTED', message: 'rejected', retryable: false } : null,
    }));
    return true;
  };
  return { relay, sent, send };
}

const types = (sent: HookMessage[]) => sent.map((message) => message.type);
const upload = (relay: ReturnType<typeof createXMediaRelay>, send: (m: HookMessage) => boolean, absPath: string) =>
  relay.upload({ connectionId: 'conn-1', requestId: 'req-1', absPath, mimeType: 'video/mp4', send });

describe('X media relay', () => {
  // 明确停止必须同时结束 Agent 已完成后的媒体传输；旧实现只中止 Agent，仍会把视频传完。
  // 最小输入：停止发生在读盘前、等 init 回执或两段之间。复用真实 upload 入口与 fake server。
  it.each(['before upload', 'waiting for a result', 'between steps'])('stops uploading when cancelled %s', async (when) => {
    const controller = new AbortController();
    const { relay, sent, send } = setup();
    const file = await video(Buffer.from('video'));
    if (when === 'before upload') controller.abort();
    const running = relay.upload({ connectionId: 'conn-1', requestId: 'req-1', absPath: file,
      mimeType: 'video/mp4', signal: controller.signal,
      send: (message) => {
        if (message.type === 'x.media.init' && when === 'waiting for a result') controller.abort();
        const accepted = send(message);
        if (message.type === 'x.media.init' && when === 'between steps') queueMicrotask(() => controller.abort());
        return accepted;
      },
    });
    await expect(running).rejects.toMatchObject({ code: 'X_MEDIA_RELAY_CANCELLED' });
    expect(types(sent)).not.toContain('x.media.append');
    expect(types(sent)).not.toContain('x.media.finalize');
  });

  it('sends the whole file in ordered segments, one at a time', async () => {
    const bytes = Buffer.alloc(X_MEDIA_SEGMENT_MAX_BYTES + 5, 7);
    const { relay, sent, send } = setup();
    await expect(upload(relay, send, await video(bytes))).resolves.toBe('700');
    expect(types(sent)).toEqual(['x.media.init', 'x.media.append', 'x.media.append', 'x.media.finalize']);
    expect(sent[0]?.payload).toMatchObject({ requestId: 'req-1', mimeType: 'video/mp4', totalBytes: bytes.length });
    const segments = sent.slice(1, 3).map((message) => message.payload as { segmentIndex: number; dataBase64: string });
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 1]);
    expect(Buffer.concat(segments.map((segment) => Buffer.from(segment.dataBase64, 'base64'))).equals(bytes)).toBe(true);
  });

  it.each(['x.media.init', 'x.media.append', 'x.media.finalize'])('stops and aborts when %s fails', async (type) => {
    const { relay, sent, send } = setup((message) => message.type === type);
    await expect(upload(relay, send, await video(Buffer.from('video')))).rejects.toMatchObject({ code: 'X_MEDIA_REJECTED' });
    expect(sent.at(-1)?.type).toBe('x.media.abort');
    expect(types(sent).filter((name) => name === type)).toHaveLength(1);
  });

  it('fails at once when the frame cannot be sent', async () => {
    const relay = createXMediaRelay();
    await expect(upload(relay, () => false, await video(Buffer.from('video'))))
      .rejects.toMatchObject({ code: 'X_MEDIA_RELAY_OFFLINE' });
  });

  it('rejects an upload that gets no answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const relay = createXMediaRelay({ stepTimeoutMs: 1_000 });
    const file = await video(Buffer.from('video'));
    let sendCount = 0;
    const running = upload(relay, () => { sendCount += 1; return true; }, file).catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendCount).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toMatchObject({ code: 'X_MEDIA_RELAY_TIMEOUT' });
  });

  it.each(['failConnection', 'failAll'] as const)('releases a waiting upload on %s', async (method) => {
    const relay = createXMediaRelay();
    const file = await video(Buffer.from('video'));
    let sendCount = 0;
    const running = upload(relay, () => { sendCount += 1; return true; }, file).catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendCount).toBe(1));
    relay[method]('conn-1');
    expect(await running).toMatchObject({ code: 'X_MEDIA_RELAY_DISCONNECTED' });
  });

  it('ignores a result from another connection or for another step', async () => {
    const relay = createXMediaRelay();
    const file = await video(Buffer.from('video'));
    let init: { uploadId: string } | undefined;
    const running = upload(relay, (message) => {
      if (message.type === 'x.media.init') init = message.payload as { uploadId: string };
      return true;
    }, file).catch((error: unknown) => error);
    await vi.waitFor(() => expect(init).toBeDefined());
    const stray = { uploadId: init!.uploadId, segmentIndex: null, mediaId: null, error: null };
    relay.handleResult('conn-2', { ...stray, step: 'init' });
    relay.handleResult('conn-1', { ...stray, step: 'finalize' });
    relay.failAll();
    expect(await running).toMatchObject({ code: 'X_MEDIA_RELAY_DISCONNECTED' });
  });
});
