import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

import {
  createClaudeFastModeRequestTransform,
  createClaudeFastModeResponseObserver,
  extractResponseSpeed,
} from '../claude-fast-mode-log.js';

/** 造一个可捕获 debug 调用、可切换 debug 级别的 ProxyLogger。 */
function makeLogger(debugEnabled = true) {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    isDebugEnabled: () => debugEnabled,
  };
}

function observerCtx(overrides: Record<string, unknown> = {}) {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages?beta=true',
    upstreamBase: XD_GATEWAY_BASE_URL,
    status: 200,
    requestHeaders: { 'anthropic-beta': 'fast-mode-2026-02-01,oauth-2025-04-20' },
    responseHeaders: { 'content-type': 'text/event-stream' },
    requestBody: Buffer.from(JSON.stringify({ model: 'claude-opus-4-8', speed: 'fast' })),
    ...overrides,
  } as Parameters<ReturnType<typeof createClaudeFastModeResponseObserver>>[0];
}

/** Anthropic message_start SSE frame，usage.speed 由参数决定。 */
function messageStartFrame(speed: string): string {
  const data = { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, speed } } };
  return `event: message_start\ndata: ${JSON.stringify(data)}`;
}

describe('extractResponseSpeed', () => {
  it('reads speed from message_start usage', () => {
    expect(extractResponseSpeed({ message: { usage: { speed: 'fast' } } })).toBe('fast');
  });
  it('falls back to top-level usage.speed (message_delta / non-stream)', () => {
    expect(extractResponseSpeed({ usage: { speed: 'standard' } })).toBe('standard');
  });
  it('returns null when no speed present', () => {
    expect(extractResponseSpeed({ message: { usage: { input_tokens: 5 } } })).toBeNull();
  });
});

describe('createClaudeFastModeRequestTransform (开头)', () => {
  it('logs requested speed + fast beta, returns null (never rewrites body)', () => {
    const log = makeLogger();
    const transform = createClaudeFastModeRequestTransform(log);
    const out = transform(
      { model: 'claude-opus-4-8', speed: 'fast' },
      { reqId: 1, method: 'POST', url: '/v1/messages?beta=true', headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } },
    );
    expect(out).toBeNull();
    expect(log.debug).toHaveBeenCalledWith(
      'claude fast mode requested (request side)',
      expect.objectContaining({ model: 'claude-opus-4-8', requestSpeed: 'fast', fastBeta: true }),
    );
  });

  it('is silent (and passthrough) when debug disabled', () => {
    const log = makeLogger(false);
    const transform = createClaudeFastModeRequestTransform(log);
    const out = transform(
      { model: 'claude-opus-4-8', speed: 'fast' },
      { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} },
    );
    expect(out).toBeNull();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('ignores non-messages paths', () => {
    const log = makeLogger();
    const transform = createClaudeFastModeRequestTransform(log);
    transform({ model: 'x' }, { reqId: 1, method: 'POST', url: '/v1/messages/count_tokens', headers: {} });
    expect(log.debug).not.toHaveBeenCalled();
  });
});

describe('createClaudeFastModeResponseObserver (结尾)', () => {
  it('logs appliedFast=true when upstream usage.speed is fast', () => {
    const log = makeLogger();
    const sink = createClaudeFastModeResponseObserver(log)(observerCtx());
    expect(sink).toBeTruthy();
    sink!.onData?.(Buffer.from(`${messageStartFrame('fast')}\n\n`));
    expect(log.debug).toHaveBeenCalledWith(
      'claude fast mode applied (usage.speed observed)',
      expect.objectContaining({ requestSpeed: 'fast', fastBeta: true, responseSpeed: 'fast', appliedFast: true }),
    );
  });

  it('logs appliedFast=false when requested fast but upstream applied standard (gateway dropped beta)', () => {
    const log = makeLogger();
    const sink = createClaudeFastModeResponseObserver(log)(observerCtx());
    sink!.onData?.(Buffer.from(`${messageStartFrame('standard')}\n\n`));
    expect(log.debug).toHaveBeenCalledWith(
      'claude fast mode applied (usage.speed observed)',
      expect.objectContaining({ requestSpeed: 'fast', responseSpeed: 'standard', appliedFast: false }),
    );
  });

  it('handles speed split across chunks and stops after first hit', () => {
    const log = makeLogger();
    const sink = createClaudeFastModeResponseObserver(log)(observerCtx());
    const frame = `${messageStartFrame('fast')}\n\n`;
    const mid = Math.floor(frame.length / 2);
    sink!.onData?.(Buffer.from(frame.slice(0, mid)));
    sink!.onData?.(Buffer.from(frame.slice(mid)));
    sink!.onData?.(Buffer.from('event: message_delta\ndata: {"type":"message_delta","usage":{"speed":"standard"}}\n\n'));
    // 只在第一帧命中后 emit 一次,后续 message_delta 不再覆盖。
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      'claude fast mode applied (usage.speed observed)',
      expect.objectContaining({ responseSpeed: 'fast' }),
    );
  });

  it('logs "not seen" when stream ends without usage.speed', () => {
    const log = makeLogger();
    const sink = createClaudeFastModeResponseObserver(log)(observerCtx());
    sink!.onData?.(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n'));
    sink!.onEnd?.();
    expect(log.debug).toHaveBeenCalledWith(
      'claude fast mode: usage.speed not seen in response',
      expect.objectContaining({ requestSpeed: 'fast' }),
    );
  });

  it('does not attach a sink when debug disabled (zero overhead)', () => {
    const log = makeLogger(false);
    expect(createClaudeFastModeResponseObserver(log)(observerCtx())).toBeNull();
  });

  it('ignores non-2xx responses', () => {
    const log = makeLogger();
    expect(createClaudeFastModeResponseObserver(log)(observerCtx({ status: 400 }))).toBeNull();
  });

  it('ignores non-messages paths', () => {
    const log = makeLogger();
    expect(
      createClaudeFastModeResponseObserver(log)(observerCtx({ url: '/v1/messages/count_tokens' })),
    ).toBeNull();
  });

  it('decompresses a gzip-encoded SSE stream and reads usage.speed', async () => {
    const log = makeLogger();
    const ctx = observerCtx({
      responseHeaders: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
    });
    const sink = createClaudeFastModeResponseObserver(log)(ctx);
    sink!.onData?.(gzipSync(Buffer.from(`${messageStartFrame('fast')}\n\n`)));
    sink!.onEnd?.();
    // 解压是流式异步的(zlib 回调走 libuv 线程池)。原先用 setImmediate 轮询:它只
    // 推进 tick、几乎不消耗真实时间,200 个 tick 不到 1ms 就烧完。而 vitest 的
    // threads 池下多个测试文件共享同一个进程、也就共享同一个默认 4 线程的 libuv
    // 线程池,回调的墙钟延迟被拉长,tick 预算根本等不到(CI 实测 debug 被调用 0 次)。
    // 改用 vi.waitFor 按墙钟等,并且等的就是断言本身成立。
    await vi.waitFor(() =>
      expect(log.debug).toHaveBeenCalledWith(
        'claude fast mode applied (usage.speed observed)',
        expect.objectContaining({ contentEncoding: 'gzip', responseSpeed: 'fast', appliedFast: true }),
      ),
    );
  });
});
